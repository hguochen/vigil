import type { Decision, Pattern } from "../domain/transaction.js";

export interface EvalRow {
  scenario: string; // "legit" or a fraud scenario
  isFraud: boolean;
  truePattern: string;
  decision: Decision;
  score: number;
  pattern: Pattern | null;
  reasonCodes: string[];
}

const flagged = (d: Decision) => d === "review" || d === "block";
const pct = (n: number, d: number) => (d === 0 ? "   -  " : `${((100 * n) / d).toFixed(1).padStart(5)}%`);

/** Highest recall achievable while keeping the false-positive rate at or below maxFpr. */
export function recallAtFpr(rows: EvalRow[], maxFpr: number): { recall: number; threshold: number } {
  const legit = rows.filter((r) => !r.isFraud).length;
  const fraud = rows.filter((r) => r.isFraud).length;
  const thresholds = [...new Set(rows.map((r) => r.score))].sort((a, b) => b - a);
  let best = { recall: 0, threshold: Infinity };
  for (const t of thresholds) {
    const above = rows.filter((r) => r.score >= t);
    const fp = above.filter((r) => !r.isFraud).length;
    if (legit > 0 && fp / legit > maxFpr) break;
    best = { recall: fraud ? above.filter((r) => r.isFraud).length / fraud : 0, threshold: t };
  }
  return best;
}

function topCounts(lists: string[][], n: number): [string, number][] {
  const counts = new Map<string, number>();
  for (const list of lists) for (const c of list) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

export function report(rows: EvalRow[]): string {
  const fraud = rows.filter((r) => r.isFraud);
  const legit = rows.filter((r) => !r.isFraud);
  const count = (rs: EvalRow[], d: Decision) => rs.filter((r) => r.decision === d).length;
  const flaggedRows = rows.filter((r) => flagged(r.decision));
  const tp = flaggedRows.filter((r) => r.isFraud).length;
  const blocked = rows.filter((r) => r.decision === "block");

  const lines: string[] = [];
  lines.push(`transactions ${rows.length.toLocaleString()}   fraud ${fraud.length} (${pct(fraud.length, rows.length).trim()})`);
  lines.push("");
  lines.push("decision mix        allow  step_up   review    block");
  for (const [name, rs] of [["legit", legit], ["fraud", fraud]] as const) {
    lines.push(
      `  ${name.padEnd(16)} ${(["allow", "step_up_3ds", "review", "block"] as Decision[]).map((d) => pct(count(rs, d), rs.length)).join("   ")}`,
    );
  }
  lines.push("");
  lines.push(`flagged (review+block): recall ${pct(tp, fraud.length)}   precision ${pct(tp, flaggedRows.length)}`);
  lines.push(
    `blocked:                recall ${pct(blocked.filter((r) => r.isFraud).length, fraud.length)}   precision ${pct(blocked.filter((r) => r.isFraud).length, blocked.length)}`,
  );
  for (const fpr of [0.005, 0.01, 0.02]) {
    const { recall, threshold } = recallAtFpr(rows, fpr);
    lines.push(`recall @ ${(fpr * 100).toFixed(1)}% FPR:     ${pct(recall, 1)}   (score >= ${threshold.toFixed(3)})`);
  }

  lines.push("");
  lines.push("scenario                n   flagged  blocked  step_up  pattern ok");
  const scenarios = [...new Set(fraud.map((r) => r.scenario))].sort();
  for (const s of scenarios) {
    const rs = fraud.filter((r) => r.scenario === s);
    const caught = rs.filter((r) => flagged(r.decision));
    lines.push(
      `  ${s.padEnd(18)} ${String(rs.length).padStart(5)}   ${pct(caught.length, rs.length)}  ${pct(count(rs, "block"), rs.length)}  ${pct(count(rs, "step_up_3ds"), rs.length)}   ${pct(caught.filter((r) => r.pattern === r.truePattern).length, caught.length)}`,
    );
  }

  const fp = legit.filter((r) => r.decision !== "allow");
  lines.push("");
  lines.push(`rules behind legit interventions (${fp.length} legit not allowed):`);
  for (const [code, n] of topCounts(fp.map((r) => r.reasonCodes), 8)) lines.push(`  ${code.padEnd(36)} ${n}`);
  return lines.join("\n");
}
