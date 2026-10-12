import type { Transaction } from "../domain/transaction.js";
import { computeFeatures } from "./compute.js";
import type { GeoTable } from "./geo.js";
import type { FeatureStore } from "./store.js";
import type { Features } from "./types.js";

export class FeatureExtractor {
  constructor(
    private readonly store: FeatureStore,
    private readonly geo: GeoTable,
  ) {}

  /** Computes features from history recorded before this transaction. */
  async extract(txn: Transaction): Promise<Features> {
    return computeFeatures(txn, await this.store.snapshot(txn), this.geo);
  }

  /** Call once per new transaction, after extract(). Never for idempotent retries. */
  async record(txn: Transaction): Promise<void> {
    await this.store.record(txn);
  }
}
