import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { SqlClient } from "../src/db/client.js";
import { createTestDb } from "./pglite.js";
import { FeatureExtractor } from "../src/features/extractor.js";
import { loadGeoTable } from "../src/features/geo.js";
import { InMemoryFeatureStore } from "../src/features/store.js";

describe("GET /health", () => {
  let app: FastifyInstance;
  let db: SqlClient;

  beforeAll(async () => {
    db = await createTestDb();
    app = await buildApp(loadConfig({ LOG_LEVEL: "silent" }), {
      db,
      features: new FeatureExtractor(new InMemoryFeatureStore(), loadGeoTable()),
    });
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it("returns ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});
