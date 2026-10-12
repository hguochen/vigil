"""Fraud scenarios. Each returns the records of one fraud episode starting at `at`.

Scenario names are what the benchmark reports on; each maps to one of the
API's fraud patterns (several scenarios can share a pattern).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta

from .entities import (
    STREETS,
    Card,
    Customer,
    Device,
    Product,
    disposable_email,
    email_for,
    ip_in,
    make_name,
)
from .geo import City
from .normal import legit_purchase
from .world import Label, Record, World, address, make_txn

FRAUD_NOTES = ["Please ship ASAP", "Urgent - need by tomorrow", "Do not call, leave at door"]


@dataclass
class Account:
    id: str
    email: str
    name: str | None
    created_at: datetime


def fraud_city(world: World, p_foreign: float) -> City:
    pool = world.foreign_cities() if world.rng.random() < p_foreign else world.domestic_cities()
    return pool[int(world.rng.integers(len(pool)))]


def random_customer(world: World) -> Customer:
    return world.customers[int(world.rng.integers(len(world.customers)))]


def new_account(world: World, at: datetime, disposable: bool) -> Account:
    rng = world.rng
    name = make_name(rng)
    email = disposable_email(rng) if disposable else email_for(name, rng)
    age = timedelta(minutes=float(rng.uniform(2, 60 * 48)))
    return Account(world.ids.next("cust"), email, name if rng.random() < 0.7 else None, at - age)


def account_of(c: Customer) -> Account:
    return Account(c.id, c.email, c.name, c.account_created_at)


def priciest(world: World, categories: list[str], top_fraction: float = 0.4) -> list[Product]:
    products = sorted(
        (p for c in categories for p in world.by_category(c)), key=lambda p: p.unit_price_minor
    )
    return products[int(len(products) * (1 - top_fraction)) :]


def pick(world: World, products: list[Product]) -> Product:
    return products[int(world.rng.integers(len(products)))]


def labelled(
    world: World,
    scenario: str,
    pattern: str,
    at: datetime,
    *,
    p_report: float,
    days: tuple[float, float],
    source: str = "chargeback",
) -> Label:
    if world.rng.random() >= p_report:
        return Label(True, scenario, pattern)
    delay = timedelta(days=float(world.rng.uniform(*days)))
    return Label(True, scenario, pattern, reported_at=at + delay, report_source=source)


def fraud_txn(
    world: World,
    at: datetime,
    account: Account,
    card: Card,
    device: Device,
    ip: str,
    billing: dict,
    shipping: dict,
    items: list[tuple[Product, int]],
    promo_code: str | None = None,
    note: str | None = None,
) -> dict:
    return make_txn(
        rng=world.rng,
        occurred_at=at,
        customer_id=account.id,
        email=account.email,
        name=account.name,
        account_created_at=account.created_at,
        card=card,
        device=device,
        ip=ip,
        billing=billing,
        shipping=shipping,
        items=items,
        promo_code=promo_code,
        order_note=note,
    )


def maybe_note(world: World, p: float = 0.3) -> str | None:
    return str(world.rng.choice(FRAUD_NOTES)) if world.rng.random() < p else None


def card_testing(world: World, at: datetime) -> list[Record]:
    """Many tiny charges on freshly stolen cards sharing a BIN, from one bot device."""
    rng = world.rng
    city = fraud_city(world, p_foreign=0.6)
    device = world.ids.device(headless=rng.random() < 0.7)
    ip = ip_in(city, world.ids.ip_host())
    account = new_account(world, at, disposable=True)
    shared_bin = world.ids.card("US").bin
    cheap = sorted(world.by_category("digital_goods"), key=lambda p: p.unit_price_minor)[:5]
    billing = address(city, f"{rng.integers(10, 9999)} {rng.choice(STREETS)}", rng)

    records, t = [], at
    for _ in range(int(rng.integers(6, 21))):
        stolen = world.ids.card("US")
        card = Card(stolen.token, shared_bin, stolen.last4, "US")
        txn = fraud_txn(world, t, account, card, device, ip, billing, billing, [(pick(world, cheap), 1)])
        label = labelled(world, "card_testing", "card_testing", t, p_report=0.5, days=(5, 45))
        records.append(Record(t, txn, label))
        t += timedelta(seconds=float(rng.uniform(10, 90)))
    return records


def stolen_card(world: World, at: datetime) -> list[Record]:
    """A victim's card used on a brand-new account for high-value goods shipped elsewhere."""
    rng = world.rng
    victim = random_customer(world)
    card = victim.cards[0] if rng.random() < 0.6 else world.ids.card("US")
    city = fraud_city(world, p_foreign=0.6)
    device = world.ids.device(headless=rng.random() < 0.2)
    ip = ip_in(city, world.ids.ip_host())
    account = new_account(world, at, disposable=rng.random() < 0.6)
    billing = address(victim.home, victim.street, rng)  # fraudster has the victim's billing info
    drop = fraud_city(world, p_foreign=0.2)
    shipping = address(drop, f"{rng.integers(10, 9999)} {rng.choice(STREETS)}", rng)
    goods = priciest(world, ["electronics", "gift_cards"])

    records, t = [], at
    for _ in range(int(rng.choice([1, 2, 3], p=[0.5, 0.35, 0.15]))):
        items = [(pick(world, goods), int(rng.choice([1, 2], p=[0.8, 0.2])))]
        txn = fraud_txn(world, t, account, card, device, ip, billing, shipping, items,
                        note=maybe_note(world))
        records.append(Record(t, txn, labelled(world, "stolen_card", "stolen_card", t,
                                                p_report=0.95, days=(7, 45))))
        t += timedelta(minutes=float(rng.uniform(3, 50)))
    return records


