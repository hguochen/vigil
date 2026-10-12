"""Legitimate shopping traffic, with realistic noise so fraud is not trivially separable."""

from __future__ import annotations

from datetime import datetime

import numpy as np

from .entities import EVERYDAY_CATEGORIES, Customer, Product, ip_in
from .world import Label, Record, World, address, make_txn

COMMON_PROMOS = ["WELCOME10", "FALL25", "FREESHIP"]
BENIGN_NOTES = [
    "Leave at the back door",
    "Please ring the bell",
    "Gift - please wrap",
    "Deliver after 5pm",
    "Building code 4471",
]
GIFT_STREETS = ["Birch Ct", "Willow St", "Harbor Rd", "Sunset Ave"]

# Probability of each legitimate-but-unusual behavior on a given purchase.
P_NEW_DEVICE = 0.04
P_TRAVELING = 0.05
P_GIFT_SHIPPING = 0.04
P_BIG_TICKET = 0.02
P_PROMO = 0.08
P_NOTE = 0.10


def pick_product(world: World, category: str, target_price: float) -> Product:
    candidates = world.by_category(category)
    picks = world.rng.choice(len(candidates), size=3, replace=False)
    return min(
        (candidates[i] for i in picks),
        key=lambda p: abs(np.log(p.unit_price_minor) - np.log(target_price)),
    )


def basket(world: World, customer: Customer, big_ticket: bool) -> list[tuple[Product, int]]:
    rng = world.rng
    if big_ticket:
        electronics = sorted(world.by_category("electronics"), key=lambda p: p.unit_price_minor)
        return [(electronics[int(rng.integers(len(electronics) * 2 // 3, len(electronics)))], 1)]
    n_items = int(rng.choice([1, 2, 3, 4], p=[0.6, 0.25, 0.1, 0.05]))
    items = []
    for _ in range(n_items):
        prefs = customer.preferred_categories
        category = rng.choice(prefs) if rng.random() < 0.85 else rng.choice(EVERYDAY_CATEGORIES)
        product = pick_product(world, str(category), 3_000 * customer.spend_scale)
        qty = 1 if rng.random() < 0.85 else int(rng.integers(2, 4))
        items.append((product, qty))
    return items


def legit_purchase(world: World, customer: Customer, at: datetime) -> Record:
    rng = world.rng
    home = address(customer.home, customer.street, rng)
    shipping = home
    ip = customer.home_ip()
    note = str(rng.choice(BENIGN_NOTES)) if rng.random() < P_NOTE else None

    if rng.random() < P_NEW_DEVICE:
        customer.devices.append(world.ids.device())  # new phone/laptop, reused afterwards
        device = customer.devices[-1]
    else:
        device = customer.devices[int(rng.integers(len(customer.devices)))]

    if rng.random() < P_TRAVELING:
        pool = world.domestic_cities() if rng.random() < 0.8 else world.foreign_cities()
        ip = ip_in(pool[int(rng.integers(len(pool)))], world.ids.ip_host())
    if rng.random() < P_GIFT_SHIPPING:
        city = world.domestic_cities()[int(rng.integers(len(world.domestic_cities())))]
        street = f"{rng.integers(10, 9999)} {rng.choice(GIFT_STREETS)}"
        shipping = address(city, street, rng)
        note = "Gift - please wrap" if rng.random() < 0.5 else note

    txn = make_txn(
        rng=rng,
        occurred_at=at,
        customer_id=customer.id,
        email=customer.email,
        name=customer.name,
        account_created_at=customer.account_created_at,
        card=customer.cards[int(rng.integers(len(customer.cards)))],
        device=device,
        ip=ip,
        billing=home,
        shipping=shipping,
        items=basket(world, customer, big_ticket=rng.random() < P_BIG_TICKET),
        promo_code=str(rng.choice(COMMON_PROMOS)) if rng.random() < P_PROMO else None,
        order_note=note,
    )
    return Record(at, txn, Label(is_fraud=False, scenario="legit", pattern="none"))


def normal_traffic(world: World) -> list[Record]:
    """Each customer purchases as a Poisson process at their own rate."""
    records = []
    for customer in world.customers:
        n = int(world.rng.poisson(customer.purchases_per_day * world.days))
        times = sorted(world.random_time() for _ in range(n))
        records.extend(legit_purchase(world, customer, t) for t in times)
    return records
