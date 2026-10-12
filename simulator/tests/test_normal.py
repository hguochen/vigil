from datetime import UTC, datetime

from vigil_simulator.geo import city_for_ip, haversine_km
from vigil_simulator.normal import normal_traffic
from vigil_simulator.world import build_world

START = datetime(2026, 9, 1, tzinfo=UTC)


def traffic(seed=11, customers=300, days=30):
    world = build_world(seed, customers, START, days)
    return world, normal_traffic(world)


def test_volume_matches_purchase_rates():
    world, records = traffic()
    expected = sum(c.purchases_per_day for c in world.customers) * world.days
    assert 0.8 * expected < len(records) < 1.2 * expected


def test_records_are_legit_and_inside_window():
    world, records = traffic()
    for r in records:
        assert not r.label.is_fraud
        assert r.label.pattern == "none" and r.label.reported_at is None
        assert world.start <= r.occurred_at < world.end


def test_amount_is_sum_of_items():
    _, records = traffic()
    for r in records:
        t = r.transaction
        assert t["amount_minor"] == sum(i["quantity"] * i["unit_price_minor"] for i in t["items"])
        assert t["amount_minor"] > 0


def test_mostly_home_ip_with_some_travel_noise():
    world, records = traffic()
    homes = {c.id: c.home for c in world.customers}
    at_home = sum(
        city_for_ip(r.transaction["device"]["ip"]) == homes[r.transaction["customer"]["id"]]
        for r in records
    )
    share = at_home / len(records)
    assert 0.90 < share < 0.99  # ~5% traveling


def test_deterministic():
    _, a = traffic(seed=5)
    _, b = traffic(seed=5)
    assert [r.transaction for r in a] == [r.transaction for r in b]


def test_travel_is_physically_plausible():
    """Consecutive purchases by one customer should rarely imply flight-speed travel."""
    _, records = traffic(customers=1000, days=60)
    last: dict = {}
    pairs = fast = 0
    for r in sorted(records, key=lambda r: r.occurred_at):
        cid = r.transaction["customer"]["id"]
        city = city_for_ip(r.transaction["device"]["ip"])
        if cid in last:
            prev_at, prev_city = last[cid]
            hours = max((r.occurred_at - prev_at).total_seconds() / 3600, 1 / 60)
            km = haversine_km(prev_city.lat, prev_city.lon, city.lat, city.lon)
            pairs += 1
            fast += km / hours > 900
        last[cid] = (r.occurred_at, city)
    assert fast / pairs < 0.002  # only trips that start/end right around a purchase
