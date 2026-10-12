import { describe, expect, it } from "vitest";
import { computeFeatures } from "../src/features/compute.js";
import { loadGeoTable } from "../src/features/geo.js";
import { RulesEngine } from "../src/rules/engine.js";
import type { Features, HistorySnapshot } from "../src/features/types.js";
import { makeTransaction } from "./fixtures.js";

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
const txn = makeTransaction();
const base = computeFeatures(txn, empty, loadGeoTable());
const withFeatures = (overrides: Partial<Features>): Features => ({ ...base, ...overrides });

const engine = (rulesYaml: string, lists = "") =>
  RulesEngine.fromYaml(`version: 1\n${lists}\nrules:\n${rulesYaml}`);

describe("RulesEngine", () => {
  it("fires rules whose condition holds and renders messages", () => {
    const e = engine(`
  - code: CARD_VELOCITY
    message: "{card_txn_count_1h} charges in 1h, {amount_usd} USD"
    weight: 0.5
    pattern: stolen_card
    when: { feature: card_txn_count_1h, op: ">=", value: 3 }`);
    expect(e.evaluate(txn, withFeatures({ card_txn_count_1h: 2 }))).toEqual([]);
    expect(e.evaluate(txn, withFeatures({ card_txn_count_1h: 4 }))).toEqual([
      { code: "CARD_VELOCITY", message: "4 charges in 1h, 129.99 USD", weight: 0.5, action: null, pattern: "stolen_card" },
    ]);
  });

  it("supports all / any / not", () => {
    const e = engine(`
  - code: COMBO
    message: combo
    weight: 0.3
    when:
      all:
        - { feature: amount_usd, op: ">", value: 100 }
        - any:
            - { feature: email_disposable, op: "==", value: 1 }
            - { feature: ua_headless, op: "==", value: 1 }
        - not: { field: channel, op: "==", value: app }`);
    expect(e.evaluate(txn, withFeatures({ email_disposable: 1 }))).toHaveLength(1);
    expect(e.evaluate(txn, withFeatures({ email_disposable: 0, ua_headless: 0 }))).toHaveLength(0);
    expect(e.evaluate(txn, withFeatures({ amount_usd: 50, ua_headless: 1 }))).toHaveLength(0);
  });

  it("never matches a comparison on an unknown (null) value", () => {
    const e = engine(`
  - code: FOREIGN_IP
    message: foreign
    weight: 0.2
    when: { feature: ip_country_matches_billing, op: "!=", value: 1 }
  - code: NOT_LOW
    message: n
    weight: 0.2
    when: { feature: ip_country_matches_billing, op: not_in, value: [1] }
  - code: UNKNOWN_IP
    message: unknown
    weight: 0.1
    when: { feature: ip_country_matches_billing, op: is_null }`);
    const codes = e.evaluate(txn, withFeatures({ ip_country_matches_billing: null })).map((h) => h.code);
    expect(codes).toEqual(["UNKNOWN_IP"]);
  });

  it("matches lists case-insensitively on transaction fields", () => {
    const e = engine(
      `
  - code: BLOCKED_DOMAIN
    message: "Email domain {email_domain} is blocked"
    action: block
    when: { field: email_domain, op: in_list, list: blocked_email_domains }`,
      "lists:\n  blocked_email_domains: [Example.COM]",
    );
    expect(e.evaluate(txn, base)).toEqual([
      { code: "BLOCKED_DOMAIN", message: "Email domain example.com is blocked", weight: 0, action: "block", pattern: null },
    ]);
  });

  it.each([
    ["unknown feature", `\n  - code: X\n    message: m\n    weight: 0.1\n    when: { feature: nope, op: "==", value: 1 }`],
    ["unknown field", `\n  - code: X\n    message: m\n    weight: 0.1\n    when: { field: card.number, op: "==", value: 1 }`],
    ["no action or weight", `\n  - code: X\n    message: m\n    when: { feature: n_items, op: "==", value: 1 }`],
    ["weight above 1", `\n  - code: X\n    message: m\n    weight: 1.5\n    when: { feature: n_items, op: "==", value: 1 }`],
    ["both feature and field", `\n  - code: X\n    message: m\n    weight: 0.1\n    when: { feature: n_items, field: channel, op: "==", value: 1 }`],
    ["unknown list", `\n  - code: X\n    message: m\n    action: block\n    when: { field: card.token, op: in_list, list: missing }`],
    ["unknown placeholder", `\n  - code: X\n    message: "{secret}"\n    weight: 0.1\n    when: { feature: n_items, op: "==", value: 1 }`],
    ["duplicate code", `\n  - code: X\n    message: m\n    weight: 0.1\n    when: { feature: n_items, op: "==", value: 1 }\n  - code: X\n    message: m\n    weight: 0.1\n    when: { feature: n_items, op: "==", value: 1 }`],
  ])("rejects a rules file with %s", (_name, rules) => {
    expect(() => engine(rules)).toThrow();
  });
});
