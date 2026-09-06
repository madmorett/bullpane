import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // integration tests boot a throwaway redis-server and run real bullmq workers
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // one file, one redis: keep it sequential
    fileParallelism: false,
  },
});
