"""Trains the XGBoost baseline and exports it to ONNX for the scoring service.

    uv run vigil-train --data data/sim/tune.jsonl --out models/xgb
"""

from __future__ import annotations

import argparse
import hashlib
import json
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import onnxruntime as ort
import yaml
from onnxmltools import convert_xgboost
from onnxmltools.convert.common.data_types import FloatTensorType
from sklearn.metrics import average_precision_score, roc_auc_score
from vigil_simulator.geo import CONTRACTS_DIR
from xgboost import XGBClassifier

from .dataset import Dataset, feature_matrix, labels_as_of, load_dataset, time_split
from .features import FEATURE_NAMES

DEFAULT_POLICY = CONTRACTS_DIR.parent / "scoring-service" / "config" / "policy.yaml"
ACTIONS = ("step_up_3ds", "review", "block")

INPUT_NAME = "input"
PARITY_ROWS = 200
PARITY_TOLERANCE = 1e-5


@dataclass(frozen=True)
class TrainConfig:
    seed: int = 7
    label_mode: str = "reported"  # "reported" (what the merchant knows) | "truth"
    max_estimators: int = 800
    learning_rate: float = 0.05
    max_depth: int = 5
    early_stopping_rounds: int = 100
    test_frac: float = 0.2
    maturity_days: float = 21
    valid_days: float = 10


def recall_at_fpr(y: np.ndarray, p: np.ndarray, max_fpr: float) -> tuple[float, float]:
    """Best recall with FPR <= max_fpr; returns (recall, threshold). Ties stay together."""
    order = np.argsort(-p, kind="stable")
    p_sorted, y_sorted = p[order], y[order]
    n_pos, n_neg = max(y.sum(), 1), max((1 - y).sum(), 1)
    best = (0.0, float("inf"))
    tp = fp = 0
    i = 0
    while i < len(p_sorted):
        j = i
        while j < len(p_sorted) and p_sorted[j] == p_sorted[i]:
            j += 1
        tp += int(y_sorted[i:j].sum())
        fp += int((1 - y_sorted[i:j]).sum())
        if fp / n_neg > max_fpr:
            break
        best = (tp / n_pos, float(p_sorted[i]))
        i = j
    return best


def load_alert_rates(policy_path: Path) -> dict[str, float]:
    rates = yaml.safe_load(policy_path.read_text())["xgboost"]["alert_rates"]
    return {a: float(rates[a]) for a in ACTIONS}


def cutoff_for_rate(p: np.ndarray, rate: float) -> float:
    """Lowest cutoff such that the share of scores at or above it stays within `rate`."""
    s = np.sort(p.astype(np.float32))[::-1]
    allowed = int(np.floor(rate * len(s)))
    if allowed >= len(s):
        return float(s[-1])
    return float(np.nextafter(s[allowed], np.float32(np.inf)))


def decision_thresholds(p_calib: np.ndarray, rates: dict[str, float]) -> dict[str, float]:
    """Cutoffs from all calibration-window scores: no labels needed, so label noise cannot bias them."""
    return {a: cutoff_for_rate(p_calib, rates[a]) for a in ACTIONS}


def decision_mix(ds: Dataset, idx: np.ndarray, p: np.ndarray, t: dict[str, float]) -> dict:
    y = ds.is_fraud[idx]
    level = np.select([p >= t["block"], p >= t["review"], p >= t["step_up_3ds"]], [3, 2, 1], 0)
    names = ["allow", "step_up_3ds", "review", "block"]
    mix = {
        kind: {names[k]: float((level[mask] == k).mean()) for k in range(4)}
        for kind, mask in (("legit", ~y), ("fraud", y))
    }
    flagged = level >= 2
    mix["alert_rate"] = {names[k]: float((level >= k).mean()) for k in (1, 2, 3)}
    mix["flagged_recall"] = float(flagged[y].mean())
    mix["flagged_precision"] = float(y[flagged].mean()) if flagged.any() else 0.0
    return mix


