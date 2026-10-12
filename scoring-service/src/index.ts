import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPgClient } from "./db/client.js";
import { migrate } from "./db/migrations.js";

const config = loadConfig();
const db = createPgClient(config.DATABASE_URL);
const applied = await migrate(db);
const app = await buildApp(config, { db });
if (applied.length > 0) app.log.info({ migrations: applied }, "applied migrations");

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: config.PORT, host: config.HOST });
