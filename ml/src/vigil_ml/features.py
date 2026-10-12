"""Feature computation; Python mirror of scoring-service/src/features/.

Spec: contracts/feature_spec.md. Parity is enforced by contracts/golden/features.json.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from vigil_simulator.geo import City, city_for_ip, haversine_km

FEATURE_NAMES = [
    "amount_usd",
    "n_items",
    "max_unit_price_usd",
    "has_electronics",
    "has_gift_cards",
    "has_digital_goods",
    "promo_code_used",
    "has_order_note",
    "hour_of_day",
    "channel_app",
    "account_age_days",
    "email_disposable",
    "email_name_match",
    "ua_headless",
    "ip_known",
    "ip_country_matches_billing",
    "ip_country_matches_card",
    "ip_billing_distance_km",
    "billing_shipping_distance_km",
    "shipping_matches_billing",
    "card_txn_count_1h",
    "card_txn_count_24h",
    "card_amount_usd_24h",
    "device_txn_count_1h",
    "device_txn_count_24h",
    "ip_txn_count_1h",
    "email_txn_count_24h",
    "device_distinct_cards_24h",
    "device_distinct_accounts_24h",
    "card_distinct_accounts_24h",
    "shipping_distinct_accounts_7d",
    "customer_prior_txns",
    "is_new_device_for_customer",
    "is_new_card_for_customer",
    "amount_vs_customer_avg",
    "card_other_customers",
    "minutes_since_last_customer_txn",
    "travel_speed_kmh",
]

HOUR_MS = 3_600_000
DAY_MS = 24 * HOUR_MS
WEEK_MS = 7 * DAY_MS
_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
_MS = timedelta(milliseconds=1)

DISPOSABLE_DOMAINS = {"quickinbox.io", "tmpbox.net", "mailnow.xyz", "burnr.email"}
_UNIT_SUFFIX = re.compile(r"\s+(apt|unit|suite|ste|#)\s*\S*$", re.IGNORECASE)
_HEADLESS = re.compile(r"headless|python-requests|curl|wget|phantomjs|selenium", re.IGNORECASE)

Txn = dict[str, Any]
Features = dict[str, float | int | None]


def epoch_ms(iso: str) -> int:
    """Exact integer milliseconds, matching JavaScript Date.parse."""
    return (datetime.fromisoformat(iso) - _EPOCH) // _MS


def address_key(a: dict[str, Any]) -> str:
    line = _UNIT_SUFFIX.sub("", (a.get("line1") or "").lower().strip())
    line = re.sub(r"\s+", " ", line)
    return f"{a['country']}|{a['postal_code']}|{line}"


def name_tokens(name: str) -> list[str]:
    folded = "".join(
        c for c in unicodedata.normalize("NFKD", name) if not unicodedata.category(c).startswith("M")
    ).lower()
    return [t for t in re.split(r"[^a-z]+", folded) if len(t) >= 2]


def is_headless(user_agent: str | None) -> bool:
    return user_agent is not None and _HEADLESS.search(user_agent) is not None


@dataclass
class CustomerProfile:
    count: int
    sum_minor: int
    last_ts: int
    last_ip: str


@dataclass
class HistorySnapshot:
    card_events_24h: list[tuple[int, int]] = field(default_factory=list)  # (ts, amount_minor)
    device_events_24h: list[int] = field(default_factory=list)
    ip_count_1h: int = 0
    email_count_24h: int = 0
    device_distinct_cards_24h: int = 0
    device_distinct_accounts_24h: int = 0
    card_distinct_accounts_24h: int = 0
    shipping_distinct_accounts_7d: int = 0
    customer: CustomerProfile | None = None
    customer_has_device: bool = False
    customer_has_card: bool = False
    card_customers_total: int = 0
    card_customers_includes_current: bool = False


def _has_lat_lon(a: dict[str, Any]) -> bool:
    return a.get("lat") is not None and a.get("lon") is not None


def compute_features(txn: Txn, h: HistorySnapshot) -> Features:
    """Pure feature computation. Mirrors computeFeatures in compute.ts."""
    t = epoch_ms(txn["occurred_at"])
    amount_usd = txn["amount_minor"] / 100
    items = txn["items"]
    categories = {i["category"] for i in items}
    customer = txn["customer"]
    local, _, domain = customer["email"].rpartition("@")
    local, domain = local.lower(), domain.lower()
    tokens = name_tokens(customer["name"]) if customer.get("name") else []

    ip_city: City | None = city_for_ip_strict(txn["device"]["ip"])
    billing, shipping = txn["billing_address"], txn["shipping_address"]

    prof = h.customer
    last_city = city_for_ip_strict(prof.last_ip) if prof else None
    travel_speed = None
    if prof and ip_city and last_city:
        hours = max((t - prof.last_ts) / HOUR_MS, 1 / 60)
        travel_speed = haversine_km(last_city.lat, last_city.lon, ip_city.lat, ip_city.lon) / hours
    avg_minor = prof.sum_minor / prof.count if prof and prof.count > 0 else 0

    return {
        "amount_usd": amount_usd,
        "n_items": sum(i["quantity"] for i in items),
        "max_unit_price_usd": max(i["unit_price_minor"] for i in items) / 100,
        "has_electronics": int("electronics" in categories),
        "has_gift_cards": int("gift_cards" in categories),
        "has_digital_goods": int("digital_goods" in categories),
        "promo_code_used": int(bool(txn.get("promo_code"))),
        "has_order_note": int(bool(txn.get("order_note"))),
        "hour_of_day": datetime.fromtimestamp(t / 1000, UTC).hour,
        "channel_app": int(txn["channel"] == "app"),
        "account_age_days": (t - epoch_ms(customer["account_created_at"])) / DAY_MS,
        "email_disposable": int(domain in DISPOSABLE_DOMAINS),
        "email_name_match": None if not tokens else int(any(tok in local for tok in tokens)),
        "ua_headless": int(is_headless(txn["device"].get("user_agent"))),
        "ip_known": int(ip_city is not None),
        "ip_country_matches_billing": (
            int(ip_city.country == billing["country"]) if ip_city else None
        ),
        "ip_country_matches_card": int(ip_city.country == txn["card"]["country"]) if ip_city else None,
        "ip_billing_distance_km": (
            haversine_km(ip_city.lat, ip_city.lon, billing["lat"], billing["lon"])
            if ip_city and _has_lat_lon(billing)
            else None
        ),
        "billing_shipping_distance_km": (
            haversine_km(billing["lat"], billing["lon"], shipping["lat"], shipping["lon"])
            if _has_lat_lon(billing) and _has_lat_lon(shipping)
            else None
        ),
        "shipping_matches_billing": int(address_key(billing) == address_key(shipping)),
        "card_txn_count_1h": sum(1 for ts, _ in h.card_events_24h if ts >= t - HOUR_MS),
        "card_txn_count_24h": len(h.card_events_24h),
        "card_amount_usd_24h": sum(a for _, a in h.card_events_24h) / 100,
        "device_txn_count_1h": sum(1 for ts in h.device_events_24h if ts >= t - HOUR_MS),
        "device_txn_count_24h": len(h.device_events_24h),
        "ip_txn_count_1h": h.ip_count_1h,
        "email_txn_count_24h": h.email_count_24h,
        "device_distinct_cards_24h": h.device_distinct_cards_24h,
        "device_distinct_accounts_24h": h.device_distinct_accounts_24h,
        "card_distinct_accounts_24h": h.card_distinct_accounts_24h,
        "shipping_distinct_accounts_7d": h.shipping_distinct_accounts_7d,
        "customer_prior_txns": prof.count if prof else 0,
        "is_new_device_for_customer": int(not h.customer_has_device),
        "is_new_card_for_customer": int(not h.customer_has_card),
        "amount_vs_customer_avg": amount_usd / (avg_minor / 100) if avg_minor > 0 else None,
        "card_other_customers": h.card_customers_total - int(h.card_customers_includes_current),
        "minutes_since_last_customer_txn": (t - prof.last_ts) / 60_000 if prof else None,
        "travel_speed_kmh": travel_speed,
    }


_IPV4 = re.compile(r"^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$")


def city_for_ip_strict(ip: str) -> City | None:
    """IPv4-only lookup (spec: anything else, including IPv6, is unknown)."""
    return city_for_ip(ip) if _IPV4.match(ip) else None


def _keys(txn: Txn) -> dict[str, Any]:
    return {
        "t": epoch_ms(txn["occurred_at"]),
        "card": txn["card"]["token"],
        "device": txn["device"]["id"],
        "ip": txn["device"]["ip"],
        "email": txn["customer"]["email"].lower(),
        "customer": txn["customer"]["id"],
        "shipping": address_key(txn["shipping_address"]),
    }


class InMemoryFeatureStore:
    """Mirror of InMemoryFeatureStore in store.ts."""

    def __init__(self) -> None:
        self.card_events: dict[str, list[tuple[int, int]]] = {}
        self.device_events: dict[str, list[int]] = {}
        self.ip_events: dict[str, list[int]] = {}
        self.email_events: dict[str, list[int]] = {}
        self.device_cards: dict[str, dict[str, int]] = {}
        self.device_accounts: dict[str, dict[str, int]] = {}
        self.card_accounts: dict[str, dict[str, int]] = {}
        self.shipping_accounts: dict[str, dict[str, int]] = {}
        self.customers: dict[str, CustomerProfile] = {}
        self.customer_devices: dict[str, set[str]] = {}
        self.customer_cards: dict[str, set[str]] = {}
        self.card_customers: dict[str, set[str]] = {}

    @staticmethod
    def _distinct(m: dict[str, dict[str, int]], key: str, lo: int, hi: int) -> int:
        return sum(1 for ts in m.get(key, {}).values() if lo <= ts < hi)

    def snapshot(self, txn: Txn) -> HistorySnapshot:
        k = _keys(txn)
        t = k["t"]

        def within(ts: int, w: int) -> bool:
            return t - w <= ts < t

        prof = self.customers.get(k["customer"])
        card_customers = self.card_customers.get(k["card"], set())
        return HistorySnapshot(
            card_events_24h=[e for e in self.card_events.get(k["card"], []) if within(e[0], DAY_MS)],
            device_events_24h=[ts for ts in self.device_events.get(k["device"], []) if within(ts, DAY_MS)],
            ip_count_1h=sum(1 for ts in self.ip_events.get(k["ip"], []) if within(ts, HOUR_MS)),
            email_count_24h=sum(1 for ts in self.email_events.get(k["email"], []) if within(ts, DAY_MS)),
            device_distinct_cards_24h=self._distinct(self.device_cards, k["device"], t - DAY_MS, t),
            device_distinct_accounts_24h=self._distinct(self.device_accounts, k["device"], t - DAY_MS, t),
            card_distinct_accounts_24h=self._distinct(self.card_accounts, k["card"], t - DAY_MS, t),
            shipping_distinct_accounts_7d=self._distinct(
                self.shipping_accounts, k["shipping"], t - WEEK_MS, t
            ),
            customer=CustomerProfile(**vars(prof)) if prof else None,
            customer_has_device=k["device"] in self.customer_devices.get(k["customer"], set()),
            customer_has_card=k["card"] in self.customer_cards.get(k["customer"], set()),
            card_customers_total=len(card_customers),
            card_customers_includes_current=k["customer"] in card_customers,
        )

    def record(self, txn: Txn) -> None:
        k = _keys(txn)
        t = k["t"]
        self.card_events.setdefault(k["card"], []).append((t, txn["amount_minor"]))
        self.device_events.setdefault(k["device"], []).append(t)
        self.ip_events.setdefault(k["ip"], []).append(t)
        self.email_events.setdefault(k["email"], []).append(t)
        for m, key, value in (
            (self.device_cards, k["device"], k["card"]),
            (self.device_accounts, k["device"], k["customer"]),
            (self.card_accounts, k["card"], k["customer"]),
            (self.shipping_accounts, k["shipping"], k["customer"]),
        ):
            inner = m.setdefault(key, {})
            inner[value] = max(inner.get(value, t), t)

        prev = self.customers.get(k["customer"])
        self.customers[k["customer"]] = CustomerProfile(
            count=(prev.count if prev else 0) + 1,
            sum_minor=(prev.sum_minor if prev else 0) + txn["amount_minor"],
            last_ts=t,
            last_ip=k["ip"],
        )
        self.customer_devices.setdefault(k["customer"], set()).add(k["device"])
        self.customer_cards.setdefault(k["customer"], set()).add(k["card"])
        self.card_customers.setdefault(k["card"], set()).add(k["customer"])


def stream_features(transactions: Iterable[Txn]) -> Iterator[Features]:
    """Extract-then-record over a time-ordered stream (training / golden vectors)."""
    store = InMemoryFeatureStore()
    for txn in transactions:
        yield compute_features(txn, store.snapshot(txn))
        store.record(txn)