def evaluate(ds: Dataset, idx: np.ndarray, p: np.ndarray) -> dict:
    """Metrics against the ground truth (not the delayed labels used for training)."""
    y = ds.is_fraud[idx].astype(int)
    out = {
        "n": len(idx),
        "fraud": int(y.sum()),
        "pr_auc": float(average_precision_score(y, p)),
        "roc_auc": float(roc_auc_score(y, p)),
    }
    for fpr in (0.005, 0.01, 0.02):
        recall, threshold = recall_at_fpr(y, p, fpr)
        out[f"recall_at_{fpr:.1%}_fpr"] = {"recall": recall, "threshold": threshold}
    _, t1 = recall_at_fpr(y, p, 0.01)
    scen = ds.scenario[idx]
    out["recall_by_scenario_at_1%_fpr"] = {
        str(s): float((p[scen == s] >= t1).mean()) for s in sorted(set(scen[y == 1]))
    }
    return out


def fit(X_tr, y_tr, X_va, y_va, cfg: TrainConfig) -> tuple[XGBClassifier, int]:
    params = {
        "learning_rate": cfg.learning_rate,
        "max_depth": cfg.max_depth,
        "min_child_weight": 2,
        "subsample": 0.8,
        "colsample_bytree": 0.8,
        "tree_method": "hist",
        "eval_metric": "logloss",  # smoother than aucpr under noisy (unreported) labels
        "random_state": cfg.seed,
        "n_jobs": 4,
    }
    probe = XGBClassifier(n_estimators=cfg.max_estimators, early_stopping_rounds=cfg.early_stopping_rounds, **params)
    probe.fit(X_tr, y_tr, eval_set=[(X_va, y_va)], verbose=False)
    n_trees = probe.best_iteration + 1
    # Refit with exactly the best number of trees: an ONNX export contains every
    # tree, while XGBoost would silently predict with only best_iteration.
    final = XGBClassifier(n_estimators=n_trees, **{k: v for k, v in params.items() if k != "eval_metric"})
    final.fit(X_tr, y_tr)
    return final, n_trees


def export_onnx(model: XGBClassifier, X_check: np.ndarray, out: Path) -> tuple[str, float]:
    onx = convert_xgboost(
        model,
        initial_types=[(INPUT_NAME, FloatTensorType([None, len(FEATURE_NAMES)]))],
        target_opset=15,  # highest this onnxmltools supports
    )
    out.mkdir(parents=True, exist_ok=True)
    (out / "model.onnx").write_bytes(onx.SerializeToString())

    session = ort.InferenceSession(str(out / "model.onnx"))
    prob_output = next(o.name for o in session.get_outputs() if o.type == "tensor(float)")
    onnx_p = session.run([prob_output], {INPUT_NAME: X_check})[0][:, 1]
    xgb_p = model.predict_proba(X_check)[:, 1]
    max_diff = float(np.abs(onnx_p - xgb_p).max())
    if max_diff > PARITY_TOLERANCE:
        (out / "model.onnx").unlink()
        raise RuntimeError(f"ONNX export disagrees with XGBoost (max diff {max_diff:.2e}); not exported")
    return prob_output, max_diff


