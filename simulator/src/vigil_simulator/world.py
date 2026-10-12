"""Simulation world and the transaction builder shared by normal and fraud traffic."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

import numpy as np

from .entities import (
    Card,
    Customer,
    Device,
    IdFactory,
    Product,
    build_catalog,
    build_customers,
)
from .geo import City, load_cities

# Relative purchase likelihood per hour of day (merchant-local time).
HOURLY_WEIGHTS = np.array(
    [2, 1, 1, 1, 1, 2, 3, 5, 6, 7, 7, 8, 8, 8, 7, 7, 7, 8, 9, 10, 10, 9, 6, 4], dtype=float
)
HOURLY_WEIGHTS /= HOURLY_WEIGHTS.sum()


@dataclass
class Label:
    is_fraud: bool
    scenario: str  # "legit" or a fraud scenario name
    pattern: str  # one of the API fraud patterns, or "none"
    # When/how the merchant learns the ground truth. None means never reported,
    # which happens in reality (e.g. small card-testing charges nobody disputes).
    reported_at: datetime | None = None
    report_source: str | None = None  # "chargeback" | "manual_review"


@dataclass
class Record:
    occurred_at: datetime
    transaction: dict[str, Any]
    label: Label


@dataclass
class World:
    rng: np.random.Generator
    ids: IdFactory
    catalog: list[Product]
    customers: list[Customer]
    cities: tuple[City, ...]
    start: datetime
    days: int

    @property
    def end(self) -> datetime:
        return self.start + timedelta(days=self.days)

    def by_category(self, category: str) -> list[Product]:
        return [p for p in self.catalog if p.category == category]

    def random_time(self) -> datetime:
        day = int(self.rng.integers(0, self.days))
        hour = int(self.rng.choice(24, p=HOURLY_WEIGHTS))
        seconds = int(self.rng.integers(0, 3600))
        return self.start + timedelta(days=day, hours=hour, seconds=seconds)

    def domestic_cities(self) -> list[City]:
        return [c for c in self.cities if c.is_domestic]

    def foreign_cities(self) -> list[City]:
        return [c for c in self.cities if not c.is_domestic]


def build_world(seed: int, n_customers: int, start: datetime, days: int) -> World:
    rng = np.random.default_rng(seed)
    ids = IdFactory(rng)
    catalog = build_catalog(rng)
    customers = build_customers(rng, ids, n_customers, start)
    return World(rng, ids, catalog, customers, load_cities(), start, days)


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def address(city: City, street: str, rng: np.random.Generator) -> dict[str, Any]:
    return {
        "line1": street,
        "city": city.name,
        "region": city.region,
        "postal_code": city.postal_code,
        "country": city.country,
        "lat": round(city.lat + float(rng.normal(0, 0.03)), 4),
        "lon": round(city.lon + float(rng.normal(0, 0.03)), 4),
    }


def make_txn(
    *,
    rng: np.random.Generator,
    occurred_at: datetime,
    customer_id: str,
    email: str,
    name: str | None,
    account_created_at: datetime,
    card: Card,
    device: Device,
    ip: str,
    billing: dict[str, Any],
    shipping: dict[str, Any],
    items: list[tuple[Product, int]],
    promo_code: str | None = None,
    order_note: str | None = None,
) -> dict[str, Any]:
    """Builds a transaction matching contracts/openapi.yaml#/components/schemas/Transaction.

    transaction_id is assigned later, once all records are sorted by time.
    """
    txn: dict[str, Any] = {
        "transaction_id": "",
        "occurred_at": iso(occurred_at),
        "amount_minor": sum(p.unit_price_minor * qty for p, qty in items),
        "currency": "USD",
        "channel": "app" if "App/" in device.user_agent else "web",
        "customer": {
            "id": customer_id,
            "email": email,
            "account_created_at": iso(account_created_at),
        },
        "card": {"token": card.token, "bin": card.bin, "last4": card.last4, "country": card.country},
        "device": {"id": device.id, "ip": ip, "user_agent": device.user_agent},
        "billing_address": billing,
        "shipping_address": shipping,
        "items": [
            {
                "sku": p.sku,
                "name": p.name,
                "category": p.category,
                "quantity": qty,
                "unit_price_minor": p.unit_price_minor,
            }
            for p, qty in items
        ],
    }
    if name:
        txn["customer"]["name"] = name
    if promo_code:
        txn["promo_code"] = promo_code
    if order_note:
        txn["order_note"] = order_note
    return txn
