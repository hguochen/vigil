"""Builds a labeled, time-ordered dataset and writes it to Parquet."""

from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from .normal import normal_traffic
from .scenarios import SCENARIOS
from .world import Record, World, build_world


@dataclass(frozen=True)
class GenerateConfig:
    seed: int
    customers: int
    days: int
    fraud_rate: float
    start: datetime


def inject_fraud(world: World, n_normal: int, fraud_rate: float) -> list[Record]:
    """Adds fraud episodes until fraud makes up ~fraud_rate of all transactions."""
    target = round(fraud_rate / (1 - fraud_rate) * n_normal)
    names = list(SCENARIOS)
    weights = [SCENARIOS[n][1] for n in names]
    total = sum(weights)
    probs = [w / total for w in weights]

    records: list[Record] = []
    n_fraud = 0
    while n_fraud < target:
        name = names[int(world.rng.choice(len(names), p=probs))]
        episode = [r for r in SCENARIOS[name][0](world, world.random_time()) if r.occurred_at < world.end]
        records.extend(episode)
        n_fraud += sum(r.label.is_fraud for r in episode)
    return records


def generate(config: GenerateConfig) -> list[Record]:
    world = build_world(config.seed, config.customers, config.start, config.days)
    normal = normal_traffic(world)
    records = normal + inject_fraud(world, len(normal), config.fraud_rate)
    records.sort(key=lambda r: r.occurred_at)
    for i, r in enumerate(records, start=1):
        r.transaction["transaction_id"] = f"txn_{i:08d}"
    return records


SCHEMA = pa.schema(
    [
        ("transaction_id", pa.string()),
        ("occurred_at", pa.timestamp("us", tz="UTC")),
        ("customer_id", pa.string()),
        ("card_token", pa.string()),
        ("device_id", pa.string()),
        ("ip", pa.string()),
        ("amount_minor", pa.int64()),
        ("payload", pa.string()),  # full API request body as JSON
        ("is_fraud", pa.bool_()),
        ("scenario", pa.string()),
        ("pattern", pa.string()),
        ("reported_at", pa.timestamp("us", tz="UTC")),
        ("report_source", pa.string()),
    ]
)


def write_parquet(records: list[Record], path: Path, config: GenerateConfig) -> None:
    t = [r.transaction for r in records]
    columns = {
        "transaction_id": [x["transaction_id"] for x in t],
        "occurred_at": [r.occurred_at for r in records],
        "customer_id": [x["customer"]["id"] for x in t],
        "card_token": [x["card"]["token"] for x in t],
        "device_id": [x["device"]["id"] for x in t],
        "ip": [x["device"]["ip"] for x in t],
        "amount_minor": [x["amount_minor"] for x in t],
        "payload": [json.dumps(x, separators=(",", ":")) for x in t],
        "is_fraud": [r.label.is_fraud for r in records],
        "scenario": [r.label.scenario for r in records],
        "pattern": [r.label.pattern for r in records],
        "reported_at": [r.label.reported_at for r in records],
        "report_source": [r.label.report_source for r in records],
    }
    meta = {
        "seed": config.seed,
        "customers": config.customers,
        "days": config.days,
        "fraud_rate": config.fraud_rate,
        "start": config.start.isoformat(),
    }
    table = pa.table(columns, schema=SCHEMA).replace_schema_metadata(
        {"vigil.generate": json.dumps(meta)}
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(table, path)


def summarize(records: list[Record]) -> str:
    fraud = [r for r in records if r.label.is_fraud]
    by_scenario = Counter(r.label.scenario for r in fraud)
    reported = sum(r.label.reported_at is not None for r in fraud)
    lines = [
        f"transactions: {len(records):,}",
        f"fraud:        {len(fraud):,} ({len(fraud) / len(records):.2%})",
        f"reported:     {reported:,} of fraud ({reported / max(len(fraud), 1):.0%})",
        "by scenario:",
        *(f"  {name:<18} {count:>6,}" for name, count in by_scenario.most_common()),
    ]
    return "\n".join(lines)
