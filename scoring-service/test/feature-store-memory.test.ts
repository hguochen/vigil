import { describe, expect, it } from "vitest";
import { FeatureExtractor } from "../src/features/extractor.js";
import { loadGeoTable } from "../src/features/geo.js";
import { InMemoryFeatureStore } from "../src/features/store.js";
import { featureStoreContract } from "./feature-store-contract.js";
import { makeTransaction } from "./fixtures.js";

featureStoreContract("in-memory", async () => new InMemoryFeatureStore());

describe("FeatureExtractor", () => {
  it("sees a transaction only after it is recorded", async () => {
    const extractor = new FeatureExtractor(new InMemoryFeatureStore(), loadGeoTable());
    const first = makeTransaction();
    const second = { ...makeTransaction(), transaction_id: "txn_002", occurred_at: "2026-10-11T18:40:00Z" };

    expect((await extractor.extract(first)).customer_prior_txns).toBe(0);
    await extractor.record(first);
    const f = await extractor.extract(second);
    expect(f.customer_prior_txns).toBe(1);
    expect(f.card_txn_count_1h).toBe(1);
    expect(f.minutes_since_last_customer_txn).toBe(10);
  });
});
