import { performance } from "node:perf_hooks";
import type { FastifyInstance } from "fastify";
import { TransactionSchema, type ScoreResponse, type Transaction } from "../domain/transaction.js";
import type { TransactionsRepo } from "../db/transactions-repo.js";
import type { Scorer } from "../scoring/scorer.js";

interface Deps {
  repo: TransactionsRepo;
  scorer: Scorer;
}

const round = (ms: number) => Math.round(ms * 100) / 100;

export async function transactionRoutes(app: FastifyInstance, { repo, scorer }: Deps): Promise<void> {
  async function scoreAndStore(txn: Transaction, startedAt: number): Promise<ScoreResponse> {
    const { raw, ...result } = await scorer.score(txn);
    const response: ScoreResponse = {
      transaction_id: txn.transaction_id,
      ...result,
      strategy: scorer.strategy,
      latency_ms: round(performance.now() - startedAt),
      scored_at: new Date().toISOString(),
    };
    await repo.insertDecision(response, raw ?? null);
    return response;
  }

  app.post("/v1/transactions/score", async (request, reply) => {
    const startedAt = performance.now();
    const parsed = TransactionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Transaction failed validation",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const txn = parsed.data;

    const outcome = await repo.insert(txn);
    if (outcome === "conflict") {
      return reply.code(409).send({
        error: "conflict",
        message: "transaction_id was already submitted with a different payload",
      });
    }
    if (outcome === "duplicate") {
      // Idempotent retry: return the stored decision. If an earlier attempt
      // persisted the transaction but crashed before scoring, score it now.
      const existing = await repo.latestDecision(txn.transaction_id);
      if (existing) return existing;
    }
    return scoreAndStore(txn, startedAt);
  });

  app.get<{ Params: { transactionId: string } }>("/v1/transactions/:transactionId", async (request, reply) => {
    const { transactionId } = request.params;
    const transaction = await repo.find(transactionId);
    if (!transaction) {
      return reply.code(404).send({ error: "not_found", message: "Transaction not found" });
    }
    return { transaction, decision: await repo.latestDecision(transactionId) };
  });
}
