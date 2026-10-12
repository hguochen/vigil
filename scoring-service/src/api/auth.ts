import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

const PUBLIC_ROUTES = new Set(["/health"]);

// Hash both sides so the comparison is constant-time regardless of key length.
const digest = (value: string) => createHash("sha256").update(value).digest();

export function registerApiKeyAuth(app: FastifyInstance, apiKey: string): void {
  const expected = digest(apiKey);

  app.addHook("onRequest", async (request, reply) => {
    if (PUBLIC_ROUTES.has(request.routeOptions.url ?? "")) return;

    const provided = request.headers["x-api-key"];
    if (typeof provided !== "string" || !timingSafeEqual(digest(provided), expected)) {
      return reply.code(401).send({ error: "unauthorized", message: "Missing or invalid API key" });
    }
  });
}
