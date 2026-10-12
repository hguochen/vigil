import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqlClient } from "../src/db/client.js";
import { migrate } from "../src/db/migrations.js";
import { TransactionsRepo } from "../src/db/transactions-repo.js";
import type { ScoreResponse } from "../src/domain/transaction.js";
import { makeTransaction } from "./fixtures.js";
import { createTestDb } from "./pglite.js";

const decision = (overrides: Partial<ScoreResponse> = {}): ScoreResponse => ({
  transaction_id: "txn_001",
  decision: "allow",
  fraud_probability: null,
  pattern: null,
  risk_level: null,
  reasons: [],
  strategy: "passthrough",
  latency_ms: 1.5,
  scored_at: "2026-10-11T18:30:01.000Z",
  ...overrides,
});

describe("TransactionsRepo", () => {
  let db: SqlClient;
  let repo: TransactionsRepo;

  beforeEach(async () => {
    db = await createTestDb();
    repo = new TransactionsRepo(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("migrations are idempotent", async () => {
    expect(await migrate(db)).toEqual([]);
  });

  it("round-trips a transaction payload", async () => {
    const txn = makeTransaction();
    expect(await repo.insert(txn)).toBe("inserted");
    expect(await repo.find(txn.transaction_id)).toEqual(txn);
  });

  it("returns null for an unknown transaction", async () => {
    expect(await repo.find("missing")).toBeNull();
  });

  it("treats an identical resubmission as a duplicate", async () => {
    const txn = makeTransaction();
    await repo.insert(txn);
    // Same content, different key order: jsonb equality is semantic.
    const reordered = Object.fromEntries(Object.entries(txn).reverse()) as typeof txn;
    expect(await repo.insert(reordered)).toBe("duplicate");
  });

  it("flags a different payload under the same id as a conflict", async () => {
    await repo.insert(makeTransaction());
    expect(await repo.insert(makeTransaction({ amount_minor: 1 }))).toBe("conflict");
  });

  it("returns the latest decision", async () => {
    await repo.insert(makeTransaction());
    await repo.insertDecision(decision());
    await repo.insertDecision(
      decision({
        decision: "review",
        strategy: "rules",
        fraud_probability: 0.42,
        reasons: [{ code: "VELOCITY_CARD_1H", message: "5 charges in 1h" }],
        scored_at: "2026-10-11T18:31:00.000Z",
      }),
      { note: "raw classifier output" },
    );
    const latest = await repo.latestDecision("txn_001");
    expect(latest).toMatchObject({ decision: "review", strategy: "rules", fraud_probability: 0.42 });
    expect(latest?.reasons).toHaveLength(1);
    expect(latest?.scored_at).toBe("2026-10-11T18:31:00.000Z");
  });

  it("rejects a decision outside the allowed set", async () => {
    await repo.insert(makeTransaction());
    await expect(repo.insertDecision(decision({ decision: "maybe" as never }))).rejects.toThrow();
  });
});
