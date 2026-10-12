import { describe, expect, it, vi } from "vitest";
import { DecisionPolicy } from "../src/decision/policy.js";
import { computeFeatures } from "../src/features/compute.js";
import { loadGeoTable } from "../src/features/geo.js";
import type { Features, HistorySnapshot } from "../src/features/types.js";
import type { JevClient, JevVerdict } from "../src/jev/client.js";
import type { JevState } from "../src/jev/mask.js";
import { RulesEngine } from "../src/rules/engine.js";
import { JevScorer } from "../src/scoring/jev-scorer.js";
import type { Decision, Pattern, RiskLevel } from "../src/domain/transaction.js";
import { makeTransaction } from "./fixtures.js";

const geo = loadGeoTable();
const policy = DecisionPolicy.load();
const engine = RulesEngine.load();
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

const verdict = (p: number, action: Decision, actionConfidence = 0.8, pattern: Pattern = "stolen_card", risk: RiskLevel = "high"): JevVerdict => ({
  fraudProbability: p,
  pattern: { label: pattern, confidence: 0.7, probabilities: {} },
  riskLevel: { label: risk, confidence: 0.8, probabilities: {} },
  action: { label: action, confidence: actionConfidence, probabilities: {} },
  model: "jev-1",
  requestId: "req_1",
  usage: { inputTokens: 800, outputTokens: 4 },
  latencyMs: 120,
  questionSetVersion: "test",
});

const stubClient = (v: JevVerdict | Error) => {
  const classify = vi.fn(async (_state: JevState) => {
    if (v instanceof Error) throw v;
    return v;
  });
  return { client: { classify } satisfies JevClient, classify };
};

const txn = makeTransaction();
txn.device.ip = "100.64.3.4"; // Seattle: clean
const clean = computeFeatures(txn, empty, geo);
const withF = (o: Partial<Features>): Features => ({ ...clean, ...o });

describe("DecisionPolicy.decideJev", () => {
  it.each([
    [0.1, "allow", 0.9, "allow"],
    [0.4, "allow", 0.9, "step_up_3ds"],
    [0.7, "review", 0.9, "review"],
    [0.95, "block", 0.9, "block"],
    [0.95, "review", 0.9, "review"], // block needs agreement
    [0.95, "block", 0.3, "review"], // ...with confidence
    [0.2, "block", 0.9, "review"], // confident block vs low probability: a human decides
    [0.2, "step_up_3ds", 0.9, "step_up_3ds"],
    [0.2, "review", 0.4, "allow"], // unconfident advice is ignored
  ] as const)("p=%s action=%s conf=%s -> %s", (p, action, conf, expected) => {
    expect(policy.decideJev(verdict(p, action, conf)).decision).toBe(expected);
  });

  it("reports Jev's pattern, risk level and an explanation", () => {
    const out = policy.decideJev(verdict(0.93, "block", 0.81, "account_takeover", "critical"));
    expect(out).toMatchObject({ score: 0.93, pattern: "account_takeover", riskLevel: "critical" });
    expect(out.reasons).toEqual([
      { code: "JEV_ASSESSMENT", message: "Jev: 93% fraud probability, pattern account_takeover (70%), recommends block (81%)" },
    ]);
  });
});

describe("JevScorer (jev)", () => {
  it("decides from Jev and stores the verdict", async () => {
    const { client, classify } = stubClient(verdict(0.95, "block"));
    const r = await new JevScorer("jev", { client, engine, policy, geo }).score(txn, clean);
    expect(r).toMatchObject({ decision: "block", fraud_probability: 0.95, pattern: "stolen_card", risk_level: "high" });
    expect(r.raw).toMatchObject({ tier: "jev", jev: { requestId: "req_1" } });
    expect(classify.mock.calls[0]![0]).not.toHaveProperty("rule_signals");
  });

  it("falls back to rules when Jev fails", async () => {
    const onJevError = vi.fn();
    const { client } = stubClient(new Error("timeout"));
    const r = await new JevScorer("jev", { client, engine, policy, geo, onJevError }).score(
      txn,
      withF({ travel_speed_kmh: 5_000, ua_headless: 1 }),
    );
    expect(r.reasons[0]!.code).toBe("JEV_UNAVAILABLE");
    expect(r.reasons.map((x) => x.code)).toContain("IMPOSSIBLE_TRAVEL");
    expect(r.decision).toBe("block"); // rules alone: 1 - (1 - 0.7)(1 - 0.5) = 0.85
    expect(r.raw).toMatchObject({ tier: "fallback", error: "Error: timeout" });
    expect(onJevError).toHaveBeenCalledOnce();
  });

  it("on_error: review sends at least to review", async () => {
    const strict = new DecisionPolicy({ ...policy.config, jev: { ...policy.config.jev, on_error: "review" } });
    const { client } = stubClient(new Error("down"));
    const r = await new JevScorer("jev", { client, engine, policy: strict, geo }).score(txn, clean);
    expect(r.decision).toBe("review");
  });
});

describe("JevScorer (jev_rules)", () => {
  it("lets hard rules decide without calling Jev", async () => {
    const { client, classify } = stubClient(verdict(0.01, "allow"));
    const r = await new JevScorer("jev_rules", { client, engine, policy, geo }).score(
      txn,
      withF({ device_distinct_cards_24h: 8, amount_usd: 1.5 }),
    );
    expect(classify).not.toHaveBeenCalled();
    expect(r).toMatchObject({ decision: "block", pattern: "card_testing" });
    expect(r.raw).toMatchObject({ tier: "rules_hard" });
  });

  it("passes fired rules to Jev as evidence and lists both explanations", async () => {
    const { client, classify } = stubClient(verdict(0.2, "allow", 0.9, "none", "low"));
    const r = await new JevScorer("jev_rules", { client, engine, policy, geo }).score(txn, withF({ email_disposable: 1 }));
    expect(classify.mock.calls[0]![0].rule_signals).toEqual([
      { code: "DISPOSABLE_EMAIL", detail: expect.stringContaining("Disposable email domain") },
    ]);
    expect(r.decision).toBe("allow");
    expect(r.reasons.map((x) => x.code)).toEqual(["JEV_ASSESSMENT", "DISPOSABLE_EMAIL"]);
  });

  it("rules can lift Jev to review but never to block", async () => {
    const { client } = stubClient(verdict(0.05, "allow", 0.9, "none", "low"));
    const scorer = new JevScorer("jev_rules", { client, engine, policy, geo });
    const strongRules = withF({ travel_speed_kmh: 5_000, ua_headless: 1, email_disposable: 1, card_distinct_accounts_24h: 3 });
    expect(policy.decide(engine.evaluate(txn, strongRules)).decision).toBe("block");
    expect((await scorer.score(txn, strongRules)).decision).toBe("review");
  });
});
