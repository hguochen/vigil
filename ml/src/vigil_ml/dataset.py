"""Turns a simulator dataset into a feature matrix with point-in-time labels."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

from .features import FEATURE_NAMES, stream_features


@dataclass
class Dataset:
    transactions: list[dict]
    occurred_at: np.ndarray  # datetime64[ms, UTC-naive]
    is_fraud: np.ndarray  # ground truth (bool)
    reported_at: np.ndarray  # datetime64[ms]; NaT when never reported
    scenario: np.ndarray  # str

    def __len__(self) -> int:
        return len(self.transactions)


def _ts(values) -> np.ndarray:
    return np.array(
        [np.datetime64(v.replace(tzinfo=None), "ms") if v else np.datetime64("NaT", "ms") for v in values],
        dtype="datetime64[ms]",
    )


def load_dataset(path: Path) -> Dataset:
    """Loads `vigil-sim generate` output (Parquet or JSONL), ordered by time."""
    if path.suffix == ".jsonl":
        rows = [json.loads(line) for line in path.read_text().splitlines() if line]
        txns = [r["transaction"] for r in rows]
        labels = [r["label"] for r in rows]

        def parse(s):
            return datetime.fromisoformat(s) if s else None

        reported = [parse(lab["reported_at"]) for lab in labels]
        is_fraud = [lab["is_fraud"] for lab in labels]
        scenario = [lab["scenario"] for lab in labels]
    else:
        table = pq.read_table(path).to_pydict()
        txns = [json.loads(p) for p in table["payload"]]
        reported = table["reported_at"]
        is_fraud, scenario = table["is_fraud"], table["scenario"]

    # Event time always comes from the API payload, the single source of truth.
    occurred = [datetime.fromisoformat(t["occurred_at"]) for t in txns]
    ds = Dataset(txns, _ts(occurred), np.array(is_fraud, dtype=bool), _ts(reported), np.array(scenario))
    order = np.argsort(ds.occurred_at, kind="stable")
    if not np.array_equal(order, np.arange(len(ds))):
        raise ValueError(f"{path} is not in time order")
    return ds


def feature_matrix(ds: Dataset) -> np.ndarray:
    """Extract-then-record over the whole stream; nulls become NaN (XGBoost's missing value)."""
    rows = [[np.nan if f[n] is None else f[n] for n in FEATURE_NAMES] for f in stream_features(ds.transactions)]
    return np.asarray(rows, dtype=np.float32)


def labels_as_of(ds: Dataset, cutoff: np.datetime64) -> np.ndarray:
    """What the merchant knows at `cutoff`: fraud counts only once it has been reported."""
    reported = ~np.isnat(ds.reported_at) & (ds.reported_at <= cutoff)
    return (ds.is_fraud & reported).astype(np.int32)


@dataclass(frozen=True)
class Split:
    train: np.ndarray
    valid: np.ndarray  # calibration: early stopping and decision cutoffs
    test: np.ndarray
    labels_as_of: np.datetime64  # "now": labels for train/valid are what is known at this point


def time_split(
    ds: Dataset, test_frac: float = 0.2, maturity_days: float = 21, valid_days: float = 10
) -> Split:
    """Chronological split with a label-maturity gap. No shuffling.

        [ train ][ valid ][ ---- maturity gap ---- ] now [ test ]

    Fraud is reported days to weeks after it happens, so the most recent
    `maturity_days` before "now" still look mostly legitimate. Fitting or
    calibrating on them would teach the model, and the cutoffs, that recent
    fraud is fine. They are left out of training; the test window follows "now".
    """
    start, end = ds.occurred_at[0], ds.occurred_at[-1]
    now = start + (end - start) * (1 - test_frac)
    valid_end = now - np.timedelta64(int(maturity_days * 86_400_000), "ms")
    valid_start = valid_end - np.timedelta64(int(valid_days * 86_400_000), "ms")
    if valid_start <= start:
        raise ValueError(
            f"dataset too short: {(end - start) / np.timedelta64(1, 'D'):.0f} days leaves no training window "
            f"before {valid_days} calibration + {maturity_days} maturity days (use a longer dataset)"
        )
    t = ds.occurred_at
    idx = np.arange(len(ds))
    return Split(
        train=idx[t < valid_start],
        valid=idx[(t >= valid_start) & (t < valid_end)],
        test=idx[t >= now],
        labels_as_of=now,
    )
