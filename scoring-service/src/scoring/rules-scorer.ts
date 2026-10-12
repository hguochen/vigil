import type { Transaction } from "../domain/transaction.js";
import type { DecisionPolicy } from "../decision/policy.js";
import type { Features } from "../features/types.js";
import type { RulesEngine } from "../rules/engine.js";
import type { ScoreResult, Scorer } from "./scorer.js";

/** The `rules` strategy: hard rules plus weighted soft rules, mapped by the policy. */
export class RulesScorer implements Scorer {
  readonly strategy = "rules" as const;

  constructor(
    private readonly engine: RulesEngine,
    private readonly policy: DecisionPolicy,
  ) {}

  async score(txn: Transaction, features: Features): Promise<ScoreResult> {
    const hits = this.engine.evaluate(txn, features);
    const outcome = this.policy.decide(hits);
    return {
      decision: outcome.decision,
      fraud_probability: outcome.score,
      pattern: outcome.pattern,
      risk_level: outcome.riskLevel,
      reasons: outcome.reasons,
      raw: { rule_hits: hits },
    };
  }
}
