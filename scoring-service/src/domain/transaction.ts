import { z } from "zod";

// Mirrors contracts/openapi.yaml. Objects are strict so unexpected fields
// (e.g. a raw card number) are rejected rather than silently stored.

const countryCode = z.string().regex(/^[A-Z]{2}$/);
const minorUnits = z.number().int().nonnegative();
const id = z.string().min(1).max(128);

export const AddressSchema = z.strictObject({
  line1: z.string().max(200).optional(),
  city: z.string().max(100),
  region: z.string().max(100).optional(),
  postal_code: z.string().max(20),
  country: countryCode,
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
});

export const LineItemSchema = z.strictObject({
  sku: z.string().max(64),
  name: z.string().max(200).optional(),
  category: z.string().max(64),
  quantity: z.number().int().min(1),
  unit_price_minor: minorUnits,
});

export const TransactionSchema = z.strictObject({
  transaction_id: id,
  occurred_at: z.iso.datetime({ offset: true }),
  amount_minor: minorUnits,
  currency: z.string().regex(/^[A-Z]{3}$/),
  channel: z.enum(["web", "app"]),
  promo_code: z.string().max(64).optional(),
  order_note: z.string().max(1000).optional(),
  customer: z.strictObject({
    id,
    email: z.email(),
    name: z.string().max(200).optional(),
    account_created_at: z.iso.datetime({ offset: true }),
  }),
  card: z.strictObject({
    token: id,
    bin: z.string().regex(/^[0-9]{6,8}$/),
    last4: z.string().regex(/^[0-9]{4}$/),
    country: countryCode,
  }),
  device: z.strictObject({
    id,
    ip: z.union([z.ipv4(), z.ipv6()]),
    user_agent: z.string().max(512).optional(),
  }),
  billing_address: AddressSchema,
  shipping_address: AddressSchema,
  items: z.array(LineItemSchema).min(1).max(100),
});

export type Transaction = z.infer<typeof TransactionSchema>;

export const DECISIONS = ["allow", "step_up_3ds", "review", "block"] as const;
export const PATTERNS = [
  "card_testing",
  "account_takeover",
  "stolen_card",
  "friendly_fraud",
  "promo_abuse",
  "none",
] as const;
export const RISK_LEVELS = ["low", "elevated", "high", "critical"] as const;
export const STRATEGIES = ["passthrough", "rules", "xgboost", "jev", "jev_rules"] as const;

export type Decision = (typeof DECISIONS)[number];
export type Pattern = (typeof PATTERNS)[number];
export type RiskLevel = (typeof RISK_LEVELS)[number];
export type Strategy = (typeof STRATEGIES)[number];

export interface Reason {
  code: string;
  message: string;
}

export interface ScoreResponse {
  transaction_id: string;
  decision: Decision;
  fraud_probability: number | null;
  pattern: Pattern | null;
  risk_level: RiskLevel | null;
  reasons: Reason[];
  strategy: Strategy;
  latency_ms: number;
  scored_at: string;
}
