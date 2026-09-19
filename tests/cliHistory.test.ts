import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendCliHistory,
  historyFilePath,
  loadCliHistory,
  normalizeHistoryEntry,
  toReadlineHistory,
  HISTORY_LIMIT,
} from '../src/cli/history.js';

async function tempWorkspace(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'aicode-history-'));
}

test('normalizeHistoryEntry collapses newlines and caps length', () => {
  assert.equal(normalizeHistoryEntry('  hello \n world  '), 'hello   world');
  assert.equal(normalizeHistoryEntry('\n\n  \n'), '');
  const long = normalizeHistoryEntry('x'.repeat(500));
  assert.ok(long.length <= 400);
  assert.ok(long.endsWith('…'));
});

test('appendCliHistory collapses adjacent duplicates only (upstream semantics)', async () => {
  const root = await tempWorkspace();
  await appendCliHistory(root, 'first prompt');
  await appendCliHistory(root, 'first prompt');
  await appendCliHistory(root, 'second prompt');
  await appendCliHistory(root, 'first prompt');
  const entries = await loadCliHistory(root);
  // Only ADJACENT duplicates collapse; the later 'first prompt' is a distinct
  // submission and stays in place (no global move-to-newest).
  assert.deepEqual(entries, ['first prompt', 'second prompt', 'first prompt']);
  const raw = JSON.parse(await readFile(historyFilePath(root), 'utf8'));
  assert.ok(Array.isArray(raw.entries));
});

test('appendCliHistory enforces the cap by dropping oldest', async () => {
  const root = await tempWorkspace();
  for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) {
    await appendCliHistory(root, `entry ${i}`);
  }
  const entries = await loadCliHistory(root);
  assert.equal(entries.length, HISTORY_LIMIT);
  assert.equal(entries[entries.length - 1], `entry ${HISTORY_LIMIT + 4}`);
  assert.equal(entries[0], 'entry 5');
});

test('toReadlineHistory orders newest first for readline', () => {
  assert.deepEqual(toReadlineHistory(['old', 'new']), ['new', 'old']);
});

test('corrupt history file degrades to empty instead of throwing', async () => {
  const root = await tempWorkspace();
  await mkdir(join(root, '.aicode'), { recursive: true });
  await writeFile(historyFilePath(root), '{not json', 'utf8');
  assert.deepEqual(await loadCliHistory(root), []);
});

test('missing history file loads empty', async () => {
  const root = await tempWorkspace();
  assert.deepEqual(await loadCliHistory(root), []);
});
