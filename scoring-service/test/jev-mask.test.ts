import { describe, expect, it } from "vitest";
import { computeFeatures } from "../src/features/compute.js";
import { loadGeoTable } from "../src/features/geo.js";
import type { HistorySnapshot } from "../src/features/types.js";
import { buildJevState, redactText } from "../src/jev/mask.js";
import { QUESTIONS } from "../src/jev/questions.js";
import { makeTransaction } from "./fixtures.js";

const geo = loadGeoTable();
const empty: HistorySnapshot = {
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
};

function sensitiveTxn() {
  const txn = makeTransaction({ order_note: "Call me on 415-555-0199 or jane.doe@example.com, gate 4471" });
  txn.device = { id: "dev_secret_9", ip: "100.64.12.34", user_agent: "Mozilla/5.0" };
  txn.billing_address.line1 = "742 Evergreen Terrace";
  txn.shipping_address.line1 = "742 Evergreen Terrace";
  return txn;
}

describe("buildJevState", () => {
  it("never includes personal or payment identifiers", () => {
    const txn = sensitiveTxn();
    const state = JSON.stringify(buildJevState(txn, computeFeatures(txn, empty, geo), geo));
    for (const secret of [
      txn.customer.email,
      "jane.doe",
      txn.customer.name!,
      txn.customer.id,
      txn.card.token,
      txn.card.bin,
      txn.card.last4,
      txn.device.id,
      txn.device.ip,
      "742 Evergreen",
      txn.billing_address.postal_code,
      "415-555-0199",
      "4471",
      txn.transaction_id,
    ]) {
      expect(state, `leaked ${secret}`).not.toContain(secret);
    }
  });

  it("keeps the signals Jev needs", () => {
    const txn = sensitiveTxn();
    const state = buildJevState(txn, computeFeatures(txn, empty, geo), geo);
    expect(state.order.amount_usd).toBe(129.99);
    expect(state.order.items).toEqual([{ category: "electronics", quantity: 1, unit_price_usd: 129.99 }]);
    expect(state.identity.email_domain_type).toBe("other");
    expect(state.identity.name_appears_in_email).toBe(true);
    expect(state.geo.ip_location).toEqual({ city: "Seattle", country: "US" });
    expect(state.history.prior_orders).toBe(0);
    expect(state.order.order_note).toBe("Call me on [number] or [email], gate [number]");
    expect(state).not.toHaveProperty("rule_signals");
  });

  it("includes fired rules when given", () => {
    const txn = makeTransaction();
    const state = buildJevState(txn, computeFeatures(txn, empty, geo), geo, [
      { code: "DISPOSABLE_EMAIL", message: "Disposable email domain tmpbox.net", weight: 0.3, action: null, pattern: null },
    ]);
    expect(state.rule_signals).toEqual([{ code: "DISPOSABLE_EMAIL", detail: "Disposable email domain tmpbox.net" }]);
  });
});

describe("redactText", () => {
  it("keeps short numbers and caps length", () => {
    expect(redactText("Leave at door 2, apt 12")).toBe("Leave at door 2, apt 12");
    expect(redactText("x".repeat(500))).toHaveLength(200);
    expect(redactText("see https://evil.example/x")).toBe("see [url]");
  });
});

describe("QUESTIONS", () => {
  it("offers exactly the API's enums as answers", () => {
    expect(Object.keys(QUESTIONS.fraud_pattern.criteria).sort()).toEqual(
      ["account_takeover", "card_testing", "friendly_fraud", "none", "promo_abuse", "stolen_card"],
    );
    expect(Object.keys(QUESTIONS.action.criteria)).toEqual(["allow", "step_up_3ds", "review", "block"]);
    expect(QUESTIONS.risk_level.criteria.map((c) => c.split(":")[0])).toEqual(["low", "elevated", "high", "critical"]);
  });
});
