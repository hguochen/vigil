/**
 * Benchmarks scoring strategies on a labeled dataset, in-process with the
 * service's own scorers. Features are computed once over the full stream (in
 * time order); strategies are scored on a stratified sample (all fraud plus a
 * weighted random sample of legit). Jev verdicts are cached on disk.
 *
 *   npm run bench -- ../data/sim/holdout.jsonl [--strategies rules,xgboost,jev,jev_rules]
 *     [--legit-sample 4000] [--seed 1] [--concurrency 8] [--max-calls 0] [--out ../reports/bench]
 *     [--limit N (pilot)] [--cache ../reports/jev-cache.jsonl]
 *
 * Real Jev calls are refused unless --max-calls covers every uncached call needed.
 */
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { DecisionPolicy } from "../src/decision/policy.js";
import { STRATEGIES, TransactionSchema, type Strategy, type Transaction } from "../src/domain/transaction.js";
import { CachingJevClient, pool, stateKey, stratifiedSample } from "../src/eval/benchmark.js";
import { FeatureExtractor } from "../src/features/extractor.js";
import { loadGeoTable } from "../src/features/geo.js";
import { InMemoryFeatureStore } from "../src/features/store.js";
import type { Features } from "../src/features/types.js";
import { TypeSafeJevClient, type JevVerdict } from "../src/jev/client.js";
import { buildJevState } from "../src/jev/mask.js";
import { QUESTION_SET_VERSION } from "../src/jev/questions.js";
import { RulesEngine } from "../src/rules/engine.js";
import { JevScorer } from "../src/scoring/jev-scorer.js";
import { RulesScorer } from "../src/scoring/rules-scorer.js";
import type { Scorer } from "../src/scoring/scorer.js";
import { XgbScorer } from "../src/scoring/xgb-scorer.js";

const TOKENS_PER_CALL_ESTIMATE = 1_650; // measured on jev-1.13.0 with this question set

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    strategies: { type: "string", default: "rules,xgboost,jev,jev_rules" },
    "legit-sample": { type: "string", default: "4000" },
    seed: { type: "string", default: "1" },
    concurrency: { type: "string", default: "8" },
    "max-calls": { type: "string", default: "0" },
    limit: { type: "string" },
    out: { type: "string", default: fileURLToPath(new URL("../../reports/bench", import.meta.url)) },
    // Shared across runs so a pilot's verdicts are reused by the full run.
    cache: { type: "string", default: fileURLToPath(new URL("../../reports/jev-cache.jsonl", import.meta.url)) },
  },
});
const dataPath = positionals[0];
if (!dataPath) {
  console.error("usage: bench <dataset.jsonl> [--strategies ...] [--legit-sample N] [--max-calls N] [--out dir]");
  process.exit(2);
}
const strategies = values.strategies!.split(",") as Strategy[];
for (const s of strategies) {
  if (!STRATEGIES.includes(s) || s === "passthrough") throw new Error(`unknown strategy ${s}`);
}
const outDir = resolve(values.out!);
mkdirSync(outDir, { recursive: true });

// 1. Load and compute features once over the full stream, in time order.
interface Row {
  txn: Transaction;
  label: { is_fraud: boolean; scenario: string; pattern: string };
}
const rows: Row[] = [];
for await (const line of createInterface({ input: createReadStream(dataPath) })) {
  if (!line) continue;
  const { transaction, label } = JSON.parse(line);
  rows.push({ txn: TransactionSchema.parse(transaction), label });
}
const geo = loadGeoTable();
const extractor = new FeatureExtractor(new InMemoryFeatureStore(), geo);
const features: Features[] = [];
for (const r of rows) {
  features.push(await extractor.extract(r.txn));
  await extractor.record(r.txn);
}

// 2. Stratified sample, optionally truncated for a pilot (keeps the fraud/legit mix).
const sample = stratifiedSample(rows.map((r) => r.label.is_fraud), Number(values["legit-sample"]), Number(values.seed));
let indices = sample.indices;
if (values.limit) {
  const limit = Number(values.limit);
  const shuffled = [...indices].sort((a, b) => ((a * 2654435761) % 1000003) - ((b * 2654435761) % 1000003));
  indices = shuffled.slice(0, limit).sort((a, b) => a - b);
}
const nFraud = indices.filter((i) => rows[i]!.label.is_fraud).length;
console.log(`dataset ${rows.length.toLocaleString()} rows; sample ${indices.length.toLocaleString()} (${nFraud} fraud, ${indices.length - nFraud} legit)`);

