import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runAuditChecks } from '../src/audit/checks.js';

function findCliRoot(start: string) {
  let current = start;
  for (let index = 0; index < 6; index += 1) {
    if (existsSync(resolve(current, 'package.json')) && existsSync(resolve(current, 'src/audit/checks.ts'))) {
      return current;
    }
    current = resolve(current, '..');
  }
  throw new Error(`Unable to locate CLI root from ${start}`);
}

const cliRoot = findCliRoot(dirname(fileURLToPath(import.meta.url)));

test('100-check audit passes', async () => {
  const result = await runAuditChecks(cliRoot, { print: false });
  assert.equal(result.total >= 100, true);
  assert.deepEqual(result.failures, []);
});