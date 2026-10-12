// Feature names in model-input order (contracts/feature_spec.md).
export const FEATURE_NAMES = [
  "amount_usd",
  "n_items",
  "max_unit_price_usd",
  "has_electronics",
  "has_gift_cards",
  "has_digital_goods",
  "promo_code_used",
  "has_order_note",
  "hour_of_day",
  "channel_app",
  "account_age_days",
  "email_disposable",
  "email_name_match",
  "ua_headless",
  "ip_known",
  "ip_country_matches_billing",
  "ip_country_matches_card",
  "ip_billing_distance_km",
  "billing_shipping_distance_km",
  "shipping_matches_billing",
  "card_txn_count_1h",
  "card_txn_count_24h",
  "card_amount_usd_24h",
  "device_txn_count_1h",
  "device_txn_count_24h",
  "ip_txn_count_1h",
  "email_txn_count_24h",
  "device_distinct_cards_24h",
  "device_distinct_accounts_24h",
  "card_distinct_accounts_24h",
  "shipping_distinct_accounts_7d",
  "customer_prior_txns",
  "is_new_device_for_customer",
  "is_new_card_for_customer",
  "amount_vs_customer_avg",
  "card_other_customers",
  "minutes_since_last_customer_txn",
  "travel_speed_kmh",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];
export type Features = Record<FeatureName, number | null>;

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;

/** History relevant to one transaction, read before it is recorded. */
export interface HistorySnapshot {
  /** Prior card transactions in [t - 24h, t). */
  cardEvents24h: { ts: number; amountMinor: number }[];
  /** Timestamps of prior device transactions in [t - 24h, t). */
  deviceEvents24h: number[];
  ipCount1h: number;
  emailCount24h: number;
  deviceDistinctCards24h: number;
  deviceDistinctAccounts24h: number;
  cardDistinctAccounts24h: number;
  shippingDistinctAccounts7d: number;
  customer: { count: number; sumMinor: number; lastTs: number; lastIp: string } | null;
  customerHasDevice: boolean;
  customerHasCard: boolean;
  /** All-time distinct customers seen with the card, and whether the current one is among them. */
  cardCustomers: { total: number; includesCurrent: boolean };
}