// 3. Scorers.
const config = loadConfig();
const engine = RulesEngine.load(config.RULES_PATH);
const policy = DecisionPolicy.load(config.POLICY_PATH);
const jevErrors = new Map<string, number>();
let cache: CachingJevClient | undefined;
if (strategies.some((s) => s.startsWith("jev"))) {
  if (!config.TYPESAFE_API_KEY) throw new Error("Jev strategies need TYPESAFE_API_KEY (run via npm run bench, which loads ../.env)");
  const live = new TypeSafeJevClient({
    apiKey: config.TYPESAFE_API_KEY,
    ...(config.TYPESAFE_BASE_URL && { baseUrl: config.TYPESAFE_BASE_URL }),
    model: config.JEV_MODEL,
    timeoutMs: 20_000, // benchmark measures latency; it is not on a checkout path
    maxRetries: 3,
  });
  cache = new CachingJevClient(live, config.JEV_MODEL, resolve(values.cache!));
}
const scorers = new Map<Strategy, Scorer>();
for (const s of strategies) {
  if (s === "rules") scorers.set(s, new RulesScorer(engine, policy));
  if (s === "xgboost") scorers.set(s, await XgbScorer.load(policy, config.XGB_MODEL_DIR));
  if (s === "jev" || s === "jev_rules") {
    scorers.set(
      s,
      new JevScorer(s, {
        client: cache!,
        engine,
        policy,
        geo,
        onJevError: (err) => {
          const name = err instanceof Error ? err.name : "Error";
          jevErrors.set(name, (jevErrors.get(name) ?? 0) + 1);
        },
      }),
    );
  }
}

// 4. Spending guard: count uncached Jev calls before making any.
if (cache) {
  const needed = new Set<string>();
  for (const s of strategies.filter((x) => x.startsWith("jev"))) {
    for (const i of indices) {
      const hits = engine.evaluate(rows[i]!.txn, features[i]!);
      if (s === "jev_rules" && hits.some((h) => h.action)) continue; // hard rule: no call
      const state = buildJevState(rows[i]!.txn, features[i]!, geo, s === "jev_rules" ? hits : []);
      // Same key the cache uses: identical states (e.g. jev and jev_rules when no rule fired) cost one call.
      if (!cache.has(state)) needed.add(stateKey(state, config.JEV_MODEL));
    }
  }
  const maxCalls = Number(values["max-calls"]);
  console.log(
    `Jev: ${needed.size.toLocaleString()} uncached calls needed (~${((needed.size * TOKENS_PER_CALL_ESTIMATE) / 1e6).toFixed(2)}M input tokens); ` +
      `${cache.size.toLocaleString()} cached; --max-calls ${maxCalls}`,
  );
  if (needed.size > maxCalls) {
    console.log(`Refusing to call Jev: raise --max-calls to at least ${needed.size} to proceed.`);
    process.exit(3);
  }
}

// 5. Score.
const results: Record<string, unknown>[] = [];
const started = performance.now();
for (const s of strategies) {
  const scorer = scorers.get(s)!;
  const t0 = performance.now();
  const scored = await pool(indices, s.startsWith("jev") ? Number(values.concurrency) : 1, async (i) => {
    const r = await scorer.score(rows[i]!.txn, features[i]!);
    const raw = (r.raw ?? {}) as { tier?: string; jev?: JevVerdict };
    return {
      transaction_id: rows[i]!.txn.transaction_id,
      strategy: s,
      scenario: rows[i]!.label.scenario,
      is_fraud: rows[i]!.label.is_fraud,
      true_pattern: rows[i]!.label.pattern,
      weight: sample.weights.get(i)!,
      decision: r.decision,
      score: r.fraud_probability ?? 0,
      pattern: r.pattern,
      risk_level: r.risk_level,
      reasons: r.reasons,
      tier: raw.tier ?? s,
      jev_latency_ms: raw.jev?.latencyMs ?? null,
      jev_input_tokens: raw.jev?.usage.inputTokens ?? null,
      jev_output_tokens: raw.jev?.usage.outputTokens ?? null,
      jev_model: raw.jev?.model ?? null,
    };
  });
  results.push(...scored);
  console.log(`  ${s.padEnd(10)} scored ${scored.length.toLocaleString()} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}

writeFileSync(join(outDir, "results.jsonl"), results.map((r) => JSON.stringify(r)).join("\n") + "\n");
writeFileSync(
  join(outDir, "meta.json"),
  JSON.stringify(
    {
      dataset: resolve(dataPath),
      dataset_rows: rows.length,
      sample_rows: indices.length,
      sample_fraud: nFraud,
      legit_sample: Number(values["legit-sample"]),
      seed: Number(values.seed),
      limit: values.limit ? Number(values.limit) : null,
      strategies,
      jev_model_requested: config.JEV_MODEL,
      question_set_version: QUESTION_SET_VERSION,
      xgb_model_version: (scorers.get("xgboost") as XgbScorer | undefined)?.modelVersion ?? null,
      jev_cache: cache ? { hits: cache.hits, misses: cache.misses } : null,
      jev_errors: Object.fromEntries(jevErrors),
      seconds: Math.round((performance.now() - started) / 100) / 10,
      generated_at: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);
console.log(`wrote ${outDir}/results.jsonl and meta.json` + (cache ? `  (Jev calls made: ${cache.misses}, cache hits: ${cache.hits}, errors: ${JSON.stringify(Object.fromEntries(jevErrors))})` : ""));
