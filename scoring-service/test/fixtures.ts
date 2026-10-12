import type { Transaction } from "../src/domain/transaction.js";

export function makeTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    transaction_id: "txn_001",
    occurred_at: "2026-10-11T18:30:00Z",
    amount_minor: 12999,
    currency: "USD",
    channel: "web",
    customer: {
      id: "cust_42",
      email: "jane.doe@example.com",
      name: "Jane Doe",
      account_created_at: "2024-03-01T10:00:00Z",
    },
    card: { token: "tok_abc123", bin: "424242", last4: "4242", country: "US" },
    device: { id: "dev_9", ip: "203.0.113.7", user_agent: "Mozilla/5.0" },
    billing_address: { city: "Seattle", postal_code: "98101", country: "US", lat: 47.61, lon: -122.33 },
    shipping_address: { city: "Seattle", postal_code: "98101", country: "US", lat: 47.61, lon: -122.33 },
    items: [{ sku: "SKU-1", name: "Headphones", category: "electronics", quantity: 1, unit_price_minor: 12999 }],
    ...overrides,
  };
}
