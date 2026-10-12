import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-node";
import { z } from "zod";
import type { Transaction } from "../domain/transaction.js";
import type { DecisionPolicy } from "../decision/policy.js";
import { FEATURE_NAMES, type Features } from "../features/types.js";
import type { ScoreResult, Scorer } from "./scorer.js";

// Repo-root models/xgb (written by `uv run vigil-train`).
export const DEFAULT_MODEL_DIR = fileURLToPath(new URL("../../../models/xgb", import.meta.url));

const SchemaFile = z.object({
  model_version: z.string(),
  feature_names: z.array(z.string()),
  input_name: z.string(),
  probability_output: z.string(),
  positive_class_index: z.number().int().min(0),
  /** Alert rates the cutoffs were derived for; must match policy.yaml. */
  alert_rates: z.object({ step_up_3ds: z.number(), review: z.number(), block: z.number() }),
  decision_thresholds: z.object({ step_up_3ds: z.number(), review: z.number(), block: z.number() }),
});

/** Builds the model input row; null features become NaN (XGBoost's "missing"). */
export function toInputRow(f: Features): Float32Array {
  return Float32Array.from(FEATURE_NAMES, (name) => f[name] ?? Number.NaN);
}

/** The `xgboost` strategy: an ONNX export of the baseline model, run in-process. */
export class XgbScorer implements Scorer {
  readonly strategy = "xgboost" as const;

  private constructor(
    private readonly session: ort.InferenceSession,
    private readonly schema: z.infer<typeof SchemaFile>,
    private readonly policy: DecisionPolicy,
  ) {}

  static async load(policy: DecisionPolicy, dir = DEFAULT_MODEL_DIR): Promise<XgbScorer> {
    const schema = SchemaFile.parse(JSON.parse(readFileSync(join(dir, "feature_schema.json"), "utf8")));
    // Train/serve skew guard: the model must expect exactly the features we compute, in order.
    const expected = [...FEATURE_NAMES];
    if (JSON.stringify(schema.feature_names) !== JSON.stringify(expected)) {
      const missing = expected.filter((n) => !schema.feature_names.includes(n));
      const extra = schema.feature_names.filter((n) => !(expected as string[]).includes(n));
      throw new Error(
        `model ${schema.model_version} feature mismatch (missing: ${missing.join(",") || "none"}; ` +
          `unexpected: ${extra.join(",") || "none"}; or different order). Retrain with the current feature spec.`,
      );
    }
    const rates = policy.config.xgboost.alert_rates;
    const same = (["step_up_3ds", "review", "block"] as const).every((k) => schema.alert_rates[k] === rates[k]);
    if (!same) {
      throw new Error(
        `model ${schema.model_version} was calibrated for alert rates ${JSON.stringify(schema.alert_rates)}, ` +
          `but policy.yaml has ${JSON.stringify(rates)}. Retrain (uv run vigil-train) after changing them.`,
      );
    }
    const session = await ort.InferenceSession.create(join(dir, "model.onnx"));
    return new XgbScorer(session, schema, policy);
  }

  get modelVersion(): string {
    return this.schema.model_version;
  }

  async predict(f: Features): Promise<number> {
    const input = new ort.Tensor("float32", toInputRow(f), [1, FEATURE_NAMES.length]);
    const out = await this.session.run({ [this.schema.input_name]: input });
    const probs = out[this.schema.probability_output];
    if (!probs) throw new Error(`model output "${this.schema.probability_output}" missing`);
    return Number(probs.data[this.schema.positive_class_index]);
  }

  async score(_txn: Transaction, features: Features): Promise<ScoreResult> {
    const p = await this.predict(features);
    const outcome = this.policy.decideModel(p, this.schema.model_version, this.schema.decision_thresholds);
    return {
      decision: outcome.decision,
      fraud_probability: p,
      pattern: null, // the baseline predicts fraud vs not, not which pattern
      risk_level: outcome.riskLevel,
      reasons: outcome.reasons,
      raw: { model_version: this.schema.model_version, probability: p },
    };
  }
}
