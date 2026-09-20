import { defineConfig } from 'vitest/config';

/*
 * Vitest owns the co-located unit suites under src/ that import from 'vitest'.
 * They were never run: the `test` script only executed
 * `node --test dist/tests/*.test.js`, and vitest was not even a dependency, so
 * 140 cases across 9 files were dead weight. This config plus the `test:unit`
 * script is what makes them execute.
 *
 * The tests/ suites stay on node:test and are run by `test:node`; the two
 * runners are deliberately kept separate rather than migrated, so no existing
 * test has to change framework.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // src/graph/integration.test.ts uses node:test, not vitest. It is run by
    // the `test:node` phase; vitest would fail it with "No test suite found".
    exclude: ['**/node_modules/**', 'src/graph/integration.test.ts'],
    environment: 'node',
    // Long-running workflow/performance suites use real timers and file IO.
    testTimeout: 20_000,
  },
});
