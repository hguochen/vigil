import type { Decision, Pattern, Reason, RiskLevel, Strategy, Transaction } from "../domain/transaction.js";
import type { Features } from "../features/types.js";

export interface ScoreResult {
  decision: Decision;
  fraud_probability: number | null;
  pattern: Pattern | null;
  risk_level: RiskLevel | null;
  reasons: Reason[];
  /** Raw classifier output persisted for audit (e.g. Jev answers and usage). */
  raw?: unknown;
}

export interface Scorer {
  readonly strategy: Strategy;
  score(txn: Transaction, features: Features): Promise<ScoreResult>;
}

/** Placeholder until the rules engine lands: allows everything. */
export const passthroughScorer: Scorer = {
  strategy: "passthrough",
  async score() {
    return { decision: "allow", fraud_probability: null, pattern: null, risk_level: null, reasons: [] };
  },
};
