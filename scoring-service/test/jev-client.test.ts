import { describe, expect, it } from "vitest";
import { JevAnswerError, TypeSafeJevClient } from "../src/jev/client.js";
import type { JevState } from "../src/jev/mask.js";
import { QUESTION_SET_VERSION } from "../src/jev/questions.js";
import { fail, hang, ok, stubFetch, wireBody } from "./jev-stub.js";

const state = { order: { amount_usd: 42 } } as unknown as JevState;
const client = (f: typeof fetch, overrides: Partial<{ timeoutMs: number; maxRetries: number }> = {}) =>
  new TypeSafeJevClient({
    apiKey: "test-key",
    baseUrl: "https://jev.test",
    timeoutMs: 1000,
    maxRetries: 0,
    fetch: f,
    ...overrides,
  });

describe("TypeSafeJevClient", () => {
  it("sends all four questions with the masked state in one request", async () => {
    const stub = stubFetch(ok({ isFraud: 0.91, pattern: "stolen_card", risk: "critical", action: "block" }));
    await client(stub.fetch).classify(state);

    expect(stub.calls).toHaveLength(1);
    const [call] = stub.calls;
    expect(call!.url).toBe("https://jev.test/v1/systemone");
    expect(call!.headers.get("authorization")).toBe("Bearer test-key");
    expect(Object.keys(call!.body.questions)).toEqual(["is_fraud", "fraud_pattern", "risk_level", "action"]);
    expect(call!.body.state).toEqual({ order: { amount_usd: 42 } });
  });

  it("parses typed answers into a verdict", async () => {
    const stub = stubFetch(ok({ isFraud: 0.91, pattern: "stolen_card", risk: "critical", action: "block", actionConfidence: 0.77 }));
    const v = await client(stub.fetch).classify(state);
    expect(v).toMatchObject({
      fraudProbability: 0.91,
      pattern: { label: "stolen_card", confidence: 0.9 },
      riskLevel: { label: "critical" },
      action: { label: "block", confidence: 0.77 },
      model: "jev-1",
      requestId: "req_123",
      usage: { inputTokens: 812, outputTokens: 4 },
      questionSetVersion: QUESTION_SET_VERSION,
    });
    expect(v.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("rejects labels outside Vigil's enums", async () => {
    const body = wireBody({ isFraud: 0.5, pattern: "none", risk: "low", action: "allow" });
    (body.answers.action as { choice: string }).choice = "escalate_to_manager";
    const stub = stubFetch(new Response(JSON.stringify(body), { status: 200 }));
    await expect(client(stub.fetch).classify(state)).rejects.toBeInstanceOf(JevAnswerError);
  });

  it("reads the most likely risk level, not the fractional expected score", async () => {
    // Shape captured from a real jev-1.13.0 response.
    const body = wireBody({ isFraud: 0.94, pattern: "card_testing", risk: "low", action: "block" });
    body.answers.risk_level = {
      type: "score",
      score: 2.95,
      legend: { "0": "low", "1": "elevated", "2": "high", "3": "critical" },
      probabilities: { "0": 0, "1": 0, "2": 0.05, "3": 0.95 },
      confidence: 0.95,
    };
    const v = await client(stubFetch(new Response(JSON.stringify(body), { status: 200 })).fetch).classify(state);
    expect(v.riskLevel).toMatchObject({ label: "critical", confidence: 0.95, expectedLevel: 2.95 });
  });

  it("rejects a missing answer", async () => {
    const body = wireBody({ isFraud: 0.5, pattern: "none", risk: "low", action: "allow" });
    delete (body.answers as Record<string, unknown>).risk_level;
    const stub = stubFetch(new Response(JSON.stringify(body), { status: 200 }));
    await expect(client(stub.fetch).classify(state)).rejects.toThrow(/risk_level/);
  });

  it("surfaces API errors", async () => {
    await expect(client(stubFetch(fail(401)).fetch).classify(state)).rejects.toThrow(/401/);
  });

  it("times out a hung request", async () => {
    const started = Date.now();
    await expect(client(stubFetch(hang).fetch, { timeoutMs: 50 }).classify(state)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("retries a transient 5xx", async () => {
    const stub = stubFetch(fail(503), ok({ isFraud: 0.1, pattern: "none", risk: "low", action: "allow" }));
    const v = await client(stub.fetch, { maxRetries: 1 }).classify(state);
    expect(v.action.label).toBe("allow");
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[1]!.headers.get("x-typesafe-retry-count")).toBe("1");
  }, 15_000);
});
