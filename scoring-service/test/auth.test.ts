import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerApiKeyAuth } from "../src/api/auth.js";
import { healthRoutes } from "../src/api/health.js";

describe("API key auth", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    registerApiKeyAuth(app, "secret-key");
    await app.register(healthRoutes);
    app.get("/v1/protected", async () => ({ ok: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("leaves /health public", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("rejects requests without a key", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/protected" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthorized");
  });

  it("rejects a wrong key", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/protected", headers: { "x-api-key": "nope" } });
    expect(res.statusCode).toBe(401);
  });

  it("accepts the right key", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/protected", headers: { "x-api-key": "secret-key" } });
    expect(res.statusCode).toBe(200);
  });

  it("rejects unknown routes without leaking a 404", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/nope" });
    expect(res.statusCode).toBe(401);
  });
});
