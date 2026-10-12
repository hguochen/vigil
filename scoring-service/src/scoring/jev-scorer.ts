import type { Transaction } from "../domain/transaction.js";
import { atMostReview, stricter, type DecisionPolicy } from "../decision/policy.js";
import type { GeoTable } from "../features/geo.js";
import type { Features } from "../features/types.js";
import type { JevClient } from "../jev/client.js";
import { buildJevState } from "../jev/mask.js";
import type { RulesEngine } from "../rules/engine.js";
import type { ScoreResult, Scorer } from "./scorer.js";

export interface JevScorerDeps {
  client: JevClient;
  engine: RulesEngine;
  policy: DecisionPolicy;
  geo: GeoTable;
  onJevError?: (err: unknown, txn: Transaction) => void;
}

/**
 * `jev`: Jev decides; rules are only the fallback when Jev is unavailable.
 * `jev_rules`: hard rules decide without calling Jev (Tier 0); otherwise fired
 * rules are passed to Jev as evidence, and may lift Jev's decision to review.
 */
export class JevScorer implements Scorer {
  constructor(
    readonly strategy: "jev" | "jev_rules",
    private readonly deps: JevScorerDeps,
  ) {}

  async score(txn: Transaction, features: Features): Promise<ScoreResult> {
    const { client, engine, policy, geo } = this.deps;
    const withRules = this.strategy === "jev_rules";
    const hits = engine.evaluate(txn, features);
    const rules = policy.decide(hits);

    if (withRules && hits.some((h) => h.action)) {
      return {
        decision: rules.decision,
        fraud_probability: rules.score,
        pattern: rules.pattern,
        risk_level: rules.riskLevel,
        reasons: rules.reasons,
        raw: { tier: "rules_hard", rule_hits: hits },
      };
    }

    let verdict;
    try {
      verdict = await client.classify(buildJevState(txn, features, geo, withRules ? hits : []));
    } catch (err) {
      this.deps.onJevError?.(err, txn);
      const reviewAtLeast = policy.config.jev.on_error === "review";
      return {
        decision: reviewAtLeast ? stricter(rules.decision, "review") : rules.decision,
        fraud_probability: rules.score,
        pattern: rules.pattern,
        risk_level: rules.riskLevel,
        reasons: [{ code: "JEV_UNAVAILABLE", message: "Jev was unavailable; decided by rules" }, ...rules.reasons],
        raw: { tier: "fallback", error: err instanceof Error ? `${err.name}: ${err.message}` : String(err), rule_hits: hits },
      };
    }

    const jev = policy.decideJev(verdict);
    const decision = withRules ? stricter(jev.decision, atMostReview(rules.decision)) : jev.decision;
    return {
      decision,
      fraud_probability: jev.score,
      pattern: jev.pattern,
      risk_level: jev.riskLevel,
      reasons: withRules ? [...jev.reasons, ...rules.reasons] : jev.reasons,
      raw: { tier: "jev", jev: verdict, ...(withRules && { rule_hits: hits }) },
    };
  }
}
