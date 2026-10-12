import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { SqlClient } from "../src/db/client.js";
import type { Scorer } from "../src/scoring/scorer.js";
import { makeTransaction } from "./fixtures.js";
import { createTestDb } from "./pglite.js";
import { FeatureExtractor } from "../src/features/extractor.js";
import { loadGeoTable } from "../src/features/geo.js";
import { InMemoryFeatureStore } from "../src/features/store.js";

const API_KEY = "test-key";
const headers = { "x-api-key": API_KEY };

describe("transactions API", () => {
  let app: FastifyInstance;
  let db: SqlClient;
  let scorer: Scorer & { score: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    db = await createTestDb();
    scorer = {
      strategy: "rules",
      score: vi.fn(async () => ({
        decision: "review" as const,
        fraud_probability: 0.61,
        pattern: "card_testing" as const,
        risk_level: "high" as const,
        reasons: [{ code: "VELOCITY_CARD_1H", message: "6 charges on this card in 1h" }],
        raw: { hits: ["VELOCITY_CARD_1H"] },
      })),
    };
    app = await buildApp(loadConfig({ LOG_LEVEL: "silent", VIGIL_API_KEY: API_KEY }), {
      db,
      scorer,
      features: new FeatureExtractor(new InMemoryFeatureStore(), loadGeoTable()),
    });
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  const score = (payload: unknown) =>
    app.inject({ method: "POST", url: "/v1/transactions/score", headers, payload: payload as object });

  it("requires an API key", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/transactions/score", payload: makeTransaction() });
    expect(res.statusCode).toBe(401);
  });

  it("scores and persists a transaction", async () => {
    const res = await score(makeTransaction());
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      transaction_id: "txn_001",
      decision: "review",
      fraud_probability: 0.61,
      pattern: "card_testing",
      risk_level: "high",
      strategy: "rules",
    });
    expect(body.latency_ms).toBeGreaterThanOrEqual(0);
    expect(body).not.toHaveProperty("raw");

    const { rows } = await db.query<{ raw: unknown }>("SELECT raw FROM decisions WHERE transaction_id = 'txn_001'");
    expect(rows[0]?.raw).toEqual({ hits: ["VELOCITY_CARD_1H"] });
  });

  it("returns 400 with field paths for invalid input", async () => {
    const res = await score({ ...makeTransaction(), amount_minor: -5, currency: "usd" });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("invalid_request");
    expect(body.issues.map((i: { path: string }) => i.path)).toEqual(
      expect.arrayContaining(["amount_minor", "currency"]),
    );
    expect(scorer.score).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/transactions/score",
      headers: { ...headers, "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("is idempotent: a retry returns the stored decision without rescoring", async () => {
    const first = (await score(makeTransaction())).json();
    const retry = await score(makeTransaction());
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first);
    expect(scorer.score).toHaveBeenCalledTimes(1);
  });

  it("returns 409 when an id is reused with a different payload", async () => {
    await score(makeTransaction());
    const res = await score(makeTransaction({ amount_minor: 1 }));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("conflict");
  });

  it("scores a duplicate that was persisted but never scored", async () => {
    scorer.score.mockRejectedValueOnce(new Error("scorer down"));
    const failed = await score(makeTransaction());
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: "internal_error", message: "Internal server error" });

    const retry = await score(makeTransaction());
    expect(retry.statusCode).toBe(200);
    expect(retry.json().decision).toBe("review");
  });

  it("gets a transaction with its latest decision", async () => {
    await score(makeTransaction());
    const res = await app.inject({ method: "GET", url: "/v1/transactions/txn_001", headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().transaction).toEqual(makeTransaction());
    expect(res.json().decision.decision).toBe("review");
  });

  it("returns 404 for an unknown transaction", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/transactions/nope", headers });
    expect(res.statusCode).toBe(404);
  });

  it("passes features to the scorer and stores them with the decision", async () => {
    await score(makeTransaction());
    const features = scorer.score.mock.calls[0]![1];
    expect(features).toMatchObject({ amount_usd: 129.99, customer_prior_txns: 0 });
    const { rows } = await db.query<{ features: Record<string, unknown> }>(
      "SELECT features FROM decisions WHERE transaction_id = 'txn_001'",
    );
    expect(rows[0]?.features).toEqual(features);
  });

  it("builds history across transactions but not across retries", async () => {
    await score(makeTransaction());
    await score(makeTransaction()); // idempotent retry: not recorded again
    await score({ ...makeTransaction(), transaction_id: "txn_002", occurred_at: "2026-10-11T18:45:00Z" });
    const second = scorer.score.mock.calls.at(-1)![1];
    expect(second).toMatchObject({ customer_prior_txns: 1, card_txn_count_1h: 1, minutes_since_last_customer_txn: 15 });
  });

  it("does not record a transaction whose scoring failed", async () => {
    scorer.score.mockRejectedValueOnce(new Error("scorer down"));
    await score(makeTransaction());
    await score(makeTransaction()); // retry scores it now
    expect(scorer.score.mock.calls.at(-1)![1].customer_prior_txns).toBe(0);
  });
});
