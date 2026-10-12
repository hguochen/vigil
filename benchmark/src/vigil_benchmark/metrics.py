"""Weighted benchmark metrics over `npm run bench` results.

Rows carry a `weight` (legit rows are sampled), so every rate here is a
weighted estimate of the rate on the full dataset.
"""

from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

DECISIONS = ["allow", "step_up_3ds", "review", "block"]
# Fraud is ~2% of traffic, so budgets below that cap recall; these leave room to differ.
ALERT_BUDGETS = [0.02, 0.03, 0.05]


@dataclass
class Row:
    transaction_id: str
    strategy: str
    scenario: str
    is_fraud: bool
    true_pattern: str
    weight: float
    decision: str
    score: float
    pattern: str | None
    risk_level: str | None
    reasons: list[dict[str, str]]
    tier: str
    jev_latency_ms: float | None
    jev_input_tokens: int | None

    @property
    def flagged(self) -> bool:
        return self.decision in ("review", "block")


def load(results_dir: Path) -> tuple[list[Row], dict[str, Any]]:
    rows = []
    fields = Row.__dataclass_fields__
    for line in (results_dir / "results.jsonl").read_text().splitlines():
        if line:
            d = json.loads(line)
            rows.append(Row(**{k: d.get(k) for k in fields}))
    meta = json.loads((results_dir / "meta.json").read_text())
    return rows, meta


def _share(rows: list[Row], pred) -> float:
    total = sum(r.weight for r in rows)
    return sum(r.weight for r in rows if pred(r)) / total if total else 0.0


def recall_at_alert_rate(rows: list[Row], budget: float) -> float:
    """Weighted recall when flagging the highest-scored `budget` share of traffic.

    Equal scores are flagged together or not at all, so no strategy gets to
    break ties in its favour.
    """
    total = sum(r.weight for r in rows)
    fraud_total = sum(r.weight for r in rows if r.is_fraud)
    groups: dict[float, list[Row]] = defaultdict(list)
    for r in rows:
        groups[r.score].append(r)
    flagged_w = caught = 0.0
    for score in sorted(groups, reverse=True):
        g = groups[score]
        w = sum(r.weight for r in g)
        if flagged_w + w > budget * total:
            break
        flagged_w += w
        caught += sum(r.weight for r in g if r.is_fraud)
    return caught / fraud_total if fraud_total else 0.0


def percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    s = sorted(values)
    return s[min(len(s) - 1, int(q * len(s)))]


def strategy_metrics(rows: list[Row]) -> dict[str, Any]:
    fraud = [r for r in rows if r.is_fraud]
    legit = [r for r in rows if not r.is_fraud]
    total_w = sum(r.weight for r in rows)

    def precision(pred) -> float | None:
        hit = [r for r in rows if pred(r)]
        w = sum(r.weight for r in hit)
        return sum(r.weight for r in hit if r.is_fraud) / w if w else None

    scenarios = sorted({r.scenario for r in fraud})
    by_scenario = {}
    for s in scenarios:
        rs = [r for r in fraud if r.scenario == s]
        caught = [r for r in rs if r.flagged]
        with_pattern = [r for r in caught if r.pattern is not None]
        by_scenario[s] = {
            "n": len(rs),
            "flagged": _share(rs, lambda r: r.flagged),
            "blocked": _share(rs, lambda r: r.decision == "block"),
            "any_intervention": _share(rs, lambda r: r.decision != "allow"),
            "pattern_accuracy": (
                sum(r.pattern == r.true_pattern for r in with_pattern) / len(with_pattern) if with_pattern else None
            ),
        }

    jev_rows = [r for r in rows if r.jev_latency_ms is not None]
    return {
        "decision_mix": {
            "legit": {d: _share(legit, lambda r, d=d: r.decision == d) for d in DECISIONS},
            "fraud": {d: _share(fraud, lambda r, d=d: r.decision == d) for d in DECISIONS},
        },
        "legit_friction": _share(legit, lambda r: r.decision != "allow"),
        "flagged_recall": _share(fraud, lambda r: r.flagged),
        "flagged_precision": precision(lambda r: r.flagged),
        "blocked_recall": _share(fraud, lambda r: r.decision == "block"),
        "blocked_precision": precision(lambda r: r.decision == "block"),
        "alert_rate": _share(rows, lambda r: r.flagged),
        "recall_at_alert_rate": {f"{b:.1%}": recall_at_alert_rate(rows, b) for b in ALERT_BUDGETS},
        # Best achievable recall per budget (flag only fraud): budget / fraud share, capped at 1.
        "max_recall_at_alert_rate": {
            f"{b:.1%}": min(1.0, b / (sum(r.weight for r in fraud) / total_w)) if fraud else None
            for b in ALERT_BUDGETS
        },
        "by_scenario": by_scenario,
        "jev": {
            "calls_per_1k_txns": (sum(r.weight for r in jev_rows) / total_w * 1000) if total_w else 0,
            "latency_ms": {q: percentile([r.jev_latency_ms for r in jev_rows], p)
                           for q, p in (("p50", 0.5), ("p95", 0.95), ("p99", 0.99))},
            "mean_input_tokens": (
                sum(r.jev_input_tokens or 0 for r in jev_rows) / len(jev_rows) if jev_rows else None
            ),
            "fallbacks": sum(1 for r in rows if r.tier == "fallback"),
            "hard_rule_skips": sum(1 for r in rows if r.tier == "rules_hard"),
        } if any(r.strategy.startswith("jev") for r in rows) else None,
    }


def compute(rows: list[Row]) -> dict[str, dict[str, Any]]:
    by_strategy: dict[str, list[Row]] = defaultdict(list)
    for r in rows:
        by_strategy[r.strategy].append(r)
    return {s: strategy_metrics(rs) for s, rs in by_strategy.items()}


def explanation_samples(rows: list[Row]) -> list[dict[str, Any]]:
    """One fraud transaction per scenario, with every strategy's decision and reasons."""
    by_txn: dict[str, dict[str, Row]] = defaultdict(dict)
    for r in rows:
        by_txn[r.transaction_id][r.strategy] = r
    picked: dict[str, dict[str, Any]] = {}
    for tid in sorted(by_txn):
        per = by_txn[tid]
        first = next(iter(per.values()))
        if not first.is_fraud or first.scenario in picked:
            continue
        picked[first.scenario] = {
            "transaction_id": tid,
            "scenario": first.scenario,
            "strategies": {
                s: {"decision": r.decision, "score": r.score, "pattern": r.pattern, "reasons": r.reasons}
                for s, r in per.items()
            },
        }
    return [picked[s] for s in sorted(picked)]
