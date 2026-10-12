# Feature Spec (v1)

Single source of truth for the features computed by the scoring service
(`scoring-service/src/features/`) and the Python training pipeline
(`ml/src/vigil_ml/features.py`). Both implementations must agree on
`contracts/golden/features.json`.

## Conventions

- **Event time.** `t` is the transaction's `occurred_at` in epoch milliseconds. Wall-clock time is never used, so replays are deterministic.
- **Windows are `[t - W, t)`.** The lower bound is inclusive and the upper bound exclusive, so a transaction never counts itself.
- **Extract, then record.** Features are computed from history *before* the current transaction is recorded. A duplicate submission (an idempotent retry) is never recorded twice.
- **Distinct counts** store, for each distinct value, the latest time it was seen. A value counts toward a window if that latest time falls inside the window. This assumes transactions arrive roughly in time order.
- **Profile features** (all-time per-customer and per-card state) count every transaction recorded so far, in processing order.
- **Nulls.** `null` means "unknown / not applicable". It is never replaced with 0. Booleans are encoded as `0`/`1`.
- **Money** is in US dollars (`amount_minor / 100`).
- **Distances** use the haversine formula with Earth radius 6371.0 km.
- **Floats** must agree to an absolute tolerance of `1e-6`.

## Shared derivations

- **IP geolocation.** The first two octets of an IPv4 address are matched against `ip_prefix` in `contracts/geo_cities.csv`. Anything else (including IPv6) is unknown.
- **Address key.** `country|postal_code|norm(line1)`, where `norm` lowercases and trims the text, removes one trailing unit suffix matching `\s+(apt|unit|suite|ste|#)\s*\S*$` (case-insensitive), and collapses internal whitespace to single spaces. A missing `line1` becomes the empty string.
- **Name tokens.** NFKD normalization, combining marks removed, lowercased, split on any character that isn't `a-z`; tokens shorter than 2 characters are dropped.
- **Headless user agent.** The UA contains, case-insensitively, `headless`, `python-requests`, `curl`, `wget`, `phantomjs` or `selenium`.
- **Disposable email domains:** `quickinbox.io`, `tmpbox.net`, `mailnow.xyz`, `burnr.email`.

## Features

### Transaction and cart
| Name | Type | Definition |
|---|---|---|
| `amount_usd` | float | `amount_minor / 100` |
| `n_items` | int | Sum of item quantities |
| `max_unit_price_usd` | float | Max `unit_price_minor / 100` over items |
| `has_electronics` | 0/1 | Any item with category `electronics` |
| `has_gift_cards` | 0/1 | Any item with category `gift_cards` |
| `has_digital_goods` | 0/1 | Any item with category `digital_goods` |
| `promo_code_used` | 0/1 | `promo_code` present and non-empty |
| `has_order_note` | 0/1 | `order_note` present and non-empty |
| `hour_of_day` | int | UTC hour of `occurred_at` (0–23) |
| `channel_app` | 0/1 | `channel == "app"` |

### Identity
| Name | Type | Definition |
|---|---|---|
| `account_age_days` | float | `(t - account_created_at) / 86_400_000`; may be negative if the data is bad |
| `email_disposable` | 0/1 | Email domain (lowercased) is in the disposable list |
| `email_name_match` | 0/1/null | null if `customer.name` is absent or has no tokens; otherwise 1 if any name token is a substring of the lowercased email local part |
| `ua_headless` | 0/1 | User agent matches the headless rule (0 if absent) |

### Geography
| Name | Type | Definition |
|---|---|---|
| `ip_known` | 0/1 | The IP resolves to a city |
| `ip_country_matches_billing` | 0/1/null | null if the IP is unknown |
| `ip_country_matches_card` | 0/1/null | null if the IP is unknown |
| `ip_billing_distance_km` | float/null | IP city to billing lat/lon; null if the IP is unknown or billing has no lat/lon |
| `billing_shipping_distance_km` | float/null | null if either address has no lat/lon |
| `shipping_matches_billing` | 0/1 | The address keys are equal |

### Velocity (window `[t - W, t)`)
| Name | Type | Definition |
|---|---|---|
| `card_txn_count_1h` | int | Prior transactions with this `card.token` |
| `card_txn_count_24h` | int | " |
| `card_amount_usd_24h` | float | Sum of `amount_usd` of those prior card transactions (24h) |
| `device_txn_count_1h` | int | Prior transactions with this `device.id` |
| `device_txn_count_24h` | int | " |
| `ip_txn_count_1h` | int | Prior transactions with this `device.ip` |
| `email_txn_count_24h` | int | Prior transactions with this lowercased `customer.email` |
| `device_distinct_cards_24h` | int | Distinct card tokens seen on this device |
| `device_distinct_accounts_24h` | int | Distinct customer ids seen on this device |
| `card_distinct_accounts_24h` | int | Distinct customer ids seen with this card |
| `shipping_distinct_accounts_7d` | int | Distinct customer ids seen with this shipping address key |

The distinct counts cover prior transactions only, so the current customer counts only if they were seen earlier in the window.

### Customer profile (all-time, prior transactions)
| Name | Type | Definition |
|---|---|---|
| `customer_prior_txns` | int | Prior transactions recorded for `customer.id` |
| `is_new_device_for_customer` | 0/1 | `device.id` never recorded for this customer |
| `is_new_card_for_customer` | 0/1 | `card.token` never recorded for this customer |
| `amount_vs_customer_avg` | float/null | `amount_usd / (prior sum / prior count)`; null with no prior transactions or a zero average |
| `card_other_customers` | int | Distinct customers other than the current one ever recorded with this card |
| `minutes_since_last_customer_txn` | float/null | `(t - last_t) / 60_000`; null with no prior transactions |
| `travel_speed_kmh` | float/null | Distance from the IP city of the customer's last transaction to the current IP city, divided by `max(elapsed_hours, 1/60)`; null if there is no prior transaction or either IP is unknown |

Feature order (used for model input) is the order of the tables above.

## Retention (Redis)
- Velocity and distinct structures are trimmed to 7 days on write and expire after 8 days of inactivity.
- Customer and card profiles expire after 400 days of inactivity.
