import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CachingJevClient, pool, stateKey, stratifiedSample } from "../src/eval/benchmark.js";
import type { JevClient, JevVerdict } from "../src/jev/client.js";
import type { JevState } from "../src/jev/mask.js";

const verdict = (p: number): JevVerdict => ({
  fraudProbability: p,
  pattern: { label: "none", confidence: 0.9, probabilities: {} },
  riskLevel: { label: "low", confidence: 0.9, probabilities: {}, expectedLevel: 0.1 },
  action: { label: "allow", confidence: 0.9, probabilities: {} },
  model: "jev-1",
  requestId: "r",
  usage: { inputTokens: 1600, outputTokens: 150 },
  latencyMs: 120,
  questionSetVersion: "v",
});
const state = (n: number) => ({ order: { amount_usd: n } }) as unknown as JevState;

describe("stratifiedSample", () => {
  const isFraud = Array.from({ length: 1000 }, (_, i) => i % 50 === 0); // 20 fraud, 980 legit

  it("keeps every fraud row and weights legit rows back to full size", () => {
    const s = stratifiedSample(isFraud, 98, 1);
    const fraud = s.indices.filter((i) => isFraud[i]);
    const legit = s.indices.filter((i) => !isFraud[i]);
    expect(fraud).toHaveLength(20);
    expect(legit).toHaveLength(98);
    expect(s.weights.get(legit[0]!)).toBeCloseTo(10);
    const totalWeight = [...s.weights.values()].reduce((a, b) => a + b, 0);
    expect(totalWeight).toBeCloseTo(1000);
    expect(s.indices).toEqual([...s.indices].sort((a, b) => a - b));
  });

  it("is reproducible for a seed and differs across seeds", () => {
    expect(stratifiedSample(isFraud, 50, 7).indices).toEqual(stratifiedSample(isFraud, 50, 7).indices);
    expect(stratifiedSample(isFraud, 50, 7).indices).not.toEqual(stratifiedSample(isFraud, 50, 8).indices);
  });

  it("takes all legit rows when the sample is larger than the data", () => {
    const s = stratifiedSample(isFraud, 5000, 1);
    expect(s.indices).toHaveLength(1000);
    expect(s.weights.get(1)).toBe(1);
  });
});

describe("CachingJevClient", () => {
  it("calls Jev once per distinct state and persists across instances", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "jev-cache-")), "cache.jsonl");
    const classify = vi.fn(async (s: JevState) => verdict((s as unknown as { order: { amount_usd: number } }).order.amount_usd / 100));
    const inner: JevClient = { classify };

    const a = new CachingJevClient(inner, "jev-latest", path);
    await a.classify(state(10));
    await a.classify(state(10));
    await a.classify(state(20));
    expect(classify).toHaveBeenCalledTimes(2);
    expect([a.hits, a.misses]).toEqual([1, 2]);

    const b = new CachingJevClient(inner, "jev-latest", path);
    expect(b.size).toBe(2);
    expect(b.has(state(20))).toBe(true);
    expect((await b.classify(state(20))).fraudProbability).toBe(0.2);
    expect(classify).toHaveBeenCalledTimes(2);
  });

  it("keys on model and question set as well as state", () => {
    expect(stateKey(state(1), "jev-a")).not.toBe(stateKey(state(1), "jev-b"));
  });

  it("stores only state hashes and verdicts", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "jev-cache-")), "cache.jsonl");
    await new CachingJevClient({ classify: async () => verdict(0.5) }, "m", path).classify(state(42));
    const line = JSON.parse(readFileSync(path, "utf8").trim());
    expect(Object.keys(line)).toEqual(["key", "verdict"]);
    expect(line.key).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("pool", () => {
  it("bounds concurrency and preserves order", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await pool([5, 1, 4, 2, 3], 2, async (n) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, n * 3));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });
});
