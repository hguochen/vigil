import type { Transaction } from "../domain/transaction.js";
import { DISPOSABLE_DOMAINS, emailParts } from "../features/derive.js";
import type { GeoTable } from "../features/geo.js";
import type { Features } from "../features/types.js";
import type { RuleHit } from "../rules/engine.js";

const FREE_MAIL = new Set(["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "proton.me", "aol.com"]);
const NOTE_MAX = 200;

/**
 * Removes contact details from free text: emails, URLs and digit runs of
 * 4+ (phone numbers, card numbers, door codes) become placeholders.
 */
export function redactText(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\bhttps?:\/\/\S+/gi, "[url]")
    .replace(/\d[\d\s-]{2,}\d/g, (m) => (m.replace(/\D/g, "").length >= 4 ? "[number]" : m))
    .slice(0, NOTE_MAX);
}

const round = (v: number | null, digits = 2) => (v === null ? null : Number(v.toFixed(digits)));
const flag = (v: number | null) => (v === null ? null : v === 1);

/**
 * Builds the state sent to Jev. Only derived signals and coarse location
 * leave the service: no names, emails, card data, IPs, device ids, street
 * addresses or postal codes.
 */
export function buildJevState(txn: Transaction, f: Features, geo: GeoTable, ruleHits: RuleHit[] = []) {
  const { domain } = emailParts(txn.customer.email);
  const ipCity = geo.cityForIp(txn.device.ip);
  const place = (a: Transaction["billing_address"]) => ({ city: a.city, country: a.country });

  return {
    order: {
      amount_usd: f.amount_usd,
      currency: txn.currency,
      channel: txn.channel,
      hour_utc: f.hour_of_day,
      items: txn.items.map((i) => ({
        category: i.category,
        quantity: i.quantity,
        unit_price_usd: i.unit_price_minor / 100,
      })),
      promo_code: txn.promo_code ?? null,
      order_note: txn.order_note ? redactText(txn.order_note) : null,
    },
    identity: {
      account_age_days: round(f.account_age_days),
      email_domain_type: DISPOSABLE_DOMAINS.has(domain) ? "disposable" : FREE_MAIL.has(domain) ? "free_mail" : "other",
      name_appears_in_email: flag(f.email_name_match),
      automated_browser: flag(f.ua_headless),
    },
    geo: {
      ip_location: ipCity ? { city: ipCity.name, country: ipCity.country } : null,
      card_country: txn.card.country,
      billing: place(txn.billing_address),
      shipping: place(txn.shipping_address),
      shipping_matches_billing: flag(f.shipping_matches_billing),
      ip_to_billing_km: round(f.ip_billing_distance_km, 0),
      billing_to_shipping_km: round(f.billing_shipping_distance_km, 0),
    },
    velocity: {
      card_charges_last_1h: f.card_txn_count_1h,
      card_charges_last_24h: f.card_txn_count_24h,
      card_spend_last_24h_usd: f.card_amount_usd_24h,
      device_orders_last_1h: f.device_txn_count_1h,
      device_orders_last_24h: f.device_txn_count_24h,
      ip_orders_last_1h: f.ip_txn_count_1h,
      email_orders_last_24h: f.email_txn_count_24h,
      cards_on_this_device_24h: f.device_distinct_cards_24h,
      accounts_on_this_device_24h: f.device_distinct_accounts_24h,
      accounts_on_this_card_24h: f.card_distinct_accounts_24h,
      accounts_shipping_to_this_address_7d: f.shipping_distinct_accounts_7d,
    },
    history: {
      prior_orders: f.customer_prior_txns,
      new_device_for_customer: flag(f.is_new_device_for_customer),
      new_card_for_customer: flag(f.is_new_card_for_customer),
      amount_vs_customer_average: round(f.amount_vs_customer_avg),
      other_customers_seen_with_card: f.card_other_customers,
      minutes_since_last_order: round(f.minutes_since_last_customer_txn, 0),
      implied_travel_speed_kmh: round(f.travel_speed_kmh, 0),
    },
    ...(ruleHits.length > 0 && {
      rule_signals: ruleHits.map((h) => ({ code: h.code, detail: h.message })),
    }),
  };
}

export type JevState = ReturnType<typeof buildJevState>;
