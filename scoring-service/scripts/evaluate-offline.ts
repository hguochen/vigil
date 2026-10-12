/**
 * Replays a labeled JSONL dataset (vigil-sim generate --format jsonl) through
 * in-memory features + the rules strategy, and prints detection metrics.
 *
 *   npm run eval:offline -- ../data/sim/transactions.jsonl [--rules path] [--policy path]
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { DecisionPolicy } from "../src/decision/policy.js";
import { TransactionSchema } from "../src/domain/transaction.js";
import { report, type EvalRow } from "../src/eval/offline.js";
import { FeatureExtractor } from "../src/features/extractor.js";
import { loadGeoTable } from "../src/features/geo.js";
import { InMemoryFeatureStore } from "../src/features/store.js";
import { RulesEngine } from "../src/rules/engine.js";
import { RulesScorer } from "../src/scoring/rules-scorer.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { rules: { type: "string" }, policy: { type: "string" } },
});
const path = positionals[0];
if (!path) {
  console.error("usage: evaluate-offline <dataset.jsonl> [--rules path] [--policy path]");
  process.exit(2);
}

const scorer = new RulesScorer(RulesEngine.load(values.rules), DecisionPolicy.load(values.policy));
const extractor = new FeatureExtractor(new InMemoryFeatureStore(), loadGeoTable());
const rows: EvalRow[] = [];
const started = performance.now();

for await (const line of createInterface({ input: createReadStream(path) })) {
  if (!line) continue;
  const { transaction, label } = JSON.parse(line);
  const txn = TransactionSchema.parse(transaction);
  const result = await scorer.score(txn, await extractor.extract(txn));
  await extractor.record(txn);
  rows.push({
    scenario: label.scenario,
    isFraud: label.is_fraud,
    truePattern: label.pattern,
    decision: result.decision,
    score: result.fraud_probability ?? 0,
    pattern: result.pattern,
    reasonCodes: result.reasons.map((r) => r.code),
  });
}

console.log(report(rows));
console.log(`\nscored ${rows.length.toLocaleString()} in ${((performance.now() - started) / 1000).toFixed(1)}s`);
