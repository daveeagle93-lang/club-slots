/// <reference types="node" />
import { defineConfig } from "vitest/config";

// Not London, so tests that need Europe/London must ask for it explicitly rather than pass by luck.
// Set before defineConfig so the test worker processes inherit it.
process.env.TZ = "Pacific/Auckland";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["src/test/global-setup.ts"],
    include: ["src/**/*.test.ts", "public/**/*.test.ts"],
    // The race tests (many parallel requests against the local database) take 1 to 5 seconds on their own, and the
    // 100-odd files run side by side, so vitest's 5 second default can expire on a busy machine and fail a test that passes alone.
    testTimeout: 30_000,
  },
});
