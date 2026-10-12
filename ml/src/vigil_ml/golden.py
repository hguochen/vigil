"""Generates contracts/golden/features.json, the TypeScript/Python parity fixture.

Run after any intentional feature change:  uv run python -m vigil_ml.golden
"""

from __future__ import annotations

import copy
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from vigil_simulator.geo import CONTRACTS_DIR
from vigil_simulator.normal import normal_traffic
from vigil_simulator.scenarios import SCENARIOS
from vigil_simulator.world import build_world

from .features import stream_features

GOLDEN_PATH = CONTRACTS_DIR / "golden" / "features.json"
SPEC_VERSION = 1


def simulated_stream() -> list[dict[str, Any]]:
    """Dense traffic from a small world, plus one episode of every fraud scenario."""
    start = datetime(2026, 9, 1, tzinfo=UTC)
    world = build_world(seed=99, n_customers=40, start=start, days=3)
    records = normal_traffic(world)
    for i, (fn, _) in enumerate(SCENARIOS.values()):
        records.extend(fn(world, start + timedelta(hours=6 + 9 * i)))
    records.sort(key=lambda r: r.occurred_at)
    for i, r in enumerate(records, start=1):
        r.transaction["transaction_id"] = f"sim_{i:04d}"
    return [r.transaction for r in records]


BASE: dict[str, Any] = {
    "transaction_id": "",
    "occurred_at": "",
    "amount_minor": 5000,
    "currency": "USD",
    "channel": "web",
    "customer": {
        "id": "edge_cust",
        "email": "jane.doe@example.com",
        "name": "Jane Doe",
        "account_created_at": "2026-01-01T00:00:00Z",
    },
    "card": {"token": "edge_card", "bin": "411111", "last4": "1111", "country": "US"},
    "device": {"id": "edge_dev", "ip": "100.64.1.1", "user_agent": "Mozilla/5.0"},
    "billing_address": {"line1": "12 Oak Ave", "city": "Seattle", "postal_code": "98101",
                        "country": "US", "lat": 47.61, "lon": -122.33},
    "shipping_address": {"line1": "12 Oak Ave", "city": "Seattle", "postal_code": "98101",
                         "country": "US", "lat": 47.61, "lon": -122.33},
    "items": [{"sku": "BOO-0001", "category": "books", "quantity": 1, "unit_price_minor": 5000}],
}


def edge_case_stream() -> list[dict[str, Any]]:
    cases: list[tuple[str, dict[str, Any]]] = []

    def add(occurred_at: str, **changes: Any) -> None:
        txn = copy.deepcopy(BASE)
        for path, value in changes.items():
            target = txn
            *parents, leaf = path.split("__")
            for p in parents:
                target = target[p]
            if value is None:
                target.pop(leaf, None)
            else:
                target[leaf] = value
        txn["occurred_at"] = occurred_at
        txn["transaction_id"] = f"edge_{len(cases) + 1:02d}"
        cases.append((occurred_at, txn))

    add("2026-10-01T12:00:00Z")  # first purchase
    add("2026-10-01T12:00:00Z")  # same timestamp: excluded by [t - W, t)
    add("2026-10-01T12:30:00Z", device__ip="100.78.5.5", device__id="edge_dev_2")  # London 30 min later
    add("2026-10-02T12:00:00Z")  # exactly 24h after the first: inclusive lower bound
    add("2026-10-02T12:00:00.001Z", amount_minor=7_500)  # 1 ms later: first one drops out
    add("2026-10-02T13:00:00Z", customer__name="Zoë Ångström", customer__email="zoe.angstrom@example.com",
        customer__id="edge_zoe")
    add("2026-10-02T13:05:00Z", customer__name=None, customer__id="edge_anon",
        customer__email="anon123@example.com")
    add("2026-10-02T13:10:00Z", device__ip="2001:db8::1", device__id="edge_v6")
    add("2026-10-02T13:15:00Z", shipping_address__line1="12 oak  ave Apt 4", shipping_address__lat=None,
        shipping_address__lon=None)
    add("2026-10-02T13:20:00Z", customer__email="x9f2k@tmpbox.net", customer__id="edge_bot",
        device__user_agent="HeadlessChrome/129", device__id="edge_bot_dev",
        channel="app", promo_code="WELCOME10", order_note="Please ship ASAP",
        items=[{"sku": "GIF-0001", "category": "gift_cards", "quantity": 2, "unit_price_minor": 10_000},
               {"sku": "DIG-0001", "category": "digital_goods", "quantity": 1, "unit_price_minor": 199}],
        amount_minor=20_199)
    add("2026-10-02T13:25:00Z", customer__id="edge_zero", amount_minor=0,
        items=[{"sku": "BOO-0002", "category": "books", "quantity": 1, "unit_price_minor": 0}])
    add("2026-10-02T13:30:00Z", customer__id="edge_zero")  # prior average is 0 -> null ratio
    add("2026-10-02T13:35:00Z", device__user_agent=None)
    add("2026-10-09T13:14:00Z", shipping_address__line1="12 Oak Ave #9", customer__id="edge_late")
    return [txn for _, txn in cases]


def build() -> dict[str, Any]:
    streams = []
    for name, txns in (("simulated", simulated_stream()), ("edge_cases", edge_case_stream())):
        streams.append({"name": name, "transactions": txns, "features": list(stream_features(txns))})
    return {"spec_version": SPEC_VERSION, "streams": streams}


def render(golden: dict[str, Any]) -> str:
    return json.dumps(golden, indent=1, ensure_ascii=False) + "\n"


def main(path: Path = GOLDEN_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    golden = build()
    path.write_text(render(golden))
    sizes = ", ".join(f"{s['name']}={len(s['transactions'])}" for s in golden["streams"])
    print(f"wrote {path} ({sizes})")


if __name__ == "__main__":
    main()
