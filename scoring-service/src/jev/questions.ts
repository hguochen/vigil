import type { Question } from "@langchain/typesafe";
import { DECISIONS, PATTERNS, RISK_LEVELS } from "../domain/transaction.js";

/** Bump when instructions or criteria change, so stored answers stay attributable. */
export const QUESTION_SET_VERSION = "2026-10-12.1";

const CONTEXT =
  "The state describes one eCommerce checkout for a US online store, with personal data masked. " +
  "`order` is the cart, `identity` the account, `geo` where the buyer and addresses are, " +
  "`velocity` how often this card/device/IP/email was used just before, `history` this customer's past, " +
  "and `rule_signals` (if present) deterministic checks that fired. Missing values (null) mean unknown, not safe.";

export const FRAUD_PATTERN_CRITERIA: Record<(typeof PATTERNS)[number], string> = {
  card_testing:
    "Many tiny charges validating stolen cards: low amounts, digital goods, one device trying several cards, often automated.",
  account_takeover:
    "A real, established account used by someone else: new device, unusual location or impossible travel, shipping redirected, unusually large order.",
  stolen_card:
    "A stolen card used for resellable goods: card linked to other accounts, new or throwaway account, gift cards or electronics, shipping away from billing.",
  friendly_fraud:
    "The genuine customer buying normally who will later dispute the charge; looks legitimate at checkout.",
  promo_abuse:
    "Many new accounts sharing a device or shipping address to reuse a new-customer promo code.",
  none: "No fraud pattern: consistent with this customer's or a typical shopper's normal behaviour.",
};

export const RISK_LEVEL_CRITERIA: Record<(typeof RISK_LEVELS)[number], string> = {
  low: "Nothing unusual, or only harmless oddities such as a gift shipped elsewhere.",
  elevated: "One or two weak warning signs that a legitimate shopper could plausibly explain.",
  high: "Several independent warning signs that together look like fraud.",
  critical: "Clear, strong evidence of an attack in progress.",
};

export const ACTION_CRITERIA: Record<(typeof DECISIONS)[number], string> = {
  allow: "Approve without friction.",
  step_up_3ds: "Approve only after the cardholder passes 3-D Secure authentication.",
  review: "Hold the order for a human fraud analyst.",
  block: "Decline the order outright.",
};

export const QUESTIONS = {
  is_fraud: {
    type: "noul",
    instructions: `${CONTEXT} Is this transaction fraudulent?`,
    criteria: {
      true: "The transaction is fraudulent: the buyer is not the legitimate cardholder/account owner, or is abusing the store.",
      false: "The transaction is a legitimate purchase by the genuine customer.",
    },
  },
  fraud_pattern: {
    type: "choice",
    instructions: `${CONTEXT} Which fraud pattern best describes this transaction?`,
    criteria: FRAUD_PATTERN_CRITERIA,
  },
  risk_level: {
    type: "score",
    instructions: `${CONTEXT} How risky is this transaction?`,
    criteria: RISK_LEVELS.map((level) => `${level}: ${RISK_LEVEL_CRITERIA[level]}`),
  },
  action: {
    type: "choice",
    instructions: `${CONTEXT} What should the store do with this order?`,
    criteria: ACTION_CRITERIA,
  },
} satisfies Record<string, Question>;

export type QuestionId = keyof typeof QUESTIONS;
