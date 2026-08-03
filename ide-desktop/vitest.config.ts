import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Vitest owns only the TypeScript renderer tests. The Electron main-process
    // and bridge suites use node:test and run as a separate `node --test` phase,
    // so exclude .cjs here to avoid importing them (which reports "0 test" and
    // does not await async node:test cases).
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    environment: 'node',
  },
});
