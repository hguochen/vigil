import json
from datetime import UTC, datetime

import numpy as np
import pytest
from vigil_ml.features import FEATURE_NAMES
from vigil_ml.train import TrainConfig, cutoff_for_rate, recall_at_fpr, train
from vigil_simulator.generate import GenerateConfig, generate, write_jsonl


def test_cutoff_for_rate_respects_the_budget():
    p = np.linspace(0, 1, 1000, dtype=np.float32)
    t = cutoff_for_rate(p, 0.02)
    assert (p >= t).mean() <= 0.02
    assert (p >= np.nextafter(t, np.float32(-1))).mean() > 0.02 - 1e-9  # tight


def test_recall_at_fpr_keeps_ties_together():
    y = np.array([0, 0, 1, 1])
    p = np.array([0.5, 0.1, 0.5, 0.9])
    assert recall_at_fpr(y, p, 0.4) == (0.5, 0.9)  # 0.5 tie would add a false positive


@pytest.fixture(scope="module")
def trained(tmp_path_factory):
    d = tmp_path_factory.mktemp("train")
    cfg = GenerateConfig(seed=5, customers=600, days=60, fraud_rate=0.04,
                         start=datetime(2026, 7, 1, tzinfo=UTC))
    write_jsonl(generate(cfg), d / "sim.jsonl")
    schema = train(d / "sim.jsonl", d / "model",
                   TrainConfig(max_estimators=200, maturity_days=10, valid_days=7))
    return d / "model", schema


def test_exports_a_model_the_service_can_load(trained):
    out, _ = trained
    assert (out / "model.onnx").stat().st_size > 1_000
    on_disk = json.loads((out / "feature_schema.json").read_text())
    assert on_disk["feature_names"] == FEATURE_NAMES
    assert on_disk["input_name"] == "input"
    assert set(on_disk["alert_rates"]) == {"step_up_3ds", "review", "block"}
    t = on_disk["decision_thresholds"]
    assert t["step_up_3ds"] <= t["review"] <= t["block"]
    assert on_disk["onnx_parity_max_abs_diff"] < 1e-5


def test_learns_something_useful(trained):
    _, schema = trained
    m = schema["test_metrics"]
    assert m["roc_auc"] > 0.9
    assert m["decision_mix"]["flagged_precision"] > 0.5


def test_parity_file_matches_rows(trained):
    out, _ = trained
    parity = json.loads((out / "parity.json").read_text())
    assert len(parity["rows"]) == len(parity["probabilities"]) > 0
    assert all(len(r) == len(FEATURE_NAMES) for r in parity["rows"])
