import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import { healthRoutes } from "./api/health.js";
import { registerApiKeyAuth } from "./api/auth.js";

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.LOG_LEVEL } });
  registerApiKeyAuth(app, config.VIGIL_API_KEY);
  await app.register(healthRoutes);
  return app;
}
