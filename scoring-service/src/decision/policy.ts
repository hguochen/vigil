import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Decision, Pattern, Reason, RiskLevel } from "../domain/transaction.js";
import type { JevVerdict } from "../jev/client.js";
import type { RuleHit } from "../rules/engine.js";

export const DEFAULT_POLICY_PATH = fileURLToPath(new URL("../../config/policy.yaml", import.meta.url));

const ascending = (t: Record<string, number>, keys: string[]) =>
  keys.every((k, i) => i === 0 || t[keys[i - 1]!]! < t[k]!);

const unit = z.number().gt(0).lt(1);
const PolicySchema = z.strictObject({
  version: z.literal(1),
  /** Score at or above which each decision applies. */
  thresholds: z
    .strictObject({ step_up_3ds: unit, review: unit, block: unit })
    .refine((t) => ascending(t, ["step_up_3ds", "review", "block"]), "thresholds must be ascending"),
  /** Score at or above which each risk level applies (below elevated is low). */
  risk_levels: z
    .strictObject({ elevated: unit, high: unit, critical: unit })
    .refine((t) => ascending(t, ["elevated", "high", "critical"]), "risk levels must be ascending"),
  jev: z.strictObject({
    /** Jev is_fraud probability at or above which each decision applies. */
    thresholds: z
      .strictObject({ step_up_3ds: unit, review: unit, block: unit })
      .refine((t) => ascending(t, ["step_up_3ds", "review", "block"]), "jev thresholds must be ascending"),
    /** Jev's recommended action only counts at or above this confidence. */
    min_action_confidence: unit,
    /** When Jev fails: decide with the rules alone, or send the order to review at minimum. */
    on_error: z.enum(["rules", "review"]),
  }),
});

export type PolicyConfig = z.infer<typeof PolicySchema>;

export interface PolicyOutcome {
  decision: Decision;
  score: number;
  riskLevel: RiskLevel;
  pattern: Pattern;
  reasons: Reason[];
}

const SEVERITY: Record<Decision, number> = { allow: 0, step_up_3ds: 1, review: 2, block: 3 };
export const stricter = (a: Decision, b: Decision): Decision => (SEVERITY[a] >= SEVERITY[b] ? a : b);
/** Caps a decision at review: used where a signal may escalate but must not block on its own. */
export const atMostReview = (d: Decision): Decision => (d === "block" ? "review" : d);
const pct = (x: number) => `${Math.round(x * 100)}%`;

export class DecisionPolicy {
  constructor(readonly config: PolicyConfig) {}

  static fromYaml(source: string): DecisionPolicy {
    return new DecisionPolicy(PolicySchema.parse(parseYaml(source)));
  }

  static load(path = DEFAULT_POLICY_PATH): DecisionPolicy {
    return DecisionPolicy.fromYaml(readFileSync(path, "utf8"));
  }

  decisionFor(score: number): Decision {
    const t = this.config.thresholds;
    if (score >= t.block) return "block";
    if (score >= t.review) return "review";
    if (score >= t.step_up_3ds) return "step_up_3ds";
    return "allow";
  }

  riskLevelFor(score: number): RiskLevel {
    const r = this.config.risk_levels;
    if (score >= r.critical) return "critical";
    if (score >= r.high) return "high";
    if (score >= r.elevated) return "elevated";
    return "low";
  }

  /**
   * Combines rule hits: soft weights merge by noisy-OR (1 - Π(1 - w)); hard
   * actions can only make the decision stricter and lift the score to match.
   */
  decide(hits: RuleHit[]): PolicyOutcome {
    let score = 1 - hits.reduce((p, h) => p * (1 - h.weight), 1);
    let decision = this.decisionFor(score);

    for (const h of hits) {
      if (h.action === "block") score = 1;
      if (h.action === "review") score = Math.max(score, this.config.thresholds.review);
      if (h.action) decision = stricter(decision, h.action);
    }

    // Hard hits first, then by weight; the top hit's pattern describes the transaction.
    const ranked = [...hits].sort((a, b) => Number(!!b.action) - Number(!!a.action) || b.weight - a.weight);
    return {
      decision,
      score,
      riskLevel: this.riskLevelFor(score),
      pattern: ranked.find((h) => h.pattern)?.pattern ?? "none",
      reasons: ranked.map(({ code, message }) => ({ code, message })),
    };
  }

  /**
   * Maps Jev's typed verdict to a decision. The probability sets the base
   * decision; a block needs Jev's recommended action to agree with confidence;
   * a confident recommendation may escalate, but disagreement goes to review.
   */
  decideJev(v: JevVerdict): PolicyOutcome {
    const { thresholds: t, min_action_confidence: minConf } = this.config.jev;
    const p = v.fraudProbability;
    const confident = v.action.confidence >= minConf;

    let decision: Decision = p >= t.block ? "block" : p >= t.review ? "review" : p >= t.step_up_3ds ? "step_up_3ds" : "allow";
    if (decision === "block" && !(confident && v.action.label === "block")) decision = "review";
    if (confident) decision = stricter(decision, atMostReview(v.action.label));

    return {
      decision,
      score: p,
      riskLevel: v.riskLevel.label,
      pattern: v.pattern.label,
      reasons: [
        {
          code: "JEV_ASSESSMENT",
          message:
            `Jev: ${pct(p)} fraud probability, pattern ${v.pattern.label} (${pct(v.pattern.confidence)}), ` +
            `recommends ${v.action.label} (${pct(v.action.confidence)})`,
        },
      ],
    };
  }
}
