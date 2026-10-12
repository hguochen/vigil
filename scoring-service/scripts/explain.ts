/**
 * Explains one transaction's decision end to end, as Markdown: raw identifiers,
 * fired rules, the masked state Jev saw, Jev's typed answers, the policy steps,
 * and the API response. Uses the benchmark's Jev cache; no API call unless
 * --allow-call is passed.
 *
 *   npm run explain -- ../data/sim/holdout.jsonl txn_00003624 [--strategy jev_rules] [--allow-call]
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { atMostReview, DecisionPolicy, stricter } from "../src/decision/policy.js";
import { TransactionSchema, type Transaction } from "../src/domain/transaction.js";
import { CachingJevClient } from "../src/eval/benchmark.js";
import { FeatureExtractor } from "../src/features/extractor.js";
import { loadGeoTable } from "../src/features/geo.js";
import { InMemoryFeatureStore } from "../src/features/store.js";
import { TypeSafeJevClient, type JevClient, type JevVerdict } from "../src/jev/client.js";
import { buildJevState } from "../src/jev/mask.js";
import { RulesEngine } from "../src/rules/engine.js";
import { JevScorer } from "../src/scoring/jev-scorer.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    strategy: { type: "string", default: "jev_rules" },
    "allow-call": { type: "boolean", default: false },
    cache: { type: "string", default: fileURLToPath(new URL("../../reports/jev-cache.jsonl", import.meta.url)) },
  },
});
const [dataPath, targetId] = positionals;
const strategy = values.strategy as "jev" | "jev_rules";
if (!dataPath || !targetId || !["jev", "jev_rules"].includes(strategy)) {
  console.error("usage: explain <dataset.jsonl> <transaction_id> [--strategy jev|jev_rules] [--allow-call]");
  process.exit(2);
}

// Features need the history before the transaction, so replay the stream up to it.
const geo = loadGeoTable();
const extractor = new FeatureExtractor(new InMemoryFeatureStore(), geo);
let txn: Transaction | undefined;
let label: { scenario: string; is_fraud: boolean } | undefined;
for await (const line of createInterface({ input: createReadStream(dataPath) })) {
  if (!line) continue;
  const row = JSON.parse(line);
  const t = TransactionSchema.parse(row.transaction);
  if (t.transaction_id === targetId) {
    txn = t;
    label = row.label;
    break;
  }
  await extractor.extract(t);
  await extractor.record(t);
}
if (!txn || !label) throw new Error(`${targetId} not found in ${dataPath}`);
const features = await extractor.extract(txn);

const config = loadConfig();
const engine = RulesEngine.load(config.RULES_PATH);
const policy = DecisionPolicy.load(config.POLICY_PATH);
const offline: JevClient = {
  classify: async () => {
    throw new Error("verdict not cached; rerun with --allow-call to make one Jev API call");
  },
};
const inner: JevClient =
  values["allow-call"] && config.TYPESAFE_API_KEY
    ? new TypeSafeJevClient({ apiKey: config.TYPESAFE_API_KEY, model: config.JEV_MODEL, timeoutMs: 20_000, maxRetries: 2 })
    : offline;
const client = new CachingJevClient(inner, config.JEV_MODEL, values.cache!);
let verdict: JevVerdict | undefined;
const capture: JevClient = { classify: async (s) => (verdict = await client.classify(s)) };
const result = await new JevScorer(strategy, { client: capture, engine, policy, geo }).score(txn, features);

const hits = engine.evaluate(txn, features);
const state = buildJevState(txn, features, geo, strategy === "jev_rules" ? hits : []);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const json = (x: unknown) => "```json\n" + JSON.stringify(x, null, 2) + "\n```";
const out: string[] = [];

out.push(`### What the merchant sends (${txn.transaction_id}, simulated \`${label.scenario}\`)`);
out.push(
  `A $${(txn.amount_minor / 100).toFixed(2)} order of ${txn.items.map((i) => i.category).join(", ")} from customer ` +
    `\`${txn.customer.id}\` (account created ${txn.customer.account_created_at.slice(0, 10)}), card \`${txn.card.bin}••${txn.card.last4}\`, ` +
    `device \`${txn.device.id}\` at IP \`${txn.device.ip}\`, shipping to ${txn.shipping_address.city}, ${txn.shipping_address.country} ` +
    `(billing: ${txn.billing_address.city}, ${txn.billing_address.country}).`,
);

out.push(`\n### Rules that fired`);
out.push(hits.length ? hits.map((h) => `- \`${h.code}\` (${h.action ?? `weight ${h.weight}`}): ${h.message}`).join("\n") : "- none");

if (result.raw && (result.raw as { tier?: string }).tier === "rules_hard") {
  out.push(`\nA hard rule decided this order; Jev was not called.`);
} else {
  out.push(`\n### What Jev sees (masked: no names, emails, card data, IPs, device ids or street addresses)`);
  out.push(json(state));

  const v = verdict!;
  const top = (p: Record<string, number>, n = 3) =>
    Object.entries(p).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, x]) => `${k} ${pct(x)}`).join(", ");
  out.push(`\n### Jev's typed answers (${v.model}, one request, ${v.latencyMs} ms)`);
  out.push(
    [
      "| Question | Type | Answer | Distribution |",
      "|---|---|---|---|",
      `| \`is_fraud\` | noul | **${v.fraudProbability.toFixed(2)}** | — |`,
      `| \`fraud_pattern\` | choice | **${v.pattern.label}** (${pct(v.pattern.confidence)}) | ${top(v.pattern.probabilities)} |`,
      `| \`risk_level\` | score | **${v.riskLevel.label}** (expected level ${v.riskLevel.expectedLevel.toFixed(2)}) | ${top(
        Object.fromEntries(Object.entries(v.riskLevel.probabilities).map(([k, x]) => [["low", "elevated", "high", "critical"][Number(k)]!, x])),
      )} |`,
      `| \`action\` | choice | **${v.action.label}** (${pct(v.action.confidence)}) | ${top(v.action.probabilities)} |`,
    ].join("\n"),
  );

  // Narrate the policy (config/policy.yaml) and check it reproduces the scorer's decision.
  const t = policy.config.jev.thresholds;
  const minConf = policy.config.jev.min_action_confidence;
  const p = v.fraudProbability;
  const steps: string[] = [];
  let d: typeof result.decision = p >= t.block ? "block" : p >= t.review ? "review" : p >= t.step_up_3ds ? "step_up_3ds" : "allow";
  steps.push(`Probability ${p.toFixed(2)} against thresholds (step-up ${t.step_up_3ds}, review ${t.review}, block ${t.block}) gives **${d}**.`);
  const confident = v.action.confidence >= minConf;
  if (d === "block" && !(confident && v.action.label === "block")) {
    d = "review";
    steps.push(`Blocking needs Jev's recommended action to agree with ≥${pct(minConf)} confidence; it doesn't, so **review**.`);
  }
  if (confident) {
    const lifted = stricter(d, atMostReview(v.action.label));
    steps.push(
      lifted === d
        ? `Jev's recommendation (${v.action.label}, ${pct(v.action.confidence)}) is confident but doesn't raise the decision.`
        : `Jev confidently recommends ${v.action.label} (${pct(v.action.confidence)}), lifting the decision to **${(d = lifted)}**.`,
    );
  } else {
    steps.push(`Jev's recommendation (${v.action.label}, ${pct(v.action.confidence)}) is below ${pct(minConf)} confidence, so it is ignored.`);
  }
  if (strategy === "jev_rules") {
    const rulesDecision = policy.decide(hits).decision;
    const lifted = stricter(d, atMostReview(rulesDecision));
    steps.push(
      lifted === d
        ? `Rules safety net (rules alone: ${rulesDecision}, capped at review) doesn't change it.`
        : `Rules safety net (rules alone: ${rulesDecision}, capped at review) lifts it to **${(d = lifted)}**.`,
    );
  }
  if (d !== result.decision) throw new Error(`narration (${d}) disagrees with the scorer (${result.decision})`);
  out.push(`\n### Policy (\`config/policy.yaml\`)`);
  out.push(steps.map((s, i) => `${i + 1}. ${s}`).join("\n"));
}

out.push(`\n### API response`);
const { raw: _raw, ...response } = result;
out.push(json({ transaction_id: txn.transaction_id, ...response, strategy }));
console.log(out.join("\n"));
