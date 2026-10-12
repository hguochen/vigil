import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DecisionPolicy } from "../src/decision/policy.js";
import { FEATURE_NAMES, type Features } from "../src/features/types.js";
import { DEFAULT_MODEL_DIR, XgbScorer } from "../src/scoring/xgb-scorer.js";

// Runs only when a model has been trained locally (uv run vigil-train); models/ is not committed.
const parityPath = join(DEFAULT_MODEL_DIR, "parity.json");

describe.runIf(existsSync(parityPath))("trained XGBoost model: Node ONNX runtime vs Python XGBoost", () => {
  it("reproduces Python's probabilities on the saved test rows", async () => {
    const parity = JSON.parse(readFileSync(parityPath, "utf8")) as { rows: (number | null)[][]; probabilities: number[] };
    const scorer = await XgbScorer.load(DecisionPolicy.load());
    let maxDiff = 0;
    for (const [i, row] of parity.rows.entries()) {
      const features = Object.fromEntries(FEATURE_NAMES.map((n, j) => [n, row[j] ?? null])) as Features;
      maxDiff = Math.max(maxDiff, Math.abs((await scorer.predict(features)) - parity.probabilities[i]!));
    }
    expect(parity.rows.length).toBeGreaterThan(100);
    expect(maxDiff).toBeLessThan(1e-5);
  });
});
