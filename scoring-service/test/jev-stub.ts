import type { Decision, Pattern, RiskLevel } from "../src/domain/transaction.js";
import { RISK_LEVELS } from "../src/domain/transaction.js";

export interface StubAnswers {
  isFraud: number;
  pattern: Pattern;
  patternConfidence?: number;
  risk: RiskLevel;
  action: Decision;
  actionConfidence?: number;
}

/** A /v1/systemone success body in the real wire format (snake_case usage). */
export function wireBody(a: StubAnswers) {
  const level = RISK_LEVELS.indexOf(a.risk);
  const neighbor = level < RISK_LEVELS.length - 1 ? level + 1 : level - 1;
  return {
    model: "jev-1",
    answers: {
      is_fraud: { type: "noul", noul: a.isFraud },
      fraud_pattern: {
        type: "choice",
        choice: a.pattern,
        probabilities: { [a.pattern]: a.patternConfidence ?? 0.9 },
        confidence: a.patternConfidence ?? 0.9,
      },
      // Real shape: `score` is the expected level, `probabilities` the full distribution.
      risk_level: {
        type: "score",
        score: level * 0.8 + neighbor * 0.2,
        legend: Object.fromEntries(RISK_LEVELS.map((l, i) => [String(i), l])),
        probabilities: Object.fromEntries(
          RISK_LEVELS.map((_, i) => [String(i), i === level ? 0.8 : i === neighbor ? 0.2 : 0]),
        ),
        confidence: 0.8,
      },
      action: {
        type: "choice",
        choice: a.action,
        probabilities: { [a.action]: a.actionConfidence ?? 0.85 },
        confidence: a.actionConfidence ?? 0.85,
      },
    },
    usage: { input_tokens: 812, output_tokens: 4 },
  };
}

export interface StubCall {
  url: string;
  headers: Headers;
  body: { state: Record<string, unknown>; model: string; questions: Record<string, unknown> };
}

/** A fetch stub that records requests and replies with queued responses. */
export function stubFetch(...replies: (Response | ((signal: AbortSignal) => Promise<Response>))[]) {
  const calls: StubCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    const next = replies.length > 1 ? replies.shift()! : replies[0]!;
    return typeof next === "function" ? next(init!.signal!) : next.clone();
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

export const ok = (a: StubAnswers) =>
  new Response(JSON.stringify(wireBody(a)), {
    status: 200,
    headers: { "content-type": "application/json", "x-typesafe-request-id": "req_123" },
  });

export const fail = (status: number) =>
  new Response(JSON.stringify({ error: { message: "nope" } }), { status, headers: { "content-type": "application/json" } });

/** Never resolves until aborted (simulates a hung upstream). */
export const hang = (signal: AbortSignal) =>
  new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
