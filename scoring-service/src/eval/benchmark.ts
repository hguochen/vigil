import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JevClient, JevVerdict } from "../jev/client.js";
import type { JevState } from "../jev/mask.js";
import { QUESTION_SET_VERSION } from "../jev/questions.js";

/** Small seeded PRNG (mulberry32) so samples are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Sample {
  /** Indices into the dataset, in time order. */
  indices: number[];
  /** Weight per sampled index: how many dataset rows it stands for. */
  weights: Map<number, number>;
}

/**
 * All fraud rows plus a seeded random sample of legitimate rows. Legit rows are
 * weighted by (total legit / sampled legit) so weighted rates match the full data.
 */
export function stratifiedSample(isFraud: boolean[], legitSample: number, seed: number): Sample {
  const fraud: number[] = [];
  const legit: number[] = [];
  isFraud.forEach((f, i) => (f ? fraud : legit).push(i));
  const take = Math.min(legitSample, legit.length);
  // Partial Fisher-Yates: the first `take` entries become a uniform sample.
  const pool = [...legit];
  const next = rng(seed);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(next() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  const chosenLegit = pool.slice(0, take);
  const legitWeight = take > 0 ? legit.length / take : 0;
  const weights = new Map<number, number>();
  for (const i of fraud) weights.set(i, 1);
  for (const i of chosenLegit) weights.set(i, legitWeight);
  return { indices: [...weights.keys()].sort((a, b) => a - b), weights };
}

export function stateKey(state: JevState, model: string): string {
  return createHash("sha256").update(`${model}\n${QUESTION_SET_VERSION}\n${JSON.stringify(state)}`).digest("hex");
}

/**
 * Persists every Jev verdict by a hash of (model, question set, masked state),
 * so benchmark reruns and report tweaks never pay for the same call twice.
 * Only masked state hashes and verdicts are written; no personal data.
 */
export class CachingJevClient implements JevClient {
  private readonly cache = new Map<string, JevVerdict>();
  hits = 0;
  misses = 0;

  constructor(
    private readonly inner: JevClient,
    private readonly model: string,
    private readonly path: string,
  ) {
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line) continue;
        const { key, verdict } = JSON.parse(line) as { key: string; verdict: JevVerdict };
        this.cache.set(key, verdict);
      }
    } else {
      mkdirSync(dirname(path), { recursive: true });
    }
  }

  has(state: JevState): boolean {
    return this.cache.has(stateKey(state, this.model));
  }

  get size(): number {
    return this.cache.size;
  }

  async classify(state: JevState): Promise<JevVerdict> {
    const key = stateKey(state, this.model);
    const cached = this.cache.get(key);
    if (cached) {
      this.hits++;
      return cached;
    }
    const verdict = await this.inner.classify(state);
    this.misses++;
    this.cache.set(key, verdict);
    appendFileSync(this.path, JSON.stringify({ key, verdict }) + "\n");
    return verdict;
  }
}

/** Runs `fn` over items with at most `concurrency` in flight; results keep input order. */
export async function pool<T, R>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
