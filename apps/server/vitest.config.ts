import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // The integration suites share one database and truncate between cases, so
    // running test *files* in parallel would make them race each other. The
    // whole suite takes a few seconds, so serialising is a cheap price for
    // determinism.
    fileParallelism: false,
  },
});
