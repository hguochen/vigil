import type { Transaction } from "../domain/transaction.js";
import { addressKey, DISPOSABLE_DOMAINS, emailParts, isHeadless, nameTokens } from "./derive.js";
import { haversineKm, type GeoTable } from "./geo.js";
import { HOUR_MS, type Features, type HistorySnapshot } from "./types.js";

const bit = (b: boolean) => (b ? 1 : 0);

/** Pure feature computation. Mirrors ml/src/vigil_ml/features.py::compute_features. */
export function computeFeatures(txn: Transaction, h: HistorySnapshot, geo: GeoTable): Features {
  const t = Date.parse(txn.occurred_at);
  const amountUsd = txn.amount_minor / 100;
  const categories = new Set(txn.items.map((i) => i.category));

  const { local, domain } = emailParts(txn.customer.email);
  const tokens = txn.customer.name ? nameTokens(txn.customer.name) : [];

  const ipCity = geo.cityForIp(txn.device.ip);
  const billing = txn.billing_address;
  const shipping = txn.shipping_address;
  const hasLatLon = (a: typeof billing) => a.lat !== undefined && a.lon !== undefined;

  const customer = h.customer;
  const lastCity = customer ? geo.cityForIp(customer.lastIp) : null;
  let travelSpeed: number | null = null;
  if (customer && ipCity && lastCity) {
    const hours = Math.max((t - customer.lastTs) / HOUR_MS, 1 / 60);
    travelSpeed = haversineKm(lastCity.lat, lastCity.lon, ipCity.lat, ipCity.lon) / hours;
  }
  const avgMinor = customer && customer.count > 0 ? customer.sumMinor / customer.count : 0;

  return {
    amount_usd: amountUsd,
    n_items: txn.items.reduce((n, i) => n + i.quantity, 0),
    max_unit_price_usd: Math.max(...txn.items.map((i) => i.unit_price_minor)) / 100,
    has_electronics: bit(categories.has("electronics")),
    has_gift_cards: bit(categories.has("gift_cards")),
    has_digital_goods: bit(categories.has("digital_goods")),
    promo_code_used: bit(!!txn.promo_code),
    has_order_note: bit(!!txn.order_note),
    hour_of_day: new Date(t).getUTCHours(),
    channel_app: bit(txn.channel === "app"),

    account_age_days: (t - Date.parse(txn.customer.account_created_at)) / (24 * HOUR_MS),
    email_disposable: bit(DISPOSABLE_DOMAINS.has(domain)),
    email_name_match: tokens.length === 0 ? null : bit(tokens.some((tok) => local.includes(tok))),
    ua_headless: bit(isHeadless(txn.device.user_agent)),

    ip_known: bit(ipCity !== null),
    ip_country_matches_billing: ipCity ? bit(ipCity.country === billing.country) : null,
    ip_country_matches_card: ipCity ? bit(ipCity.country === txn.card.country) : null,
    ip_billing_distance_km:
      ipCity && hasLatLon(billing) ? haversineKm(ipCity.lat, ipCity.lon, billing.lat!, billing.lon!) : null,
    billing_shipping_distance_km:
      hasLatLon(billing) && hasLatLon(shipping)
        ? haversineKm(billing.lat!, billing.lon!, shipping.lat!, shipping.lon!)
        : null,
    shipping_matches_billing: bit(addressKey(billing) === addressKey(shipping)),

    card_txn_count_1h: h.cardEvents24h.filter((e) => e.ts >= t - HOUR_MS).length,
    card_txn_count_24h: h.cardEvents24h.length,
    card_amount_usd_24h: h.cardEvents24h.reduce((s, e) => s + e.amountMinor, 0) / 100,
    device_txn_count_1h: h.deviceEvents24h.filter((ts) => ts >= t - HOUR_MS).length,
    device_txn_count_24h: h.deviceEvents24h.length,
    ip_txn_count_1h: h.ipCount1h,
    email_txn_count_24h: h.emailCount24h,
    device_distinct_cards_24h: h.deviceDistinctCards24h,
    device_distinct_accounts_24h: h.deviceDistinctAccounts24h,
    card_distinct_accounts_24h: h.cardDistinctAccounts24h,
    shipping_distinct_accounts_7d: h.shippingDistinctAccounts7d,

    customer_prior_txns: customer?.count ?? 0,
    is_new_device_for_customer: bit(!h.customerHasDevice),
    is_new_card_for_customer: bit(!h.customerHasCard),
    amount_vs_customer_avg: avgMinor > 0 ? amountUsd / (avgMinor / 100) : null,
    card_other_customers: h.cardCustomers.total - (h.cardCustomers.includesCurrent ? 1 : 0),
    minutes_since_last_customer_txn: customer ? (t - customer.lastTs) / 60_000 : null,
    travel_speed_kmh: travelSpeed,
  };
}