def account_takeover(world: World, at: datetime) -> list[Record]:
    """A real, aged account accessed from a new device abroad; shipping redirected."""
    rng = world.rng
    victim = random_customer(world)
    city = fraud_city(world, p_foreign=0.75)
    device = world.ids.device(headless=rng.random() < 0.3)
    ip = ip_in(city, world.ids.ip_host())
    billing = address(victim.home, victim.street, rng)
    drop = fraud_city(world, p_foreign=0.3)
    shipping = address(drop, f"{rng.integers(10, 9999)} {rng.choice(STREETS)}", rng)
    goods = priciest(world, ["electronics", "gift_cards"], top_fraction=0.5)

    records, t = [], at
    for _ in range(int(rng.choice([1, 2, 3], p=[0.5, 0.3, 0.2]))):
        txn = fraud_txn(world, t, account_of(victim), victim.cards[0], device, ip, billing,
                        shipping, [(pick(world, goods), 1)], note=maybe_note(world, 0.2))
        records.append(Record(t, txn, labelled(world, "account_takeover", "account_takeover", t,
                                                p_report=0.95, days=(3, 30))))
        t += timedelta(minutes=float(rng.uniform(10, 180)))
    return records


def velocity_burst(world: World, at: datetime) -> list[Record]:
    """One stolen card maxed out across many mid-value orders in under an hour."""
    rng = world.rng
    card = world.ids.card("US")
    city = fraud_city(world, p_foreign=0.4)
    device = world.ids.device()
    ip = ip_in(city, world.ids.ip_host())
    shipping = address(city, f"{rng.integers(10, 9999)} {rng.choice(STREETS)}", rng)
    goods = [
        p for p in world.catalog
        if 5_000 <= p.unit_price_minor <= 40_000 and p.category in ("electronics", "gift_cards", "sports")
    ]

    records, t = [], at
    for _ in range(int(rng.integers(4, 11))):
        # Fresh guest account per order to dodge per-account limits.
        account = new_account(world, t, disposable=rng.random() < 0.5)
        txn = fraud_txn(world, t, account, card, device, ip, shipping, shipping,
                        [(pick(world, goods), 1)])
        records.append(Record(t, txn, labelled(world, "velocity_burst", "stolen_card", t,
                                                p_report=0.9, days=(5, 40))))
        t += timedelta(minutes=float(rng.uniform(1, 6)))
    return records


