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
    valid: np.ndarray
    test: np.ndarray
    train_end: np.datetime64


def time_split(ds: Dataset, train_frac: float = 0.6, valid_frac: float = 0.15) -> Split:
    """Chronological split: train | valid (early stopping) | test. No shuffling."""
    start, end = ds.occurred_at[0], ds.occurred_at[-1]
    span = end - start
    train_end = start + span * train_frac
    valid_end = start + span * (train_frac + valid_frac)
    idx = np.arange(len(ds))
    return Split(
        train=idx[ds.occurred_at < train_end],
        valid=idx[(ds.occurred_at >= train_end) & (ds.occurred_at < valid_end)],
        test=idx[ds.occurred_at >= valid_end],
        train_end=valid_end,  # labels for train+valid are known as of the end of validation
    )
