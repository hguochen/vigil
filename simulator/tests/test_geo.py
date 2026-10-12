from vigil_simulator.geo import city_for_ip, haversine_km, load_cities


def test_city_table_is_well_formed():
    cities = load_cities()
    assert len(cities) >= 20
    assert len({c.ip_prefix for c in cities}) == len(cities)
    assert any(c.is_domestic for c in cities)
    assert any(not c.is_domestic for c in cities)
    for c in cities:
        first, second = map(int, c.ip_prefix.split("."))
        assert first == 100 and 64 <= second <= 127  # inside 100.64.0.0/10
        assert len(c.country) == 2 and c.country.isupper()


def test_city_for_ip():
    assert city_for_ip("100.64.12.34").name == "Seattle"
    assert city_for_ip("203.0.113.7") is None


def test_haversine():
    assert haversine_km(0, 0, 0, 0) == 0
    seattle_to_london = haversine_km(47.6062, -122.3321, 51.5074, -0.1278)
    assert 7600 < seattle_to_london < 7800
