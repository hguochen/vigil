import re
from datetime import UTC, datetime

import numpy as np
from vigil_simulator.entities import (
    CATEGORIES,
    IdFactory,
    build_catalog,
    build_customers,
    disposable_email,
)
from vigil_simulator.geo import city_for_ip

START = datetime(2026, 9, 1, tzinfo=UTC)


def make(seed=1, n=200):
    rng = np.random.default_rng(seed)
    ids = IdFactory(rng)
    return build_catalog(rng), build_customers(rng, ids, n, START)


def test_catalog_prices_within_category_bounds():
    catalog, _ = make()
    assert len({p.sku for p in catalog}) == len(catalog)
    for p in catalog:
        lo, hi, _ = CATEGORIES[p.category]
        assert lo - 1 <= p.unit_price_minor <= hi


def test_customers_are_deterministic_for_a_seed():
    _, a = make(seed=7)
    _, b = make(seed=7)
    assert [c.email for c in a] == [c.email for c in b]


def test_customers_look_valid():
    _, customers = make()
    assert len({c.id for c in customers}) == len(customers)
    tokens = [card.token for c in customers for card in c.cards]
    assert len(set(tokens)) == len(tokens)
    domestic = sum(c.home.is_domestic for c in customers) / len(customers)
    assert 0.75 < domestic < 0.97
    for c in customers:
        assert c.account_created_at < START
        assert re.fullmatch(r"[^@\s]+@[^@\s]+\.[a-z]+", c.email)
        assert all(card.country == c.home.country for card in c.cards)
        assert re.fullmatch(r"[45]\d{5}", c.cards[0].bin)
        assert city_for_ip(c.home_ip()) == c.home


def test_disposable_email_uses_disposable_domain():
    rng = np.random.default_rng(3)
    assert disposable_email(rng).split("@")[1] in {
        "quickinbox.io", "tmpbox.net", "mailnow.xyz", "burnr.email"
    }