def impossible_travel(world: World, at: datetime) -> list[Record]:
    """Victim buys at home; minutes later their account buys from another continent."""
    rng = world.rng
    victim = random_customer(world)
    genuine = legit_purchase(world, victim, at, at_home=True)

    t = at + timedelta(minutes=float(rng.uniform(5, 60)))
    far = [c for c in world.foreign_cities() if c.country != victim.home.country]
    city = far[int(rng.integers(len(far)))]
    device = world.ids.device()
    ip = ip_in(city, world.ids.ip_host())
    shipping = address(city, f"{rng.integers(10, 9999)} {rng.choice(STREETS)}", rng)
    billing = address(victim.home, victim.street, rng)
    goods = priciest(world, ["electronics", "gift_cards"], top_fraction=0.6)
    txn = fraud_txn(world, t, account_of(victim), victim.cards[0], device, ip, billing, shipping,
                    [(pick(world, goods), 1)])
    fraud = Record(t, txn, labelled(world, "impossible_travel", "account_takeover", t,
                                    p_report=0.95, days=(3, 30)))
    return [genuine, fraud]


def promo_abuse(world: World, at: datetime) -> list[Record]:
    """Many new accounts from the same device/address farming a new-customer promo."""
    rng = world.rng
    home = world.domestic_cities()[int(rng.integers(len(world.domestic_cities())))]
    street = f"{rng.integers(10, 9999)} {rng.choice(STREETS)}"
    devices = [world.ids.device() for _ in range(int(rng.integers(1, 3)))]
    ip = ip_in(home, world.ids.ip_host())
    goods = [p for p in world.catalog if 1_500 <= p.unit_price_minor <= 6_000]

    records, t = [], at
    for i in range(int(rng.integers(4, 13))):
        account = new_account(world, t, disposable=rng.random() < 0.7)
        # Slight address variations ("Apt 2", "#2") to dodge exact-match checks.
        line = street if i % 3 == 0 else f"{street} {rng.choice(['Apt', 'Unit', '#'])} {i}"
        addr = address(home, line, rng)
        items = [(pick(world, goods), 1) for _ in range(int(rng.integers(1, 3)))]
        txn = fraud_txn(world, t, account, world.ids.card(home.country), devices[i % len(devices)],
                        ip, addr, addr, items, promo_code="WELCOME10")
        records.append(Record(t, txn, labelled(world, "promo_abuse", "promo_abuse", t,
                                                p_report=0.6, days=(3, 14), source="manual_review")))
        t += timedelta(hours=float(rng.uniform(0.5, 12)))
    return records


def friendly_fraud(world: World, at: datetime) -> list[Record]:
    """A real customer buys normally, then disputes the charge. Hard to detect by design."""
    rng = world.rng
    customer = random_customer(world)
    record = legit_purchase(world, customer, at)
    if rng.random() < 0.6:  # skews toward pricier items worth disputing
        goods = priciest(world, ["electronics", "apparel", "sports"], top_fraction=0.5)
        record.transaction["items"] = [
            {"sku": p.sku, "name": p.name, "category": p.category, "quantity": 1,
             "unit_price_minor": p.unit_price_minor}
            for p in [pick(world, goods)]
        ]
        record.transaction["amount_minor"] = record.transaction["items"][0]["unit_price_minor"]
    record.label = labelled(world, "friendly_fraud", "friendly_fraud", at, p_report=1.0,
                            days=(20, 90))
    return [record]


Scenario = Callable[[World, datetime], list[Record]]

# Episode weights (not transaction shares: card testing episodes are large).
SCENARIOS: dict[str, tuple[Scenario, float]] = {
    "card_testing": (card_testing, 0.06),
    "stolen_card": (stolen_card, 0.25),
    "account_takeover": (account_takeover, 0.20),
    "velocity_burst": (velocity_burst, 0.08),
    "impossible_travel": (impossible_travel, 0.13),
    "promo_abuse": (promo_abuse, 0.08),
    "friendly_fraud": (friendly_fraud, 0.20),
}

PATTERN_OF = {
    "card_testing": "card_testing",
    "stolen_card": "stolen_card",
    "account_takeover": "account_takeover",
    "velocity_burst": "stolen_card",
    "impossible_travel": "account_takeover",
    "promo_abuse": "promo_abuse",
    "friendly_fraud": "friendly_fraud",
}
