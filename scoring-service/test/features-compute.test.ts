import { describe, expect, it } from "vitest";
import { computeFeatures } from "../src/features/compute.js";
import { addressKey, isHeadless, nameTokens } from "../src/features/derive.js";
import { haversineKm, loadGeoTable } from "../src/features/geo.js";
import { FEATURE_NAMES, HOUR_MS as HOUR, type HistorySnapshot } from "../src/features/types.js";
import { makeTransaction } from "./fixtures.js";

const geo = loadGeoTable();
const T = Date.parse("2026-10-11T18:30:00Z");

const empty = (): HistorySnapshot => ({
  cardEvents24h: [],
  deviceEvents24h: [],
  ipCount1h: 0,
  emailCount24h: 0,
  deviceDistinctCards24h: 0,
  deviceDistinctAccounts24h: 0,
  cardDistinctAccounts24h: 0,
  shippingDistinctAccounts7d: 0,
  customer: null,
  customerHasDevice: false,
  customerHasCard: false,
  cardCustomers: { total: 0, includesCurrent: false },
});

// Seattle IP block from contracts/geo_cities.csv
const seattleTxn = () => {
  const txn = makeTransaction();
  txn.device.ip = "100.64.1.2";
  return txn;
};

describe("derivations", () => {
  it("normalizes address keys and strips one unit suffix", () => {
    const base = { postal_code: "98101", country: "US" };
    expect(addressKey({ ...base, line1: "  12 Oak   Ave Apt 4 " })).toBe("US|98101|12 oak ave");
    expect(addressKey({ ...base, line1: "12 Oak Ave # 4" })).toBe("US|98101|12 oak ave");
    expect(addressKey({ ...base, line1: "12 Oak Ave Unit 7" })).toBe(addressKey({ ...base, line1: "12 oak ave" }));
    expect(addressKey(base)).toBe("US|98101|");
  });

  it("folds accents in name tokens", () => {
    expect(nameTokens("Jürgen Müller-O")).toEqual(["jurgen", "muller"]);
  });

  it("detects headless user agents", () => {
    expect(isHeadless("Mozilla/5.0 HeadlessChrome/129.0")).toBe(true);
    expect(isHeadless("python-requests/2.32")).toBe(true);
    expect(isHeadless("Mozilla/5.0 (iPhone)")).toBe(false);
    expect(isHeadless(undefined)).toBe(false);
  });

  it("geolocates only known IPv4 prefixes", () => {
    expect(geo.cityForIp("100.78.0.1")?.name).toBe("London");
    expect(geo.cityForIp("203.0.113.7")).toBeNull();
    expect(geo.cityForIp("2001:db8::1")).toBeNull();
    expect(haversineKm(47.6062, -122.3321, 51.5074, -0.1278)).toBeCloseTo(7699.56, 1);
  });
});

describe("computeFeatures", () => {
  it("emits every feature in spec order", () => {
    expect(Object.keys(computeFeatures(seattleTxn(), empty(), geo))).toEqual([...FEATURE_NAMES]);
  });

  it("computes transaction, identity and geo features for a first purchase", () => {
    const f = computeFeatures(seattleTxn(), empty(), geo);
    expect(f).toMatchObject({
      amount_usd: 129.99,
      n_items: 1,
      max_unit_price_usd: 129.99,
      has_electronics: 1,
      hour_of_day: 18,
      channel_app: 0,
      email_disposable: 0,
      email_name_match: 1, // "jane" in "jane.doe"
      ua_headless: 0,
      ip_known: 1,
      ip_country_matches_billing: 1,
      ip_country_matches_card: 1,
      shipping_matches_billing: 1,
      billing_shipping_distance_km: 0,
      customer_prior_txns: 0,
      is_new_device_for_customer: 1,
      is_new_card_for_customer: 1,
      amount_vs_customer_avg: null,
      minutes_since_last_customer_txn: null,
      travel_speed_kmh: null,
    });
    expect(f.account_age_days).toBeCloseTo(954.35, 2);
    expect(f.ip_billing_distance_km!).toBeLessThan(1);
  });

  it("returns nulls for unknown IPs and missing coordinates", () => {
    const txn = makeTransaction(); // 203.0.113.7 is not in the geo table
    delete txn.shipping_address.lat;
    const f = computeFeatures(txn, empty(), geo);
    expect(f.ip_known).toBe(0);
    expect(f.ip_country_matches_billing).toBeNull();
    expect(f.ip_billing_distance_km).toBeNull();
    expect(f.billing_shipping_distance_km).toBeNull();
  });

  it("returns null name match when the name is absent", () => {
    const txn = seattleTxn();
    delete txn.customer.name;
    expect(computeFeatures(txn, empty(), geo).email_name_match).toBeNull();
  });

  it("derives velocity and profile features from history", () => {
    const h: HistorySnapshot = {
      ...empty(),
      cardEvents24h: [
        { ts: T - 30 * 60_000, amountMinor: 100 },
        { ts: T - 5 * HOUR, amountMinor: 250 },
      ],
      deviceEvents24h: [T - 10 * 60_000, T - 2 * 60_000, T - 20 * HOUR],
      ipCount1h: 4,
      customer: { count: 4, sumMinor: 20_000, lastTs: T - 30 * 60_000, lastIp: "100.78.9.9" }, // London
      customerHasDevice: true,
      customerHasCard: true,
      cardCustomers: { total: 3, includesCurrent: true },
    };
    const f = computeFeatures(seattleTxn(), h, geo);
    expect(f).toMatchObject({
      card_txn_count_1h: 1,
      card_txn_count_24h: 2,
      card_amount_usd_24h: 3.5,
      device_txn_count_1h: 2,
      device_txn_count_24h: 3,
      ip_txn_count_1h: 4,
      customer_prior_txns: 4,
      is_new_device_for_customer: 0,
      card_other_customers: 2,
      minutes_since_last_customer_txn: 30,
    });
    expect(f.amount_vs_customer_avg).toBeCloseTo(129.99 / 50, 9);
    // London -> Seattle (~7700 km) in 30 minutes
    expect(f.travel_speed_kmh!).toBeCloseTo(7699.56 * 2, 0);
  });

  it("floors elapsed time at one minute for travel speed", () => {
    const h: HistorySnapshot = {
      ...empty(),
      customer: { count: 1, sumMinor: 100, lastTs: T, lastIp: "100.78.9.9" },
    };
    expect(computeFeatures(seattleTxn(), h, geo).travel_speed_kmh!).toBeCloseTo(7699.56 * 60, -1);
  });
});
