import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordDispatch,
  readDispatchHistory,
  shengqianLedgerPath,
  formatDispatchStatus,
} from '../src/dispatch/dispatchLedger.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dispatch-ledger-'));
}

const entry = {
  ts: '2026-10-04T00:00:00.000Z',
  task: 't',
  stage: 'main',
  tier: 'cheap' as const,
  provider: 'openai',
  model: 'm',
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
  ok: true,
};

test('recordDispatch appends to both the global and the workspace ledger', () => {
  const dir = tempDir();
  try {
    const global = join(dir, 'global.jsonl');
    recordDispatch(entry, global, dir);
    const rows = readDispatchHistory(global);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].totalTokens, 15);
    // The spec's per-workspace ledger must exist and hold the same row.
    const workspaceRows = readDispatchHistory(shengqianLedgerPath(dir));
    assert.equal(workspaceRows.length, 1);
    assert.equal(workspaceRows[0].tier, 'cheap');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordDispatch does not overwrite earlier rows', () => {
  const dir = tempDir();
  try {
    const global = join(dir, 'global.jsonl');
    recordDispatch(entry, global);
    recordDispatch({ ...entry, totalTokens: 99 }, global);
    assert.equal(readDispatchHistory(global).length, 2, 'append, never truncate');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing ledger reads as empty rather than throwing', () => {
  const dir = tempDir();
  try {
    assert.deepEqual(readDispatchHistory(join(dir, 'nope.jsonl')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shengqianLedgerPath points at the path the spec names', () => {
  const p = shengqianLedgerPath('C:\\ws');
  assert.ok(p.endsWith(join('.shengqian-logs', 'usage-ledger.jsonl')));
  void readFileSync; void formatDispatchStatus;
});
