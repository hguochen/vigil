import copy

import pytest
from vigil_ml.features import (
    FEATURE_NAMES,
    CustomerProfile,
    HistorySnapshot,
    InMemoryFeatureStore,
    address_key,
    compute_features,
    epoch_ms,
    is_headless,
    name_tokens,
    stream_features,
)

T = epoch_ms("2026-10-11T18:30:00Z")
HOUR = 3_600_000
SEATTLE_TO_LONDON_KM = 7699.56


def make_txn(**overrides):
    txn = {
        "transaction_id": "txn_001",
        "occurred_at": "2026-10-11T18:30:00Z",
        "amount_minor": 12999,
        "currency": "USD",
        "channel": "web",
        "customer": {
            "id": "cust_42",
            "email": "jane.doe@example.com",
            "name": "Jane Doe",
            "account_created_at": "2024-03-01T10:00:00Z",
        },
        "card": {"token": "tok_abc123", "bin": "424242", "last4": "4242", "country": "US"},
        "device": {"id": "dev_9", "ip": "100.64.1.2", "user_agent": "Mozilla/5.0"},
        "billing_address": {"city": "Seattle", "postal_code": "98101", "country": "US",
                            "lat": 47.61, "lon": -122.33},
        "shipping_address": {"city": "Seattle", "postal_code": "98101", "country": "US",
                             "lat": 47.61, "lon": -122.33},
        "items": [{"sku": "SKU-1", "name": "Headphones", "category": "electronics",
                   "quantity": 1, "unit_price_minor": 12999}],
    }
    txn.update(overrides)
    return txn


def test_epoch_ms_is_exact():
    assert epoch_ms("1970-01-01T00:00:01.234Z") == 1234
    assert epoch_ms("2026-10-11T18:30:00+00:00") == T


def test_derivations_match_spec():
    base = {"postal_code": "98101", "country": "US"}
    assert address_key({**base, "line1": "  12 Oak   Ave Apt 4 "}) == "US|98101|12 oak ave"
    assert address_key({**base, "line1": "12 Oak Ave # 4"}) == "US|98101|12 oak ave"
    assert address_key(base) == "US|98101|"
    assert name_tokens("Jürgen Müller-O") == ["jurgen", "muller"]
    assert is_headless("python-requests/2.32") and not is_headless(None)


def test_first_purchase():
    f = compute_features(make_txn(), HistorySnapshot())
    assert list(f) == FEATURE_NAMES
    assert f["amount_usd"] == 129.99 and f["has_electronics"] == 1 and f["hour_of_day"] == 18
    assert f["email_name_match"] == 1 and f["ip_known"] == 1
    assert f["ip_country_matches_billing"] == 1 and f["shipping_matches_billing"] == 1
    assert f["customer_prior_txns"] == 0 and f["is_new_device_for_customer"] == 1
    assert f["amount_vs_customer_avg"] is None and f["travel_speed_kmh"] is None
    assert f["account_age_days"] == pytest.approx(954.35, abs=0.01)


def test_unknown_ip_and_ipv6_are_null_geo():
    for ip in ("203.0.113.7", "2001:db8::1"):
        txn = make_txn()
        txn["device"]["ip"] = ip
        f = compute_features(txn, HistorySnapshot())
        assert f["ip_known"] == 0 and f["ip_country_matches_billing"] is None


def test_history_features():
    h = HistorySnapshot(
        card_events_24h=[(T - 30 * 60_000, 100), (T - 5 * HOUR, 250)],
        device_events_24h=[T - 10 * 60_000, T - 2 * 60_000, T - 20 * HOUR],
        ip_count_1h=4,
        customer=CustomerProfile(count=4, sum_minor=20_000, last_ts=T - 30 * 60_000,
                                 last_ip="100.78.9.9"),
        customer_has_device=True,
        customer_has_card=True,
        card_customers_total=3,
        card_customers_includes_current=True,
    )
    f = compute_features(make_txn(), h)
    assert f["card_txn_count_1h"] == 1 and f["card_txn_count_24h"] == 2
    assert f["card_amount_usd_24h"] == 3.5
    assert f["device_txn_count_1h"] == 2 and f["device_txn_count_24h"] == 3
    assert f["card_other_customers"] == 2 and f["minutes_since_last_customer_txn"] == 30
    assert f["amount_vs_customer_avg"] == pytest.approx(129.99 / 50)
    assert f["travel_speed_kmh"] == pytest.approx(SEATTLE_TO_LONDON_KM * 2, abs=1)


def test_store_windows_and_profile():
    store = InMemoryFeatureStore()
    first = make_txn(occurred_at="2026-10-11T12:00:00Z", amount_minor=100)
    store.record(first)
    exactly_24h = make_txn(occurred_at="2026-10-12T12:00:00Z")
    assert len(store.snapshot(exactly_24h).card_events_24h) == 1
    just_after = make_txn(occurred_at="2026-10-12T12:00:00.001Z")
    assert store.snapshot(just_after).card_events_24h == []
    same_time = make_txn(occurred_at="2026-10-11T12:00:00Z")
    assert store.snapshot(same_time).device_events_24h == []
    assert store.snapshot(exactly_24h).customer.count == 1


def test_stream_extracts_before_recording():
    a = make_txn()
    b = copy.deepcopy(a)
    b["transaction_id"], b["occurred_at"] = "txn_002", "2026-10-11T18:40:00Z"
    fa, fb = stream_features([a, b])
    assert fa["customer_prior_txns"] == 0
    assert fb["customer_prior_txns"] == 1 and fb["minutes_since_last_customer_txn"] == 10
