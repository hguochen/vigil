import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { loadGeoTable } from "../src/features/geo.js";
import { createScorer } from "../src/scoring/factory.js";
import { makeTransaction } from "./fixtures.js";
import { computeFeatures } from "../src/features/compute.js";
import { ok, stubFetch } from "./jev-stub.js";
import type { HistorySnapshot } from "../src/features/types.js";

const geo = loadGeoTable();

describe("createScorer", () => {
  it.each(["passthrough", "rules"] as const)("builds %s without a Jev key", (s) => {
    expect(createScorer(loadConfig({ SCORING_STRATEGY: s }), { geo }).strategy).toBe(s);
  });

  it.each(["jev", "jev_rules"] as const)("refuses %s without a Jev key", (s) => {
    expect(() => createScorer(loadConfig({ SCORING_STRATEGY: s }), { geo })).toThrow(/TYPESAFE_API_KEY/);
  });

  it("wires a working jev_rules scorer end to end through the SDK", async () => {
    const stub = stubFetch(ok({ isFraud: 0.12, pattern: "none", risk: "low", action: "allow" }));
    const scorer = createScorer(
      loadConfig({ SCORING_STRATEGY: "jev_rules", TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: "https://jev.test", JEV_MODEL: "jev-x" }),
      { geo, fetch: stub.fetch },
    );
    const txn = makeTransaction();
    const empty = { cardEvents24h: [], deviceEvents24h: [], ipCount1h: 0, emailCount24h: 0, deviceDistinctCards24h: 0, deviceDistinctAccounts24h: 0, cardDistinctAccounts24h: 0, shippingDistinctAccounts7d: 0, customer: null, customerHasDevice: false, customerHasCard: false, cardCustomers: { total: 0, includesCurrent: false } } satisfies HistorySnapshot;
    const r = await scorer.score(txn, computeFeatures(txn, empty, geo));
    expect(r).toMatchObject({ decision: "allow", fraud_probability: 0.12 });
    expect(stub.calls[0]!.url).toBe("https://jev.test/v1/systemone");
    expect(stub.calls[0]!.body.model).toBe("jev-x");
  });
});
