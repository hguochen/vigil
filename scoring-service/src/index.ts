import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPgClient } from "./db/client.js";
import { migrate } from "./db/migrations.js";
import { FeatureExtractor } from "./features/extractor.js";
import { loadGeoTable } from "./features/geo.js";
import { RedisFeatureStore } from "./features/redis-store.js";
import { InMemoryFeatureStore, type FeatureStore } from "./features/store.js";
import { createScorer } from "./scoring/factory.js";

const config = loadConfig();
const geo = loadGeoTable(config.GEO_CITIES_PATH);

// Build the scorer first so misconfiguration (e.g. a missing Jev key) fails fast.
let app: FastifyInstance | undefined;
const scorer = createScorer(config, {
  geo,
  onJevError: (err, txn) =>
    app?.log.warn({ err, transaction_id: txn.transaction_id }, "Jev unavailable; fell back to rules"),
});

const db = createPgClient(config.DATABASE_URL);
const applied = await migrate(db);
const store: FeatureStore =
  config.FEATURE_STORE === "redis" ? RedisFeatureStore.connect(config.REDIS_URL) : new InMemoryFeatureStore();
const features = new FeatureExtractor(store, geo);
app = await buildApp(config, { db, features, scorer });
if (applied.length > 0) app.log.info({ migrations: applied }, "applied migrations");
app.log.info({ featureStore: config.FEATURE_STORE, strategy: scorer.strategy }, "scoring ready");

const shutdown = async (signal: string) => {
  app?.log.info({ signal }, "shutting down");
  await app?.close();
  await store.close?.();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: config.PORT, host: config.HOST });
