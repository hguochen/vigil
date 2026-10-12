import { describe, expect, it } from "vitest";
import { TransactionSchema } from "../src/domain/transaction.js";
import { makeTransaction } from "./fixtures.js";

describe("TransactionSchema", () => {
  it("accepts a valid transaction", () => {
    expect(TransactionSchema.safeParse(makeTransaction()).success).toBe(true);
  });

  it("accepts IPv6 device addresses", () => {
    const txn = makeTransaction();
    txn.device.ip = "2001:db8::1";
    expect(TransactionSchema.safeParse(txn).success).toBe(true);
  });

  it("rejects a raw card number smuggled into the card object", () => {
    const txn = { ...makeTransaction(), card: { ...makeTransaction().card, number: "4242424242424242" } };
    expect(TransactionSchema.safeParse(txn).success).toBe(false);
  });

  it("rejects unknown top-level fields", () => {
    expect(TransactionSchema.safeParse({ ...makeTransaction(), pan: "4242424242424242" }).success).toBe(false);
  });

  it.each([
    ["negative amount", { amount_minor: -1 }],
    ["fractional amount", { amount_minor: 10.5 }],
    ["lowercase currency", { currency: "usd" }],
    ["unknown channel", { channel: "pos" }],
    ["empty items", { items: [] }],
    ["non-ISO timestamp", { occurred_at: "yesterday" }],
  ])("rejects %s", (_name, override) => {
    expect(TransactionSchema.safeParse({ ...makeTransaction(), ...override }).success).toBe(false);
  });

  it("rejects an invalid email and IP", () => {
    const txn = makeTransaction();
    txn.customer.email = "not-an-email";
    txn.device.ip = "999.1.1.1";
    const result = TransactionSchema.safeParse(txn);
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map((i) => i.path.join("."));
    expect(paths).toEqual(expect.arrayContaining(["customer.email", "device.ip"]));
  });
});
