import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DecisionPolicy } from "../src/decision/policy.js";
import { computeFeatures } from "../src/features/compute.js";
import { loadGeoTable } from "../src/features/geo.js";
import { FEATURE_NAMES, type Features, type HistorySnapshot } from "../src/features/types.js";
import { toInputRow, XgbScorer } from "../src/scoring/xgb-scorer.js";
import { makeTransaction } from "./fixtures.js";

const TINY = fileURLToPath(new URL("./fixtures/xgb-tiny", import.meta.url));
const policy = DecisionPolicy.load();
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
const txn = makeTransaction(); // 129.99 USD
const base = computeFeatures(txn, empty, geo);
const withF = (o: Partial<Features>): Features => ({ ...base, ...o });

describe("XgbScorer", () => {
  it("runs the ONNX model and maps the probability through the policy", async () => {
    const scorer = await XgbScorer.load(policy, TINY);
    const high = await scorer.score(txn, base); // amount >= 100 -> 0.95
    expect(high.fraud_probability).toBeCloseTo(0.95, 5);
    expect(high).toMatchObject({ decision: "block", risk_level: "critical", pattern: null });
    expect(high.reasons).toEqual([{ code: "XGB_SCORE", message: "Model tiny-fixture: 95% fraud probability" }]);

    const low = await scorer.score(txn, withF({ amount_usd: 20 }));
    expect(low.fraud_probability).toBeCloseTo(0.1, 5);
    expect(low).toMatchObject({ decision: "allow", risk_level: "low" });
  });

  it("sends nulls as NaN, which the model treats as missing", async () => {
    expect(Number.isNaN(toInputRow(withF({ amount_vs_customer_avg: null }))[FEATURE_NAMES.indexOf("amount_vs_customer_avg")])).toBe(true);
    const scorer = await XgbScorer.load(policy, TINY);
    // the fixture routes a missing amount down the "< 100" branch
    expect(await scorer.predict(withF({ amount_usd: null }))).toBeCloseTo(0.1, 5);
  });

  it("refuses a model trained on a different feature list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xgb-"));
    cpSync(TINY, dir, { recursive: true });
    const schemaPath = join(dir, "feature_schema.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    schema.feature_names = schema.feature_names.filter((n: string) => n !== "travel_speed_kmh").concat("legacy_feature");
    writeFileSync(schemaPath, JSON.stringify(schema));
    await expect(XgbScorer.load(policy, dir)).rejects.toThrow(/missing: travel_speed_kmh; unexpected: legacy_feature/);
  });

  it("refuses a model with the right features in a different order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xgb-"));
    cpSync(TINY, dir, { recursive: true });
    const schemaPath = join(dir, "feature_schema.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    schema.feature_names.reverse();
    writeFileSync(schemaPath, JSON.stringify(schema));
    await expect(XgbScorer.load(policy, dir)).rejects.toThrow(/different order/);
  });
});
