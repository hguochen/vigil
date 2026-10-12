import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { RedisMemoryServer } from "redis-memory-server";
import { TransactionSchema } from "../src/domain/transaction.js";
import { computeFeatures } from "../src/features/compute.js";
import { loadGeoTable } from "../src/features/geo.js";
import { RedisFeatureStore } from "../src/features/redis-store.js";
import type { Features } from "../src/features/types.js";
import { featureStoreContract } from "./feature-store-contract.js";

let server: RedisMemoryServer;
let url: string;

beforeAll(async () => {
  server = await RedisMemoryServer.create();
  url = `redis://${await server.getHost()}:${await server.getPort()}`;
});

afterAll(async () => {
  await server?.stop();
});

const fresh = async () => {
  const redis = new Redis(url);
  await redis.flushdb();
  return new RedisFeatureStore(redis);
};

featureStoreContract("redis", fresh);

describe("RedisFeatureStore", () => {
  it("reproduces the golden feature vectors end to end", async () => {
    const golden = JSON.parse(
      readFileSync(new URL("../../contracts/golden/features.json", import.meta.url), "utf8"),
    ) as { streams: { transactions: unknown[]; features: Features[] }[] };
    const geo = loadGeoTable();

    for (const stream of golden.streams) {
      const store = await fresh();
      for (const [i, raw] of stream.transactions.entries()) {
        const txn = TransactionSchema.parse(raw);
        const actual = computeFeatures(txn, await store.snapshot(txn), geo);
        await store.record(txn);
        for (const [name, expected] of Object.entries(stream.features[i]!)) {
          const a = actual[name as keyof Features];
          if (a === null || expected === null) expect(a, `${txn.transaction_id}.${name}`).toBe(expected);
          else expect(Math.abs(a - expected), `${txn.transaction_id}.${name}`).toBeLessThanOrEqual(1e-6);
        }
      }
      await store.close();
    }
  });

  it("trims window data older than 7 days and sets TTLs", async () => {
    const store = await fresh();
    const redis = new Redis(url);
    const base = JSON.parse(
      readFileSync(new URL("../../contracts/golden/features.json", import.meta.url), "utf8"),
    ).streams[1].transactions[0];
    const txn = (id: string, occurred_at: string) => TransactionSchema.parse({ ...base, transaction_id: id, occurred_at });

    await store.record(txn("old", "2026-10-01T00:00:00Z"));
    await store.record(txn("new", "2026-10-09T00:00:00Z"));
    const cardKey = "vigil:card:edge_card";
    expect(await redis.zrange(cardKey, "0", "-1")).toEqual(["new|5000"]);
    expect(await redis.ttl(cardKey)).toBeGreaterThan(7 * 24 * 3600);
    expect(await redis.ttl("vigil:customer:edge_cust")).toBeGreaterThan(399 * 24 * 3600);

    await redis.quit();
    await store.close();
  });
});
