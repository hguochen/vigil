import type { SqlClient } from "./client.js";
import type { ScoreResponse, Transaction } from "../domain/transaction.js";

export type InsertOutcome = "inserted" | "duplicate" | "conflict";

interface DecisionRow {
  transaction_id: string;
  strategy: ScoreResponse["strategy"];
  decision: ScoreResponse["decision"];
  fraud_probability: number | null;
  pattern: ScoreResponse["pattern"];
  risk_level: ScoreResponse["risk_level"];
  reasons: ScoreResponse["reasons"];
  latency_ms: number;
  scored_at: Date | string;
}

const toResponse = (row: DecisionRow): ScoreResponse => ({
  transaction_id: row.transaction_id,
  decision: row.decision,
  fraud_probability: row.fraud_probability,
  pattern: row.pattern,
  risk_level: row.risk_level,
  reasons: row.reasons,
  strategy: row.strategy,
  latency_ms: row.latency_ms,
  scored_at: new Date(row.scored_at).toISOString(),
});

export class TransactionsRepo {
  constructor(private readonly db: SqlClient) {}

  /**
   * Inserts a transaction. A resubmission with an identical payload is a
   * "duplicate" (safe retry); a different payload under the same id is a "conflict".
   */
  async insert(txn: Transaction): Promise<InsertOutcome> {
    const payload = JSON.stringify(txn);
    const inserted = await this.db.query(
      `INSERT INTO transactions
         (transaction_id, occurred_at, customer_id, card_token, device_id, ip, email, amount_minor, currency, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (transaction_id) DO NOTHING
       RETURNING transaction_id`,
      [
        txn.transaction_id,
        txn.occurred_at,
        txn.customer.id,
        txn.card.token,
        txn.device.id,
        txn.device.ip,
        txn.customer.email,
        txn.amount_minor,
        txn.currency,
        payload,
      ],
    );
    if (inserted.rows.length > 0) return "inserted";

    const { rows } = await this.db.query<{ same: boolean }>(
      "SELECT payload = $2::jsonb AS same FROM transactions WHERE transaction_id = $1",
      [txn.transaction_id, payload],
    );
    return rows[0]?.same ? "duplicate" : "conflict";
  }

  async find(transactionId: string): Promise<Transaction | null> {
    const { rows } = await this.db.query<{ payload: Transaction }>(
      "SELECT payload FROM transactions WHERE transaction_id = $1",
      [transactionId],
    );
    return rows[0]?.payload ?? null;
  }

  async insertDecision(decision: ScoreResponse, raw: unknown = null): Promise<void> {
    await this.db.query(
      `INSERT INTO decisions
         (transaction_id, strategy, decision, fraud_probability, pattern, risk_level, reasons, latency_ms, scored_at, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb)`,
      [
        decision.transaction_id,
        decision.strategy,
        decision.decision,
        decision.fraud_probability,
        decision.pattern,
        decision.risk_level,
        JSON.stringify(decision.reasons),
        decision.latency_ms,
        decision.scored_at,
        raw === null ? null : JSON.stringify(raw),
      ],
    );
  }

  async latestDecision(transactionId: string): Promise<ScoreResponse | null> {
    const { rows } = await this.db.query<DecisionRow>(
      `SELECT transaction_id, strategy, decision, fraud_probability, pattern, risk_level,
              reasons, latency_ms, scored_at
         FROM decisions
        WHERE transaction_id = $1
        ORDER BY scored_at DESC, id DESC
        LIMIT 1`,
      [transactionId],
    );
    return rows[0] ? toResponse(rows[0]) : null;
  }
}
