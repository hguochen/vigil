import { describe, expect, it } from "vitest";
import { DECISIONS, PATTERNS, RISK_LEVELS } from "../../src/domain/transaction.js";
import { computeFeatures } from "../../src/features/compute.js";
import { loadGeoTable } from "../../src/features/geo.js";
import type { HistorySnapshot } from "../../src/features/types.js";
import { TypeSafeJevClient } from "../../src/jev/client.js";
import { buildJevState } from "../../src/jev/mask.js";
import { makeTransaction } from "../fixtures.js";

const apiKey = process.env.TYPESAFE_API_KEY;
const geo = loadGeoTable();

const history = (overrides: Partial<HistorySnapshot> = {}): HistorySnapshot => ({
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
  ...overrides,
});

function cases() {
  const T = Date.parse("2026-10-11T18:30:00Z");
  const regular = makeTransaction();
  regular.device.ip = "100.64.3.4"; // Seattle, home
  const regularHistory = history({
    customer: { count: 14, sumMinor: 140_000, lastTs: T - 9 * 86_400_000, lastIp: "100.64.3.4" },
    customerHasDevice: true,
    customerHasCard: true,
    cardCustomers: { total: 1, includesCurrent: true },
  });

  const cardTesting = makeTransaction({
    amount_minor: 149,
    items: [{ sku: "DIG-0001", category: "digital_goods", quantity: 1, unit_price_minor: 149 }],
  });
  cardTesting.customer = { id: "c_new", email: "x7k2m9q@tmpbox.net", account_created_at: "2026-10-11T18:10:00Z" };
  cardTesting.device = { id: "bot", ip: "100.84.1.1", user_agent: "Mozilla/5.0 HeadlessChrome/129.0" };
  const burst = Array.from({ length: 9 }, (_, i) => T - (i + 1) * 45_000);
  const cardTestingHistory = history({
    deviceEvents24h: burst,
    ipCount1h: 9,
    emailCount24h: 9,
    deviceDistinctCards24h: 9,
    customer: { count: 9, sumMinor: 1_341, lastTs: burst[0]!, lastIp: "100.84.1.1" },
    customerHasDevice: true,
  });

  return [
    { name: "regular customer", txn: regular, h: regularHistory },
    { name: "card-testing bot", txn: cardTesting, h: cardTestingHistory },
  ];
}

// Built lazily: describe bodies run during collection even when skipped.
const liveClient = () =>
  new TypeSafeJevClient({
    apiKey: apiKey!,
    ...(process.env.TYPESAFE_BASE_URL && { baseUrl: process.env.TYPESAFE_BASE_URL }),
    model: process.env.JEV_MODEL ?? "jev-latest",
    timeoutMs: 15_000,
    maxRetries: 1,
  });

describe.skipIf(!apiKey)("Jev live smoke test", () => {
  for (const c of cases()) {
    it(`returns a well-formed verdict for a ${c.name}`, async () => {
      const v = await liveClient().classify(buildJevState(c.txn, computeFeatures(c.txn, c.h, geo), geo));
      expect(v.fraudProbability).toBeGreaterThanOrEqual(0);
      expect(v.fraudProbability).toBeLessThanOrEqual(1);
      expect(PATTERNS).toContain(v.pattern.label);
      expect(RISK_LEVELS).toContain(v.riskLevel.label);
      expect(DECISIONS).toContain(v.action.label);
      console.log(
        `${c.name.padEnd(18)} p(fraud)=${v.fraudProbability.toFixed(3)} pattern=${v.pattern.label}` +
          ` risk=${v.riskLevel.label} action=${v.action.label}(${v.action.confidence.toFixed(2)})` +
          ` model=${v.model} ${v.latencyMs}ms tokens=${v.usage.inputTokens ?? "?"}`,
      );
    });
  }
});

describe.runIf(!apiKey)("Jev live smoke test (skipped)", () => {
  it("needs TYPESAFE_API_KEY in ../.env", () => {
    console.log("TYPESAFE_API_KEY not set: live Jev tests skipped. Add it to .env and rerun npm run test:live.");
  });
});
