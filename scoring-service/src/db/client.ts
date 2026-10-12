import pg from "pg";

export interface QueryResult<T> {
  rows: T[];
}

// Minimal surface shared by node-postgres and PGlite, so tests can run
// against embedded Postgres without Docker.
export interface SqlClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Run one or more statements without parameters (used for migrations). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export function createPgClient(connectionString: string): SqlClient {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return {
    async query<T>(text: string, params?: unknown[]) {
      const res = await pool.query(text, params);
      return { rows: res.rows as T[] };
    },
    async exec(sql) {
      await pool.query(sql);
    },
    close: () => pool.end(),
  };
}
