import json

import pytest
from vigil_benchmark.metrics import Row, compute, explanation_samples, recall_at_alert_rate
from vigil_benchmark.report import main


def row(tid, strategy, fraud, score, decision="allow", weight=1.0, scenario=None, pattern=None, true_pattern=None,
        latency=None, tier=None):
    return Row(
        transaction_id=tid, strategy=strategy, scenario=scenario or ("stolen_card" if fraud else "legit"),
        is_fraud=fraud, true_pattern=true_pattern or ("stolen_card" if fraud else "none"), weight=weight,
        decision=decision, score=score, pattern=pattern, risk_level=None,
        reasons=[{"code": "X", "message": "x"}], tier=tier or strategy, jev_latency_ms=latency,
        jev_input_tokens=1600 if latency else None,
    )


def test_weights_scale_legit_rows():
    rows = [row("f1", "rules", True, 0.9, "review"),
            row("l1", "rules", False, 0.1, "allow", weight=99),
            row("l2", "rules", False, 0.8, "review", weight=99)]
    m = compute(rows)["rules"]
    assert m["flagged_recall"] == 1.0
    assert m["flagged_precision"] == pytest.approx(1 / 100)  # 1 fraud vs 99 weighted legit flagged
    assert m["legit_friction"] == pytest.approx(0.5)


def test_recall_at_alert_rate_respects_budget_and_ties():
    rows = [row(f"l{i}", "s", False, 0.0) for i in range(96)]
    rows += [row("f1", "s", True, 0.9), row("f2", "s", True, 0.5), row("l96", "s", False, 0.5), row("f3", "s", True, 0.1)]
    # 100 rows: a 1% budget flags 1 row -> f1 only; 2% cannot include the 0.5 tie (2 rows) -> still f1; 3% does.
    assert recall_at_alert_rate(rows, 0.01) == pytest.approx(1 / 3)
    assert recall_at_alert_rate(rows, 0.02) == pytest.approx(1 / 3)
    assert recall_at_alert_rate(rows, 0.03) == pytest.approx(2 / 3)


def test_pattern_accuracy_only_counts_strategies_that_predict_patterns():
    rows = [row("f1", "jev", True, 0.9, "block", pattern="stolen_card"),
            row("f2", "jev", True, 0.9, "review", pattern="card_testing"),
            row("f1", "xgboost", True, 0.9, "block"),
            row("f2", "xgboost", True, 0.9, "block")]
    m = compute(rows)
    assert m["jev"]["by_scenario"]["stolen_card"]["pattern_accuracy"] == 0.5
    assert m["xgboost"]["by_scenario"]["stolen_card"]["pattern_accuracy"] is None


def test_jev_operations():
    rows = [row("f1", "jev_rules", True, 1.0, "block", tier="rules_hard"),
            row("l1", "jev_rules", False, 0.1, latency=100),
            row("l2", "jev_rules", False, 0.1, latency=300, tier="fallback")]
    j = compute(rows)["jev_rules"]["jev"]
    assert j["hard_rule_skips"] == 1 and j["fallbacks"] == 1
    assert j["calls_per_1k_txns"] == pytest.approx(2 / 3 * 1000)
    assert j["latency_ms"]["p50"] == 300


def test_explanation_samples_one_per_scenario():
    rows = [row("f1", "rules", True, 0.9, "review"), row("f1", "jev", True, 0.9, "block"),
            row("f2", "rules", True, 0.9, "review"), row("l1", "rules", False, 0.1)]
    samples = explanation_samples(rows)
    assert len(samples) == 1 and set(samples[0]["strategies"]) == {"rules", "jev"}


def test_report_cli_writes_html_and_summary(tmp_path, capsys):
    rows = [row("f1", "rules", True, 0.9, "review"), row("l1", "rules", False, 0.1, weight=10),
            row("f1", "jev", True, 0.95, "block", pattern="stolen_card", latency=150),
            row("l1", "jev", False, 0.05, weight=10, latency=120)]
    (tmp_path / "results.jsonl").write_text("\n".join(json.dumps(r.__dict__) for r in rows) + "\n")
    (tmp_path / "meta.json").write_text(json.dumps({
        "dataset": "/x/holdout.jsonl", "dataset_rows": 11, "sample_rows": 2, "sample_fraud": 1,
        "limit": None, "legit_sample": 10, "jev_model_requested": "jev-latest", "question_set_version": "v",
        "xgb_model_version": None, "jev_errors": {}, "generated_at": "now",
    }))
    main(["--in", str(tmp_path), "--markdown", str(tmp_path / "results.md")])
    md = (tmp_path / "results.md").read_text()
    assert md.startswith("# Benchmark results") and "| Jev |" in md and "## Reproduce" in md
    page = (tmp_path / "report.html").read_text()
    assert "<title>Vigil Benchmark</title>" in page and "Jev operations" in page
    assert json.loads((tmp_path / "summary.json").read_text())["metrics"]["jev"]["flagged_recall"] == 1.0
    assert "Rules" in capsys.readouterr().out
