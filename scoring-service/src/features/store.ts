import type { Transaction } from "../domain/transaction.js";
import { addressKey } from "./derive.js";
import { DAY_MS, HOUR_MS, WEEK_MS, type HistorySnapshot } from "./types.js";

export interface FeatureStore {
  /** Reads history for `txn` without modifying state. */
  snapshot(txn: Transaction): Promise<HistorySnapshot>;
  /** Records `txn` so later transactions see it. */
  record(txn: Transaction): Promise<void>;
  close?(): Promise<void>;
}

/** Keys shared by every store implementation. */
export function keysFor(txn: Transaction) {
  return {
    t: Date.parse(txn.occurred_at),
    card: txn.card.token,
    device: txn.device.id,
    ip: txn.device.ip,
    email: txn.customer.email.toLowerCase(),
    customer: txn.customer.id,
    shipping: addressKey(txn.shipping_address),
  };
}

type Distinct = Map<string, Map<string, number>>; // key -> value -> latest ts

function countInWindow(m: Distinct, key: string, from: number, to: number): number {
  let n = 0;
  for (const ts of m.get(key)?.values() ?? []) if (ts >= from && ts < to) n++;
  return n;
}

function touch(m: Distinct, key: string, value: string, ts: number): void {
  let inner = m.get(key);
  if (!inner) m.set(key, (inner = new Map()));
  inner.set(value, Math.max(inner.get(value) ?? -Infinity, ts));
}

function push<T>(m: Map<string, T[]>, key: string, value: T): void {
  const list = m.get(key);
  if (list) list.push(value);
  else m.set(key, [value]);
}

function addTo(m: Map<string, Set<string>>, key: string, value: string): void {
  let set = m.get(key);
  if (!set) m.set(key, (set = new Set()));
  set.add(value);
}

/** Unbounded in-process store for tests, replays and offline evaluation. */
export class InMemoryFeatureStore implements FeatureStore {
  private cardEvents = new Map<string, { ts: number; amountMinor: number }[]>();
  private deviceEvents = new Map<string, number[]>();
  private ipEvents = new Map<string, number[]>();
  private emailEvents = new Map<string, number[]>();
  private deviceCards: Distinct = new Map();
  private deviceAccounts: Distinct = new Map();
  private cardAccounts: Distinct = new Map();
  private shippingAccounts: Distinct = new Map();
  private customers = new Map<string, { count: number; sumMinor: number; lastTs: number; lastIp: string }>();
  private customerDevices = new Map<string, Set<string>>();
  private customerCards = new Map<string, Set<string>>();
  private cardCustomers = new Map<string, Set<string>>();

  async snapshot(txn: Transaction): Promise<HistorySnapshot> {
    const k = keysFor(txn);
    const inWindow = (ts: number, w: number) => ts >= k.t - w && ts < k.t;
    const cardCustomers = this.cardCustomers.get(k.card);
    const customer = this.customers.get(k.customer);
    return {
      cardEvents24h: (this.cardEvents.get(k.card) ?? []).filter((e) => inWindow(e.ts, DAY_MS)),
      deviceEvents24h: (this.deviceEvents.get(k.device) ?? []).filter((ts) => inWindow(ts, DAY_MS)),
      ipCount1h: (this.ipEvents.get(k.ip) ?? []).filter((ts) => inWindow(ts, HOUR_MS)).length,
      emailCount24h: (this.emailEvents.get(k.email) ?? []).filter((ts) => inWindow(ts, DAY_MS)).length,
      deviceDistinctCards24h: countInWindow(this.deviceCards, k.device, k.t - DAY_MS, k.t),
      deviceDistinctAccounts24h: countInWindow(this.deviceAccounts, k.device, k.t - DAY_MS, k.t),
      cardDistinctAccounts24h: countInWindow(this.cardAccounts, k.card, k.t - DAY_MS, k.t),
      shippingDistinctAccounts7d: countInWindow(this.shippingAccounts, k.shipping, k.t - WEEK_MS, k.t),
      customer: customer ? { ...customer } : null,
      customerHasDevice: this.customerDevices.get(k.customer)?.has(k.device) ?? false,
      customerHasCard: this.customerCards.get(k.customer)?.has(k.card) ?? false,
      cardCustomers: { total: cardCustomers?.size ?? 0, includesCurrent: cardCustomers?.has(k.customer) ?? false },
    };
  }

  async record(txn: Transaction): Promise<void> {
    const k = keysFor(txn);
    push(this.cardEvents, k.card, { ts: k.t, amountMinor: txn.amount_minor });
    push(this.deviceEvents, k.device, k.t);
    push(this.ipEvents, k.ip, k.t);
    push(this.emailEvents, k.email, k.t);
    touch(this.deviceCards, k.device, k.card, k.t);
    touch(this.deviceAccounts, k.device, k.customer, k.t);
    touch(this.cardAccounts, k.card, k.customer, k.t);
    touch(this.shippingAccounts, k.shipping, k.customer, k.t);

    const prev = this.customers.get(k.customer);
    this.customers.set(k.customer, {
      count: (prev?.count ?? 0) + 1,
      sumMinor: (prev?.sumMinor ?? 0) + txn.amount_minor,
      lastTs: k.t,
      lastIp: k.ip,
    });
    addTo(this.customerDevices, k.customer, k.device);
    addTo(this.customerCards, k.customer, k.card);
    addTo(this.cardCustomers, k.card, k.customer);
  }
}
