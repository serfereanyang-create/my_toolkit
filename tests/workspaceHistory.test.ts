import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffRuns, type RunRecord } from '../src/workspace/runHistory.js';

function mkRecord(pkgResults: Array<{ name: string; exit: number }>, script = 'test'): RunRecord {
  return {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    request: { script, concurrency: 4, continueOnError: false },
    plan: [],
    summary: {
      ok: pkgResults.filter((p) => p.exit === 0).length,
      failed: pkgResults.filter((p) => p.exit !== 0).length,
      skipped: 0,
      totalDurationMs: 1000,
    },
    artifacts: pkgResults.map((p) => ({
      pkg: p.name,
      exitCode: p.exit,
      durationMs: 100,
      tail: '',
    })),
  };
}

test('diffRuns: detects regression and recovery', () => {
  const prev = mkRecord([{ name: 'a', exit: 0 }, { name: 'b', exit: 1 }]);
  const latest = mkRecord([{ name: 'a', exit: 1 }, { name: 'b', exit: 0 }]);
  const d = diffRuns(latest, prev);
  assert.deepEqual(d.regression, ['a']);
  assert.deepEqual(d.recovered, ['b']);
  assert.equal(d.fluctuations.length, 0);
  assert.equal(d.sameScript, true);
});

test('diffRuns: no prior run', () => {
  const d = diffRuns(mkRecord([]), null);
  assert.equal(d.prev, null);
  assert.deepEqual(d.regression, []);
});

test('diffRuns: detects fluctuations when exitCode changes between failures', () => {
  const prev = mkRecord([{ name: 'a', exit: 1 }]);
  const latest = mkRecord([{ name: 'a', exit: 2 }]);
  const d = diffRuns(latest, prev);
  assert.deepEqual(d.fluctuations, ['a']);
});
