from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pytest
from vigil_ml.dataset import feature_matrix, labels_as_of, load_dataset, time_split
from vigil_ml.features import FEATURE_NAMES
from vigil_simulator.generate import GenerateConfig, generate, write_jsonl, write_parquet

CONFIG = GenerateConfig(seed=4, customers=300, days=20, fraud_rate=0.05,
                        start=datetime(2026, 8, 1, tzinfo=UTC))


@pytest.fixture(scope="module")
def paths(tmp_path_factory):
    d: Path = tmp_path_factory.mktemp("ds")
    records = generate(CONFIG)
    write_parquet(records, d / "sim.parquet", CONFIG)
    write_jsonl(records, d / "sim.jsonl")
    return d / "sim.parquet", d / "sim.jsonl"


def test_parquet_and_jsonl_load_identically(paths):
    a, b = (load_dataset(p) for p in paths)
    assert a.transactions == b.transactions
    assert np.array_equal(a.is_fraud, b.is_fraud)
    assert np.array_equal(a.occurred_at, b.occurred_at)
    known = ~np.isnat(a.reported_at)
    assert np.array_equal(known, ~np.isnat(b.reported_at))
    assert np.array_equal(a.reported_at[known], b.reported_at[known])


def test_feature_matrix_shape_and_missing_values(paths):
    ds = load_dataset(paths[0])
    X = feature_matrix(ds)
    assert X.shape == (len(ds), len(FEATURE_NAMES)) and X.dtype == np.float32
    col = FEATURE_NAMES.index("amount_vs_customer_avg")
    assert np.isnan(X[:, col]).any()  # first purchases have no average
    assert not np.isnan(X[:, FEATURE_NAMES.index("amount_usd")]).any()


def test_labels_only_count_reported_fraud(paths):
    ds = load_dataset(paths[0])
    end = ds.occurred_at[-1]
    known_now = labels_as_of(ds, end)
    known_later = labels_as_of(ds, end + np.timedelta64(365, "D"))
    assert known_now.sum() < known_later.sum() <= ds.is_fraud.sum()
    assert not (known_later & ~ds.is_fraud).any()  # never labels legit as fraud


def test_time_split_leaves_a_label_maturity_gap(paths):
    ds = load_dataset(paths[0])  # 20 days
    s = time_split(ds, test_frac=0.2, maturity_days=5, valid_days=3)
    t = ds.occurred_at
    assert t[s.train].max() < t[s.valid].min()
    gap = (t[s.test].min() - t[s.valid].max()) / np.timedelta64(1, "D")
    assert gap >= 5  # nothing from the immature window is used for fitting
    assert t[s.valid].max() < s.labels_as_of <= t[s.test].min()
    assert len(s.train) + len(s.valid) + len(s.test) < len(ds)  # the gap is excluded


def test_time_split_rejects_a_too_short_dataset(paths):
    ds = load_dataset(paths[0])
    with pytest.raises(ValueError, match="too short"):
        time_split(ds, maturity_days=21, valid_days=10)
