import { PGlite } from "@electric-sql/pglite";
import type { SqlClient } from "../src/db/client.js";
import { migrate } from "../src/db/migrations.js";

/** Fresh in-memory Postgres with all migrations applied. */
export async function createTestDb(): Promise<SqlClient> {
  const pg = new PGlite();
  const client: SqlClient = {
    async query<T>(text: string, params?: unknown[]) {
      const res = await pg.query<T>(text, params);
      return { rows: res.rows };
    },
    async exec(sql) {
      await pg.exec(sql);
    },
    close: () => pg.close(),
  };
  await migrate(client);
  return client;
}
