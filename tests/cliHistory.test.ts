import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendCliHistory,
  historyFilePath,
  loadCliHistory,
  normalizeHistoryEntry,
  salvageHistoryEntries,
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

test('a torn history file is preserved and its complete entries recovered', async () => {
  const root = await tempWorkspace();
  await mkdir(join(root, '.aicode'), { recursive: true });
  const full = `${JSON.stringify({ entries: ['how do I deploy', 'fix the parser', 'run the tests'] }, null, 2)}\n`;
  // What a crash during the old in-place writeFile left behind.
  const torn = full.slice(0, full.indexOf('"run the tests"') + 10);
  await writeFile(historyFilePath(root), torn, 'utf8');

  assert.deepEqual(await loadCliHistory(root), ['how do I deploy', 'fix the parser']);

  const backups = (await readdir(join(root, '.aicode'))).filter((name) => name.includes('.corrupt-'));
  assert.equal(backups.length, 1, 'the damaged file must be kept, not overwritten');
  assert.equal(await readFile(join(root, '.aicode', backups[0]), 'utf8'), torn);

  // The recovery is republished, so appending continues from it instead of
  // starting over with a single entry.
  assert.deepEqual(await appendCliHistory(root, 'next prompt'), [
    'how do I deploy',
    'fix the parser',
    'next prompt',
  ]);
  assert.deepEqual(await loadCliHistory(root), ['how do I deploy', 'fix the parser', 'next prompt']);
});

test('a valid but wrong-shaped history file is quarantined, not silently reset', async () => {
  const root = await tempWorkspace();
  await mkdir(join(root, '.aicode'), { recursive: true });
  await writeFile(historyFilePath(root), '{"entries": "not an array"}', 'utf8');
  assert.deepEqual(await loadCliHistory(root), []);
  const backups = (await readdir(join(root, '.aicode'))).filter((name) => name.includes('.corrupt-'));
  assert.equal(backups.length, 1);
});

test('concurrent appends are serialised: none is lost', async () => {
  const root = await tempWorkspace();
  await Promise.all(Array.from({ length: 8 }, (unused, index) => appendCliHistory(root, `prompt ${index + 1}`)));
  assert.deepEqual(await loadCliHistory(root), [
    'prompt 1',
    'prompt 2',
    'prompt 3',
    'prompt 4',
    'prompt 5',
    'prompt 6',
    'prompt 7',
    'prompt 8',
  ]);
});

test('an unreadable history path is never overwritten', async () => {
  const root = await tempWorkspace();
  // EISDIR: a read failure that is NOT "no history yet".
  const path = historyFilePath(root);
  await mkdir(path, { recursive: true });
  await appendCliHistory(root, 'must not be written');
  assert.deepEqual(await readdir(path), []);
  assert.deepEqual(await loadCliHistory(root), []);
});

test('salvageHistoryEntries keeps whole entries only', () => {
  assert.deepEqual(salvageHistoryEntries('{not json'), []);
  assert.deepEqual(salvageHistoryEntries('{"entries": ["a", "b\\"c", "half'), ['a', 'b"c']);
});
