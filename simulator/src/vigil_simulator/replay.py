"""Replays a labeled dataset into the scoring API, delivering labels late.

Transactions are scored in time order (feature history depends on order).
Each fraud label is posted to /v1/transactions/{id}/label once the simulated
clock passes its `reported_at`, the way chargebacks trickle in after the fact.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(order=True)
class Event:
    at: str  # ISO-8601 UTC; lexicographic order == time order for this fixed format
    kind_rank: int  # scores before labels at the same instant
    kind: str = field(compare=False)  # "score" | "label"
    row: dict[str, Any] = field(compare=False)


def build_timeline(rows: list[dict[str, Any]], flush_labels: bool = False) -> list[Event]:
    """Score events in order, interleaved with label events at their report time.

    Labels reported after the last scored transaction are dropped unless
    `flush_labels`, in which case they are delivered at the end.
    """
    events = [Event(r["transaction"]["occurred_at"], 0, "score", r) for r in rows]
    if not rows:
        return events
    last = events[-1].at
    for r in rows:
        reported = r["label"].get("reported_at")
        if reported and (reported <= last or flush_labels):
            events.append(Event(reported, 1, "label", r))
    return sorted(events)


def label_body(row: dict[str, Any]) -> dict[str, Any]:
    lab = row["label"]
    body: dict[str, Any] = {
        "label": "fraud" if lab["is_fraud"] else "legit",
        "reported_at": lab["reported_at"],
    }
    if lab.get("report_source"):
        body["source"] = lab["report_source"]
    if lab["is_fraud"] and lab.get("pattern") not in (None, "none"):
        body["fraud_pattern"] = lab["pattern"]
    return body


class Api:
    def __init__(self, base_url: str, api_key: str, timeout: float = 30.0):
        self.base = base_url.rstrip("/")
        self.headers = {"x-api-key": api_key, "content-type": "application/json"}
        self.timeout = timeout

    def post(self, path: str, body: dict[str, Any]) -> tuple[int, Any]:
        req = urllib.request.Request(
            self.base + path, data=json.dumps(body).encode(), headers=self.headers, method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                raw = res.read()
                return res.status, json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"null")


@dataclass
class ReplayStats:
    scored: int = 0
    labels_sent: int = 0
    errors: Counter = field(default_factory=Counter)
    decisions: Counter = field(default_factory=Counter)
    rtt_ms: list[float] = field(default_factory=list)


def replay(
    rows: list[dict[str, Any]],
    api: Api,
    out: Path | None = None,
    tps: float | None = None,
    flush_labels: bool = False,
) -> ReplayStats:
    stats = ReplayStats()
    interval = 1.0 / tps if tps else 0.0
    sink = out.open("w") if out else None
    try:
        for event in build_timeline(rows, flush_labels):
            txn, label = event.row["transaction"], event.row["label"]
            if event.kind == "label":
                status, _ = api.post(f"/v1/transactions/{txn['transaction_id']}/label", label_body(event.row))
                if status == 204:
                    stats.labels_sent += 1
                else:
                    stats.errors[f"label {status}"] += 1
                continue

            started = time.perf_counter()
            status, res = api.post("/v1/transactions/score", txn)
            rtt = (time.perf_counter() - started) * 1000
            if status != 200:
                stats.errors[f"score {status}"] += 1
                continue
            stats.scored += 1
            stats.rtt_ms.append(rtt)
            stats.decisions[("fraud" if label["is_fraud"] else "legit", res["decision"])] += 1
            if sink:
                sink.write(json.dumps({
                    "transaction_id": txn["transaction_id"],
                    "scenario": label["scenario"],
                    "is_fraud": label["is_fraud"],
                    "decision": res["decision"],
                    "fraud_probability": res["fraud_probability"],
                    "pattern": res["pattern"],
                    "risk_level": res["risk_level"],
                    "reason_codes": [r["code"] for r in res["reasons"]],
                    "strategy": res["strategy"],
                    "server_ms": res["latency_ms"],
                    "rtt_ms": round(rtt, 2),
                }) + "\n")
            if interval:
                time.sleep(max(0.0, interval - rtt / 1000))
    finally:
        if sink:
            sink.close()
    return stats


def summarize(stats: ReplayStats) -> str:
    rtt = sorted(stats.rtt_ms) or [0.0]
    lines = [
        f"scored {stats.scored:,}  labels sent {stats.labels_sent:,}  errors {dict(stats.errors) or 0}",
        f"round trip p50={rtt[len(rtt) // 2]:.1f}ms p99={rtt[int(len(rtt) * 0.99)]:.1f}ms",
    ]
    for kind in ("legit", "fraud"):
        n = sum(v for (k, _), v in stats.decisions.items() if k == kind)
        mix = {d: stats.decisions[(kind, d)] for d in ("allow", "step_up_3ds", "review", "block")}
        lines.append(f"{kind:<5} {n:>6,}  {mix}")
    return "\n".join(lines)
