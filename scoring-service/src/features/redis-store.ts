import { Redis } from "ioredis";
import type { Transaction } from "../domain/transaction.js";
import type { FeatureStore } from "./store.js";
import { keysFor } from "./store.js";
import { DAY_MS, HOUR_MS, WEEK_MS, type HistorySnapshot } from "./types.js";

const WINDOW_TTL_S = 8 * 24 * 3600; // trimmed to 7 days on write, expire after 8 days idle
const PROFILE_TTL_S = 400 * 24 * 3600;

const key = (kind: string, id: string) => `vigil:${kind}:${encodeURIComponent(id)}`;

type PipelineResult = [Error | null, unknown][] | null;

function results(res: PipelineResult): unknown[] {
  if (!res) throw new Error("redis pipeline returned no results");
  return res.map(([err, value]) => {
    if (err) throw err;
    return value;
  });
}

/**
 * Production feature store. Reads are one pipelined round trip; writes are one
 * MULTI transaction. Event-time windows use sorted sets scored by occurred_at.
 */
export class RedisFeatureStore implements FeatureStore {
  constructor(private readonly redis: Redis) {}

  static connect(url: string): RedisFeatureStore {
    return new RedisFeatureStore(new Redis(url, { maxRetriesPerRequest: 2, enableAutoPipelining: false }));
  }

  async snapshot(txn: Transaction): Promise<HistorySnapshot> {
    const k = keysFor(txn);
    const upTo = `(${k.t}`; // exclusive upper bound
    const [cardEvents, deviceEvents, ipCount, emailCount, devCards, devAccts, cardAccts, shipAccts, profile, hasDevice, hasCard, cardCustTotal, cardCustHas] =
      results(
        await this.redis
          .pipeline()
          .zrangebyscore(key("card", k.card), k.t - DAY_MS, upTo, "WITHSCORES")
          .zrangebyscore(key("device", k.device), k.t - DAY_MS, upTo, "WITHSCORES")
          .zcount(key("ip", k.ip), k.t - HOUR_MS, upTo)
          .zcount(key("email", k.email), k.t - DAY_MS, upTo)
          .zcount(key("device-cards", k.device), k.t - DAY_MS, upTo)
          .zcount(key("device-accounts", k.device), k.t - DAY_MS, upTo)
          .zcount(key("card-accounts", k.card), k.t - DAY_MS, upTo)
          .zcount(key("shipping-accounts", k.shipping), k.t - WEEK_MS, upTo)
          .hgetall(key("customer", k.customer))
          .sismember(key("customer-devices", k.customer), k.device)
          .sismember(key("customer-cards", k.customer), k.card)
          .scard(key("card-customers", k.card))
          .sismember(key("card-customers", k.card), k.customer)
          .exec(),
      );

    const pairs = (flat: unknown) => {
      const arr = flat as string[];
      const out: { member: string; score: number }[] = [];
      for (let i = 0; i < arr.length; i += 2) out.push({ member: arr[i]!, score: Number(arr[i + 1]) });
      return out;
    };
    const p = profile as Record<string, string>;

    return {
      cardEvents24h: pairs(cardEvents).map(({ member, score }) => ({
        ts: score,
        amountMinor: Number(member.slice(member.lastIndexOf("|") + 1)),
      })),
      deviceEvents24h: pairs(deviceEvents).map(({ score }) => score),
      ipCount1h: ipCount as number,
      emailCount24h: emailCount as number,
      deviceDistinctCards24h: devCards as number,
      deviceDistinctAccounts24h: devAccts as number,
      cardDistinctAccounts24h: cardAccts as number,
      shippingDistinctAccounts7d: shipAccts as number,
      customer: p.count
        ? { count: Number(p.count), sumMinor: Number(p.sum_minor), lastTs: Number(p.last_ts), lastIp: p.last_ip! }
        : null,
      customerHasDevice: hasDevice === 1,
      customerHasCard: hasCard === 1,
      cardCustomers: { total: cardCustTotal as number, includesCurrent: cardCustHas === 1 },
    };
  }

  async record(txn: Transaction): Promise<void> {
    const k = keysFor(txn);
    const trimBefore = `(${k.t - WEEK_MS}`;
    const m = this.redis.multi();

    const event = (zkey: string, member: string) =>
      m.zadd(zkey, k.t, member).zremrangebyscore(zkey, "-inf", trimBefore).expire(zkey, WINDOW_TTL_S);
    event(key("card", k.card), `${txn.transaction_id}|${txn.amount_minor}`);
    event(key("device", k.device), txn.transaction_id);
    event(key("ip", k.ip), txn.transaction_id);
    event(key("email", k.email), txn.transaction_id);

    // Distinct sets keep each value's latest timestamp (GT never lowers a score).
    const distinct = (zkey: string, value: string) =>
      m.zadd(zkey, "GT", k.t, value).zremrangebyscore(zkey, "-inf", trimBefore).expire(zkey, WINDOW_TTL_S);
    distinct(key("device-cards", k.device), k.card);
    distinct(key("device-accounts", k.device), k.customer);
    distinct(key("card-accounts", k.card), k.customer);
    distinct(key("shipping-accounts", k.shipping), k.customer);

    const cust = key("customer", k.customer);
    m.hincrby(cust, "count", 1)
      .hincrby(cust, "sum_minor", txn.amount_minor)
      .hset(cust, "last_ts", k.t, "last_ip", k.ip)
      .expire(cust, PROFILE_TTL_S);
    const set = (skey: string, value: string) => m.sadd(skey, value).expire(skey, PROFILE_TTL_S);
    set(key("customer-devices", k.customer), k.device);
    set(key("customer-cards", k.customer), k.card);
    set(key("card-customers", k.card), k.customer);

    results(await m.exec());
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
