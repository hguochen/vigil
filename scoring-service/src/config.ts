import { z } from "zod";

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default("0.0.0.0"),
  VIGIL_API_KEY: z.string().min(1).default("dev-local-key"),
  DATABASE_URL: z.string().default("postgres://vigil:vigil@localhost:5432/vigil"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  TYPESAFE_API_KEY: z.string().optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse(env);
}