def train(data: Path, out: Path, cfg: TrainConfig, policy_path: Path = DEFAULT_POLICY) -> dict:
    started = time.perf_counter()
    rates = load_alert_rates(policy_path)
    ds = load_dataset(data)
    X = feature_matrix(ds)
    split = time_split(ds, cfg.test_frac, cfg.maturity_days, cfg.valid_days)
    y = ds.is_fraud.astype(np.int32) if cfg.label_mode == "truth" else labels_as_of(ds, split.labels_as_of)

    model, n_trees = fit(X[split.train], y[split.train], X[split.valid], y[split.valid], cfg)
    p_valid = model.predict_proba(X[split.valid])[:, 1]
    thresholds = decision_thresholds(p_valid, rates)
    p_test = model.predict_proba(X[split.test])[:, 1]
    metrics = evaluate(ds, split.test, p_test)
    metrics["decision_mix"] = decision_mix(ds, split.test, p_test, thresholds)

    X_check = X[split.test][:PARITY_ROWS]
    prob_output, max_diff = export_onnx(model, X_check, out)
    digest = hashlib.sha256((out / "model.onnx").read_bytes()).hexdigest()[:8]
    version = f"xgb-{datetime.now(UTC):%Y%m%d}-{digest}"

    schema = {
        "model_version": version,
        "feature_names": FEATURE_NAMES,
        "input_name": INPUT_NAME,
        "probability_output": prob_output,
        "positive_class_index": 1,
        "alert_rates": rates,
        "decision_thresholds": thresholds,
        "trained_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "training": {
            "data": str(data),
            "label_mode": cfg.label_mode,
            "labels_known_as_of": str(split.labels_as_of),
            "n_train": len(split.train),
            "n_valid": len(split.valid),
            "positives_train": int(y[split.train].sum()),
            "trees": n_trees,
            "params": {k: v for k, v in vars(cfg).items()},
        },
        "test_metrics": metrics,
        "onnx_parity_max_abs_diff": max_diff,
    }
    (out / "feature_schema.json").write_text(json.dumps(schema, indent=2) + "\n")
    # Rows + expected probabilities for the TypeScript runtime parity test.
    parity = {
        "rows": [[None if np.isnan(v) else float(v) for v in row] for row in X_check],
        "probabilities": [float(v) for v in model.predict_proba(X_check)[:, 1]],
    }
    (out / "parity.json").write_text(json.dumps(parity) + "\n")
    schema["seconds"] = round(time.perf_counter() - started, 1)
    return schema


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="vigil-train", description="Train the XGBoost baseline")
    parser.add_argument("--data", type=Path, default=Path("data/sim/train.jsonl"))
    parser.add_argument("--out", type=Path, default=Path("models/xgb"))
    parser.add_argument("--labels", choices=["reported", "truth"], default="reported")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--policy", type=Path, default=DEFAULT_POLICY)
    args = parser.parse_args(argv)

    s = train(args.data, args.out, TrainConfig(seed=args.seed, label_mode=args.labels), args.policy)
    m, t = s["test_metrics"], s["training"]
    print(f"model {s['model_version']}  ({t['trees']} trees, labels={t['label_mode']}, "
          f"{t['positives_train']} known-fraud rows in train)  [{s['seconds']}s]")
    print(f"test (true labels): n={m['n']:,} fraud={m['fraud']}  PR-AUC={m['pr_auc']:.3f}  ROC-AUC={m['roc_auc']:.3f}")
    for k in ("recall_at_0.5%_fpr", "recall_at_1.0%_fpr", "recall_at_2.0%_fpr"):
        print(f"  {k:<20} {m[k]['recall']:.1%}  (p >= {m[k]['threshold']:.3f})")
    print("  recall by scenario @1% FPR:", {k: f"{v:.0%}" for k, v in m["recall_by_scenario_at_1%_fpr"].items()})
    th, mix = s["decision_thresholds"], m["decision_mix"]
    print("cutoffs from calibration for alert rates", s["alert_rates"], "->", {k: f"{v:.5f}" for k, v in th.items()})
    print("  test alert rate (all orders at or above):", {k: f"{v:.2%}" for k, v in mix["alert_rate"].items()})
    for kind in ("legit", "fraud"):
        print(f"  test {kind:<5} " + "  ".join(f"{k} {v:.1%}" for k, v in mix[kind].items()))
    print(f"  flagged (review+block): recall {mix['flagged_recall']:.1%}  precision {mix['flagged_precision']:.1%}")
    print(f"ONNX parity max |diff| = {s['onnx_parity_max_abs_diff']:.1e}  -> wrote {args.out}")


if __name__ == "__main__":
    main()
