import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPgClient } from "./db/client.js";
import { migrate } from "./db/migrations.js";
import { FeatureExtractor } from "./features/extractor.js";
import { loadGeoTable } from "./features/geo.js";
import { RedisFeatureStore } from "./features/redis-store.js";
import { InMemoryFeatureStore, type FeatureStore } from "./features/store.js";
import { DecisionPolicy } from "./decision/policy.js";
import { RulesEngine } from "./rules/engine.js";
import { RulesScorer } from "./scoring/rules-scorer.js";
import { passthroughScorer } from "./scoring/scorer.js";

const config = loadConfig();
const db = createPgClient(config.DATABASE_URL);
const applied = await migrate(db);
const store: FeatureStore =
  config.FEATURE_STORE === "redis" ? RedisFeatureStore.connect(config.REDIS_URL) : new InMemoryFeatureStore();
const features = new FeatureExtractor(store, loadGeoTable(config.GEO_CITIES_PATH));
const scorer =
  config.SCORING_STRATEGY === "rules"
    ? new RulesScorer(RulesEngine.load(config.RULES_PATH), DecisionPolicy.load(config.POLICY_PATH))
    : passthroughScorer;
const app = await buildApp(config, { db, features, scorer });
if (applied.length > 0) app.log.info({ migrations: applied }, "applied migrations");
app.log.info({ featureStore: config.FEATURE_STORE, strategy: scorer.strategy }, "scoring ready");

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await store.close?.();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: config.PORT, host: config.HOST });
