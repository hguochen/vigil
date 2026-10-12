import { describe, expect, it } from "vitest";
import { recallAtFpr, report, type EvalRow } from "../src/eval/offline.js";

const row = (isFraud: boolean, score: number, extra: Partial<EvalRow> = {}): EvalRow => ({
  scenario: isFraud ? "stolen_card" : "legit",
  isFraud,
  truePattern: isFraud ? "stolen_card" : "none",
  decision: score >= 0.6 ? "review" : "allow",
  score,
  pattern: score >= 0.6 ? "stolen_card" : "none",
  reasonCodes: score > 0 ? ["SOME_RULE"] : [],
  ...extra,
});

describe("offline evaluation", () => {
  it("finds the best recall within an FPR budget", () => {
    const rows = [
      ...Array.from({ length: 98 }, () => row(false, 0)),
      row(false, 0.7),
      row(false, 0.9), // the only legit at or above 0.8 -> 1% FPR
      row(true, 0.95),
      row(true, 0.8),
      row(true, 0.5),
      row(true, 0),
    ];
    expect(recallAtFpr(rows, 0.01)).toEqual({ recall: 0.5, threshold: 0.8 });
    expect(recallAtFpr(rows, 0.02)).toEqual({ recall: 0.75, threshold: 0.5 });
    expect(recallAtFpr(rows, 0)).toEqual({ recall: 0.25, threshold: 0.95 });
  });

  it("does not count ties above the budget", () => {
    const rows = [row(false, 0.5), row(false, 0.5), row(true, 0.5)];
    expect(recallAtFpr(rows, 0.4).recall).toBe(0);
  });

  it("renders a report with per-scenario lines", () => {
    const text = report([row(false, 0), row(true, 0.7), row(true, 0, { scenario: "friendly_fraud" })]);
    expect(text).toContain("stolen_card");
    expect(text).toContain("friendly_fraud");
    expect(text).toMatch(/flagged \(review\+block\): recall\s+50\.0%/);
  });

  it("shows no pattern accuracy for strategies that do not predict patterns", () => {
    const text = report([row(false, 0), row(true, 0.7, { pattern: null })]);
    expect(text).toMatch(/stolen_card\s+1\s+100\.0%.*\s-\s*$/m);
  });
});
