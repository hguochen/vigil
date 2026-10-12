from datetime import UTC, datetime

import pytest
from vigil_simulator.geo import city_for_ip, haversine_km
from vigil_simulator.scenarios import PATTERN_OF, SCENARIOS
from vigil_simulator.world import build_world

START = datetime(2026, 9, 1, tzinfo=UTC)
AT = datetime(2026, 9, 10, 14, 0, tzinfo=UTC)


@pytest.fixture
def world():
    return build_world(21, 200, START, 30)


def fraud_records(records):
    return [r for r in records if r.label.is_fraud]


@pytest.mark.parametrize("name", list(SCENARIOS))
def test_every_scenario_labels_its_fraud(world, name):
    fn, _ = SCENARIOS[name]
    records = fn(world, AT)
    fraud = fraud_records(records)
    assert fraud, name
    for r in fraud:
        assert r.label.scenario == name
        assert r.label.pattern == PATTERN_OF[name]
        assert r.occurred_at >= AT
        if r.label.reported_at:
            assert r.label.reported_at > r.occurred_at
            assert r.label.report_source in {"chargeback", "manual_review"}


def test_card_testing_is_many_tiny_charges_sharing_a_bin(world):
    records = SCENARIOS["card_testing"][0](world, AT)
    assert len(records) >= 6
    assert all(r.transaction["amount_minor"] < 1_000 for r in records)
    assert len({r.transaction["card"]["bin"] for r in records}) == 1
    assert len({r.transaction["card"]["token"] for r in records}) == len(records)
    assert len({r.transaction["device"]["id"] for r in records}) == 1


def test_account_takeover_uses_existing_account_on_new_device(world):
    known_devices = {d.id for c in world.customers for d in c.devices}
    known_customers = {c.id for c in world.customers}
    for r in SCENARIOS["account_takeover"][0](world, AT):
        assert r.transaction["customer"]["id"] in known_customers
        assert r.transaction["device"]["id"] not in known_devices


def test_impossible_travel_is_far_and_fast(world):
    genuine, fraud = SCENARIOS["impossible_travel"][0](world, AT)
    assert not genuine.label.is_fraud and fraud.label.is_fraud
    assert genuine.transaction["customer"]["id"] == fraud.transaction["customer"]["id"]
    a = city_for_ip(genuine.transaction["device"]["ip"])
    b = city_for_ip(fraud.transaction["device"]["ip"])
    minutes = (fraud.occurred_at - genuine.occurred_at).total_seconds() / 60
    assert minutes <= 60
    assert haversine_km(a.lat, a.lon, b.lat, b.lon) > 1_000


def test_promo_abuse_farms_one_code_from_new_accounts(world):
    records = SCENARIOS["promo_abuse"][0](world, AT)
    assert len(records) >= 4
    assert {r.transaction["promo_code"] for r in records} == {"WELCOME10"}
    assert len({r.transaction["customer"]["id"] for r in records}) == len(records)
    assert len({r.transaction["device"]["id"] for r in records}) <= 2


def test_friendly_fraud_looks_like_the_customers_normal_behaviour(world):
    [r] = SCENARIOS["friendly_fraud"][0](world, AT)
    customer = next(c for c in world.customers if c.id == r.transaction["customer"]["id"])
    assert r.transaction["device"]["id"] in {d.id for d in customer.devices}
    assert r.label.report_source == "chargeback"
