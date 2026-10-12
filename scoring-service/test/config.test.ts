import { describe, expect, it } from "vitest";
import { DEV_API_KEY, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("falls back to the public development key outside production", () => {
    expect(loadConfig({}).VIGIL_API_KEY).toBe(DEV_API_KEY);
    expect(loadConfig({ VIGIL_API_KEY: "" }).VIGIL_API_KEY).toBe(DEV_API_KEY); // empty line in .env
  });

  it.each([
    ["missing", {}],
    ["empty", { VIGIL_API_KEY: "" }],
    ["the public development key", { VIGIL_API_KEY: DEV_API_KEY }],
    ["too short", { VIGIL_API_KEY: "short-but-private" }],
  ])("refuses to start in production when the API key is %s", (_name, env) => {
    expect(() => loadConfig({ NODE_ENV: "production", ...env })).toThrow(/VIGIL_API_KEY/);
  });

  it("accepts a private key in production", () => {
    const key = "a".repeat(48);
    expect(loadConfig({ NODE_ENV: "production", VIGIL_API_KEY: key }).VIGIL_API_KEY).toBe(key);
  });
});
