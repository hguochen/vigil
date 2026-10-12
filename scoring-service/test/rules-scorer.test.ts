import { describe, expect, it } from "vitest";
import { DecisionPolicy } from "../src/decision/policy.js";
import { FeatureExtractor } from "../src/features/extractor.js";
import { loadGeoTable } from "../src/features/geo.js";
import { InMemoryFeatureStore } from "../src/features/store.js";
import { RulesEngine } from "../src/rules/engine.js";
import { RulesScorer } from "../src/scoring/rules-scorer.js";
import type { Transaction } from "../src/domain/transaction.js";
import { makeTransaction } from "./fixtures.js";

const scorer = new RulesScorer(RulesEngine.load(), DecisionPolicy.load());

async function scoreStream(txns: Transaction[]) {
  const extractor = new FeatureExtractor(new InMemoryFeatureStore(), loadGeoTable());
  const results = [];
  for (const txn of txns) {
    results.push(await scorer.score(txn, await extractor.extract(txn)));
    await extractor.record(txn);
  }
  return results;
}

describe("RulesScorer with config/rules.yaml", () => {
  it("loads the shipped ruleset", () => {
    expect(RulesEngine.load().rules.length).toBeGreaterThan(15);
  });

  it("allows an ordinary domestic purchase", async () => {
    const txn = makeTransaction();
    txn.device.ip = "100.64.3.4"; // Seattle
    const [result] = await scoreStream([txn]);
    expect(result).toMatchObject({ decision: "allow", fraud_probability: 0, pattern: "none", reasons: [] });
  });

  it("blocks a card-testing burst from a headless device", async () => {
    const txns = Array.from({ length: 7 }, (_, i) => {
      const t = makeTransaction({
        transaction_id: `ct_${i}`,
        occurred_at: new Date(Date.parse("2026-10-11T03:00:00Z") + i * 40_000).toISOString(),
        amount_minor: 149,
        items: [{ sku: "DIG-0001", category: "digital_goods", quantity: 1, unit_price_minor: 149 }],
      });
      t.card = { token: `stolen_${i}`, bin: "511111", last4: String(1000 + i), country: "US" };
      t.device = { id: "bot", ip: "100.84.1.1", user_agent: "HeadlessChrome/129" };
      t.customer.email = "x7k2m9@tmpbox.net";
      return t;
    });
    const results = await scoreStream(txns);
    expect(results[0]!.decision).not.toBe("block");
    const last = results.at(-1)!;
    expect(last).toMatchObject({ decision: "block", pattern: "card_testing", risk_level: "critical", fraud_probability: 1 });
    expect(last.reasons[0]!.code).toBe("CARD_TESTING_BURST");
    expect(last.reasons[0]!.message).toBe("6 different cards tried from this device in 24h on a 1.49 USD order");
    expect((last.raw as { rule_hits: unknown[] }).rule_hits.length).toBe(last.reasons.length);
  });

  it("flags impossible travel on an existing account", async () => {
    const home = makeTransaction({ transaction_id: "home" });
    home.device.ip = "100.64.3.4"; // Seattle
    const away = makeTransaction({ transaction_id: "away", occurred_at: "2026-10-11T18:50:00Z", amount_minor: 89_900 });
    away.device = { id: "new_dev", ip: "100.84.9.9", user_agent: "Mozilla/5.0" }; // Lagos
    away.shipping_address = { city: "Lagos", postal_code: "100001", country: "NG", lat: 6.52, lon: 3.38 };
    const [, result] = await scoreStream([home, away]);
    expect(result!.pattern).toBe("account_takeover");
    expect(["review", "block"]).toContain(result!.decision);
    expect(result!.reasons.map((r) => r.code)).toEqual(
      expect.arrayContaining(["IMPOSSIBLE_TRAVEL", "NEW_DEVICE_FOREIGN_IP", "NEW_DEVICE_NEW_SHIPPING_HIGH_VALUE"]),
    );
  });
});
