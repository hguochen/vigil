import type { SqlClient } from "./client.js";

interface Migration {
  id: string;
  sql: string;
}

// Append-only. Never edit a migration once it has been committed.
export const MIGRATIONS: Migration[] = [
  {
    id: "001_transactions_and_decisions",
    sql: `
      CREATE TABLE transactions (
        transaction_id TEXT PRIMARY KEY,
        occurred_at    TIMESTAMPTZ NOT NULL,
        received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        customer_id    TEXT NOT NULL,
        card_token     TEXT NOT NULL,
        device_id      TEXT NOT NULL,
        ip             INET NOT NULL,
        email          TEXT NOT NULL,
        amount_minor   BIGINT NOT NULL CHECK (amount_minor >= 0),
        currency       CHAR(3) NOT NULL,
        payload        JSONB NOT NULL
      );
      CREATE INDEX transactions_customer_idx ON transactions (customer_id, occurred_at DESC);
      CREATE INDEX transactions_card_idx     ON transactions (card_token, occurred_at DESC);
      CREATE INDEX transactions_device_idx   ON transactions (device_id, occurred_at DESC);

      CREATE TABLE decisions (
        id                BIGSERIAL PRIMARY KEY,
        transaction_id    TEXT NOT NULL REFERENCES transactions (transaction_id) ON DELETE CASCADE,
        strategy          TEXT NOT NULL,
        decision          TEXT NOT NULL CHECK (decision IN ('allow', 'step_up_3ds', 'review', 'block')),
        fraud_probability DOUBLE PRECISION CHECK (fraud_probability BETWEEN 0 AND 1),
        pattern           TEXT,
        risk_level        TEXT,
        reasons           JSONB NOT NULL DEFAULT '[]',
        latency_ms        DOUBLE PRECISION NOT NULL,
        scored_at         TIMESTAMPTZ NOT NULL,
        raw               JSONB
      );
      CREATE INDEX decisions_transaction_idx ON decisions (transaction_id, scored_at DESC);
    `,
  },
  {
    id: "002_decision_features",
    sql: `ALTER TABLE decisions ADD COLUMN features JSONB;`,
  },
  {
    id: "003_labels",
    sql: `
      -- Ground truth arriving after the decision (chargebacks, review outcomes).
      -- Append-only: a later label supersedes an earlier one.
      CREATE TABLE labels (
        id             BIGSERIAL PRIMARY KEY,
        transaction_id TEXT NOT NULL REFERENCES transactions (transaction_id) ON DELETE CASCADE,
        label          TEXT NOT NULL CHECK (label IN ('fraud', 'legit')),
        source         TEXT,
        fraud_pattern  TEXT,
        reported_at    TIMESTAMPTZ NOT NULL,
        received_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX labels_transaction_idx ON labels (transaction_id, reported_at DESC);
    `,
  },
];

export async function migrate(db: SqlClient): Promise<string[]> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const { rows } = await db.query<{ id: string }>("SELECT id FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.id));

  const ran: string[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    // A single multi-statement exec runs on one connection, so BEGIN/COMMIT hold.
    await db.exec(`BEGIN;\n${m.sql}\nINSERT INTO schema_migrations (id) VALUES ('${m.id}');\nCOMMIT;`);
    ran.push(m.id);
  }
  return ran;
}
