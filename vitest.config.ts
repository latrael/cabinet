import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/server/test/**/*.test.ts', 'apps/cli/test/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
    pool: 'forks',
  },
});
