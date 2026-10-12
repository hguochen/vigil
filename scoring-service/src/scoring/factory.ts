import type { Config } from "../config.js";
import type { Transaction } from "../domain/transaction.js";
import { DecisionPolicy } from "../decision/policy.js";
import type { GeoTable } from "../features/geo.js";
import { TypeSafeJevClient } from "../jev/client.js";
import { RulesEngine } from "../rules/engine.js";
import { JevScorer } from "./jev-scorer.js";
import { RulesScorer } from "./rules-scorer.js";
import { passthroughScorer, type Scorer } from "./scorer.js";

export interface ScorerOptions {
  geo: GeoTable;
  onJevError?: (err: unknown, txn: Transaction) => void;
  /** Transport override (tests). */
  fetch?: typeof fetch;
}

export function createScorer(config: Config, options: ScorerOptions): Scorer {
  if (config.SCORING_STRATEGY === "passthrough") return passthroughScorer;

  const engine = RulesEngine.load(config.RULES_PATH);
  const policy = DecisionPolicy.load(config.POLICY_PATH);
  if (config.SCORING_STRATEGY === "rules") return new RulesScorer(engine, policy);

  if (!config.TYPESAFE_API_KEY) {
    throw new Error(`SCORING_STRATEGY=${config.SCORING_STRATEGY} requires TYPESAFE_API_KEY`);
  }
  const client = new TypeSafeJevClient({
    apiKey: config.TYPESAFE_API_KEY,
    ...(config.TYPESAFE_BASE_URL && { baseUrl: config.TYPESAFE_BASE_URL }),
    model: config.JEV_MODEL,
    timeoutMs: config.JEV_TIMEOUT_MS,
    maxRetries: config.JEV_MAX_RETRIES,
    ...(options.fetch && { fetch: options.fetch }),
  });
  return new JevScorer(config.SCORING_STRATEGY, {
    client,
    engine,
    policy,
    geo: options.geo,
    ...(options.onJevError && { onJevError: options.onJevError }),
  });
}
