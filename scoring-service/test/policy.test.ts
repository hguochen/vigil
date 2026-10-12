import { describe, expect, it } from "vitest";
import { DecisionPolicy } from "../src/decision/policy.js";
import type { RuleHit } from "../src/rules/engine.js";

const policy = DecisionPolicy.load();

const hit = (code: string, weight: number, extra: Partial<RuleHit> = {}): RuleHit => ({
  code,
  message: code.toLowerCase(),
  weight,
  action: null,
  pattern: null,
  ...extra,
});

describe("DecisionPolicy", () => {
  it("allows with no hits", () => {
    expect(policy.decide([])).toEqual({ decision: "allow", score: 0, riskLevel: "low", pattern: "none", reasons: [] });
  });

  it("combines soft weights by noisy-OR", () => {
    const out = policy.decide([hit("A", 0.5), hit("B", 0.5)]);
    expect(out.score).toBeCloseTo(0.75);
    expect(out.decision).toBe("review");
    expect(out.riskLevel).toBe("high");
  });

  it.each([
    [0.2, "allow", "low"],
    [0.35, "step_up_3ds", "elevated"],
    [0.6, "review", "high"],
    [0.85, "block", "critical"],
  ])("score %s -> %s / %s (thresholds are inclusive)", (w, decision, risk) => {
    const out = policy.decide([hit("A", w)]);
    expect(out.decision).toBe(decision);
    expect(out.riskLevel).toBe(risk);
  });

  it("hard block wins and lifts the score to 1", () => {
    const out = policy.decide([hit("SOFT", 0.1), hit("BLOCKLIST", 0, { action: "block" })]);
    expect(out).toMatchObject({ decision: "block", score: 1, riskLevel: "critical" });
    expect(out.reasons[0]!.code).toBe("BLOCKLIST");
  });

  it("hard review never lowers a stricter soft decision", () => {
    expect(policy.decide([hit("R", 0, { action: "review" })])).toMatchObject({ decision: "review", score: 0.6 });
    expect(policy.decide([hit("R", 0, { action: "review" }), hit("S", 0.9)]).decision).toBe("block");
  });

  it("orders reasons by weight and takes the pattern from the strongest hit", () => {
    const out = policy.decide([
      hit("WEAK", 0.1, { pattern: "promo_abuse" }),
      hit("STRONG", 0.6, { pattern: "account_takeover" }),
      hit("NO_PATTERN", 0.7),
    ]);
    expect(out.reasons.map((r) => r.code)).toEqual(["NO_PATTERN", "STRONG", "WEAK"]);
    expect(out.pattern).toBe("account_takeover");
  });

  it("rejects thresholds that are not ascending", () => {
    expect(() =>
      DecisionPolicy.fromYaml(`version: 1
thresholds: { step_up_3ds: 0.7, review: 0.6, block: 0.9 }
risk_levels: { elevated: 0.3, high: 0.6, critical: 0.9 }`),
    ).toThrow();
  });
});
