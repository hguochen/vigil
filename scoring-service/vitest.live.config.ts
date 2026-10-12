import { defineConfig } from "vitest/config";

// Tests that call real external services. Run with: npm run test:live
export default defineConfig({
  test: {
    include: ["test/live/**/*.live.ts"],
    testTimeout: 30_000,
    // The verdict lines are the point of a smoke test: print them even when tests pass.
    silent: false,
    reporters: ["verbose"],
  },
});
