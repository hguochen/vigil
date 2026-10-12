import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { SqlClient } from "./db/client.js";
import { TransactionsRepo } from "./db/transactions-repo.js";
import { healthRoutes } from "./api/health.js";
import { registerApiKeyAuth } from "./api/auth.js";
import { transactionRoutes } from "./api/transactions.js";
import { passthroughScorer, type Scorer } from "./scoring/scorer.js";

export interface AppDeps {
  db: SqlClient;
  scorer?: Scorer;
}

export async function buildApp(config: Config, deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.LOG_LEVEL } });

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err: error }, "unhandled error");
      return reply.code(500).send({ error: "internal_error", message: "Internal server error" });
    }
    // Framework-level client errors, e.g. malformed JSON or wrong content type.
    return reply.code(status).send({ error: "invalid_request", message: error.message });
  });

  registerApiKeyAuth(app, config.VIGIL_API_KEY);
  await app.register(healthRoutes);
  await app.register(transactionRoutes, {
    repo: new TransactionsRepo(deps.db),
    scorer: deps.scorer ?? passthroughScorer,
  });
  return app;
}
