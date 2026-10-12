import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Transaction } from "../src/domain/transaction.js";
import type { FeatureStore } from "../src/features/store.js";
import { makeTransaction } from "./fixtures.js";

const T0 = Date.parse("2026-10-11T12:00:00Z");
const MIN = 60_000;

function at(minutesAfterT0: number, overrides: Partial<Transaction> = {}, id = `t${minutesAfterT0}`): Transaction {
  const base = makeTransaction(overrides);
  return { ...base, transaction_id: id, occurred_at: new Date(T0 + minutesAfterT0 * MIN).toISOString() };
}

/** Behaviour every FeatureStore implementation must satisfy. */
export function featureStoreContract(name: string, create: () => Promise<FeatureStore>) {
  describe(`FeatureStore contract: ${name}`, () => {
    let store: FeatureStore;

    beforeEach(async () => {
      store = await create();
    });

    afterEach(async () => {
      await store.close?.();
    });

    it("returns an empty snapshot for unseen keys", async () => {
      const s = await store.snapshot(at(0));
      expect(s).toEqual({
        cardEvents24h: [],
        deviceEvents24h: [],
        ipCount1h: 0,
        emailCount24h: 0,
        deviceDistinctCards24h: 0,
        deviceDistinctAccounts24h: 0,
        cardDistinctAccounts24h: 0,
        shippingDistinctAccounts7d: 0,
        customer: null,
        customerHasDevice: false,
        customerHasCard: false,
        cardCustomers: { total: 0, includesCurrent: false },
      });
    });

    it("windows are [t - W, t): inclusive start, exclusive end", async () => {
      await store.record(at(0, { amount_minor: 100 }));
      // exactly 24h later: still inside the 24h window (inclusive lower bound)
      expect((await store.snapshot(at(24 * 60))).cardEvents24h).toEqual([{ ts: T0, amountMinor: 100 }]);
      // one ms past 24h: outside
      const later = { ...at(0), occurred_at: new Date(T0 + 24 * 60 * MIN + 1).toISOString() };
      expect((await store.snapshot(later)).cardEvents24h).toEqual([]);
      // same timestamp: not counted (exclusive upper bound)
      expect((await store.snapshot(at(0, {}, "other"))).deviceEvents24h).toEqual([]);
    });

    it("counts prior events per key", async () => {
      await store.record(at(0));
      await store.record(at(10));
      await store.record(at(20, { device: { id: "dev_other", ip: "100.64.0.1" } }));
      const s = await store.snapshot(at(30));
      expect(s.cardEvents24h).toHaveLength(3);
      expect([...s.deviceEvents24h].sort()).toEqual([T0, T0 + 10 * MIN]);
      expect(s.ipCount1h).toBe(2);
      expect(s.emailCount24h).toBe(3);
    });

    it("matches emails case-insensitively", async () => {
      await store.record(at(0));
      const upper = at(5);
      upper.customer.email = "JANE.DOE@Example.com";
      expect((await store.snapshot(upper)).emailCount24h).toBe(1);
    });

    it("counts distinct values in window", async () => {
      const card = (token: string) => ({ ...makeTransaction().card, token });
      await store.record(at(0, { card: card("c1") }));
      await store.record(at(1, { card: card("c2") }));
      await store.record(at(2, { card: card("c2") }));
      await store.record(at(3, { card: card("c3"), customer: { ...makeTransaction().customer, id: "cust_b" } }));
      const s = await store.snapshot(at(4));
      expect(s.deviceDistinctCards24h).toBe(3);
      expect(s.deviceDistinctAccounts24h).toBe(2);
    });

    it("groups shipping addresses by normalized key over 7 days", async () => {
      const addr = (line1: string) => ({ ...makeTransaction().shipping_address, line1 });
      const cust = (id: string) => ({ ...makeTransaction().customer, id });
      await store.record(at(0, { customer: cust("a"), shipping_address: addr("12 Oak Ave") }));
      await store.record(at(60, { customer: cust("b"), shipping_address: addr("12 oak ave Apt 3") }));
      await store.record(at(6 * 24 * 60, { customer: cust("c"), shipping_address: addr("12 Oak Ave #9") }));
      const s = await store.snapshot(at(6 * 24 * 60 + 1, { shipping_address: addr("12 Oak Ave") }));
      expect(s.shippingDistinctAccounts7d).toBe(3);
    });

    it("tracks the customer profile and card sharing", async () => {
      await store.record(at(0, { amount_minor: 1_000 }));
      await store.record(at(10, { amount_minor: 3_000, device: { id: "dev_2", ip: "100.78.1.1" } }));
      await store.record(at(20, { customer: { ...makeTransaction().customer, id: "cust_other" } }));
      const s = await store.snapshot(at(30));
      expect(s.customer).toEqual({ count: 2, sumMinor: 4_000, lastTs: T0 + 10 * MIN, lastIp: "100.78.1.1" });
      expect(s.customerHasDevice).toBe(true);
      expect(s.customerHasCard).toBe(true);
      expect(s.cardCustomers).toEqual({ total: 2, includesCurrent: true });

      const stranger = await store.snapshot(at(30, { customer: { ...makeTransaction().customer, id: "new" } }));
      expect(stranger.customer).toBeNull();
      expect(stranger.cardCustomers).toEqual({ total: 2, includesCurrent: false });
    });

    it("snapshot does not modify state", async () => {
      await store.snapshot(at(0));
      expect((await store.snapshot(at(1))).cardEvents24h).toEqual([]);
    });
  });
}
