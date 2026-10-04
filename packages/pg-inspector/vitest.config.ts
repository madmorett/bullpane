import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // integration tests create a throwaway schema in a real Postgres and run real bullmq workers
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
