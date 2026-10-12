import { z } from "zod";

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default("0.0.0.0"),
  /** Required in production; development falls back to DEV_API_KEY. */
  VIGIL_API_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()),
  NODE_ENV: z.string().optional(),
  DATABASE_URL: z.string().default("postgres://vigil:vigil@localhost:5432/vigil"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  /** "memory" keeps history in-process (single instance, lost on restart); for local dev without Redis. */
  FEATURE_STORE: z.enum(["redis", "memory"]).default("redis"),
  GEO_CITIES_PATH: z.string().optional(),
  SCORING_STRATEGY: z.enum(["passthrough", "rules", "xgboost", "jev", "jev_rules"]).default("rules"),
  /** Directory with model.onnx + feature_schema.json (default: repo-root models/xgb). */
  XGB_MODEL_DIR: z.string().optional(),
  TYPESAFE_BASE_URL: z.string().url().optional(),
  JEV_MODEL: z.string().min(1).default("jev-latest"),
  /** Per-attempt timeout; checkout latency budget for the Jev call. */
  JEV_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
  JEV_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(1),
  RULES_PATH: z.string().optional(),
  POLICY_PATH: z.string().optional(),
  TYPESAFE_API_KEY: z.string().optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

/** Public, well-known key for local development only. Never accepted in production. */
export const DEV_API_KEY = "dev-local-key";
const MIN_PRODUCTION_KEY_LENGTH = 24;

export type Config = Omit<z.infer<typeof ConfigSchema>, "VIGIL_API_KEY"> & { VIGIL_API_KEY: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.parse(env);
  const key = parsed.VIGIL_API_KEY;
  if (parsed.NODE_ENV === "production") {
    if (!key || key === DEV_API_KEY || key.length < MIN_PRODUCTION_KEY_LENGTH) {
      throw new Error(
        `VIGIL_API_KEY must be set to a private value of at least ${MIN_PRODUCTION_KEY_LENGTH} characters in production ` +
          `(the development default is public). Generate one with: openssl rand -hex 24`,
      );
    }
  }
  return { ...parsed, VIGIL_API_KEY: key ?? DEV_API_KEY };
}
