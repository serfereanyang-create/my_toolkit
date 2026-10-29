import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ProjectMemoryStore } from '../src/memory/store.js';
import { selectRelevantMemories } from '../src/memory/select.js';
import { ReflectionStore } from '../src/reflection/store.js';
import { LockTimeoutError } from '../src/utils/lockfile.js';

/*
 * Corruption handling the existing suites do not reach:
 *
 *   - a damaged REFLECTIONS file that cannot be moved aside (Windows EPERM
 *     while another process reads it) — the next reflect must not overwrite it;
 *   - a memory file whose envelope parses but whose ENTRIES are unusable —
 *     previously that reached `localeCompare`/`reduce` inside every reader and
 *     surfaced as "memory is empty";
 *   - both stores under real concurrent writers from separate processes;
 *   - a held lock: bounded by its timeout, and a failed write leaves the file
 *     byte-for-byte intact.
 */

const here = dirname(fileURLToPath(import.meta.url));

async function moduleUrl(relative: string): Promise<string> {
  for (const base of [join(here, '..', relative), join(here, '..', '..', 'dist', relative)]) {
    const ok = await (await import('node:fs/promises')).access(base).then(() => true, () => false);
    if (ok) return new URL(`file://${base.replace(/\\/g, '/')}`).href;
  }
  throw new Error(`build not found for ${relative}`);
}

const errno = (code: string) => Object.assign(new Error(code), { code });

test('a damaged reflections file that cannot be moved aside is never overwritten', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aicode-reflection-locked-'));
  try {
    await mkdir(join(root, '.aicode'), { recursive: true });
    const file = join(root, '.aicode', 'reflections.json');
    const torn = '{"version": 1, "entries": [{"topic": "half';
    await writeFile(file, torn, 'utf8');

    let locked = true;
    const store = new ReflectionStore(root, {
      rename: async (from, to) => {
        if (locked) throw errno('EPERM');
        const { rename } = await import('node:fs/promises');
        await rename(from, to);
      },
      lock: { timeoutMs: 500, retryDelayMs: 2 },
    });

    // Reads degrade to "no lessons", but the file on disk stays intact.
    assert.deepEqual(await store.list(), []);
    assert.equal(await readFile(file, 'utf8'), torn);

    // A new lesson while the file is stuck must NOT replace it: we could not
    // read it and could not back it up.
    await store.add({ topic: 'new', failure: 'boom', lesson: 'l', kind: 'exception' });
    assert.equal(await readFile(file, 'utf8'), torn, 'the only copy must survive');

    // Once the holder lets go, the same store recovers: copy preserved, writes resume.
    locked = false;
    assert.deepEqual(await store.list(), []);
    const backups = (await readdir(join(root, '.aicode'))).filter((name) => name.includes('.corrupt-'));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(root, '.aicode', backups[0]!), 'utf8'), torn);
    await store.add({ topic: 'after', failure: 'f', lesson: 'l', kind: 'exception' });
    assert.deepEqual((await store.list()).map((entry) => entry.topic), ['after']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a memory file with unusable entries is repaired, not handed to readers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aicode-memory-entries-'));
  const file = join(root, '.aicode', 'memory', 'entries.json');
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      entries: [
        42,
        null,
        { kind: 'note', summary: 'missing id and keywords', updatedAt: 'not a date' },
        { id: 'mem_bad', kind: 'nonsense', summary: 'bad kind', keywords: 'not-an-array', source: { type: 'alien' }, active: true },
        { id: 'mem_ok', kind: 'convention', summary: 'use tabs', keywords: ['tabs'], source: { type: 'user' }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', active: true },
      ],
    }), 'utf8');

    const store = new ProjectMemoryStore(root);
    const entries = await store.list({ includeInactive: true });
    // 42 and null are dropped; the three objects are repaired.
    assert.equal(entries.length, 3);
    const repaired = entries.find((entry) => entry.summary === 'missing id and keywords')!;
    assert.ok(repaired.id.startsWith('mem_'));
    assert.deepEqual(repaired.keywords, []);
    assert.equal(repaired.kind, 'note');
    // Readers that used to throw on these fields work on the repaired set.
    assert.ok(Array.isArray(selectRelevantMemories({ entries, goal: 'tabs' })));
    const bad = entries.find((entry) => entry.summary === 'bad kind')!;
    assert.equal(bad.kind, 'note');
    assert.deepEqual(bad.keywords, []);
    assert.equal(bad.source.type, 'system');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a memory file where every entry is unusable is quarantined before the next write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aicode-memory-allbad-'));
  const file = join(root, '.aicode', 'memory', 'entries.json');
  try {
    await mkdir(dirname(file), { recursive: true });
    const original = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), entries: [{ foo: 1 }, 'text'] });
    await writeFile(file, original, 'utf8');
    const store = new ProjectMemoryStore(root);
    assert.deepEqual(await store.list(), []);
    const backups = (await readdir(dirname(file))).filter((name) => name.includes('.corrupt-'));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(dirname(file), backups[0]!), 'utf8'), original);
    await store.add({ kind: 'note', summary: 'new memory', source: { type: 'user' } });
    assert.deepEqual((await store.list()).map((entry) => entry.summary), ['new memory']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a held memory lock times out with a clear error and leaves the file intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aicode-memory-locktimeout-'));
  const file = join(root, '.aicode', 'memory', 'entries.json');
  try {
    const store = new ProjectMemoryStore(root);
    await store.add({ kind: 'note', summary: 'existing', source: { type: 'user' } });
    const before = await readFile(file, 'utf8');
    // Another process holds the lock: a lock file owned by this live process,
    // freshly stamped so the stale-takeover path must not fire.
    const lockFile = `${file}.lock`;
    await writeFile(lockFile, JSON.stringify({ token: 'other', pid: process.pid, host: (await import('node:os')).hostname(), startedAt: new Date().toISOString() }), 'utf8');

    const blocked = new ProjectMemoryStore(root, { lock: { timeoutMs: 150, retryDelayMs: 5, staleMs: 60_000 } });
    await assert.rejects(
      () => blocked.add({ kind: 'note', summary: 'blocked', source: { type: 'user' } }),
      (error: unknown) => error instanceof LockTimeoutError,
    );
    assert.equal(await readFile(file, 'utf8'), before, 'a timed-out write must not touch the file');
    assert.equal((await store.list()).length, 1);
    await rm(lockFile, { force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a held reflections lock times out instead of spinning forever', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aicode-reflection-locktimeout-'));
  try {
    const store = new ReflectionStore(root, { lock: { timeoutMs: 150, retryDelayMs: 5, staleMs: 60_000 } });
    await store.add({ topic: 'first', failure: 'f', lesson: 'l', kind: 'exception' });
    const lockFile = join(root, '.aicode', 'reflections.json.lock');
    await writeFile(lockFile, JSON.stringify({ token: 'other', pid: process.pid, host: (await import('node:os')).hostname(), startedAt: new Date().toISOString() }), 'utf8');
    const started = Date.now();
    await assert.rejects(
      () => store.add({ topic: 'second', failure: 'f', lesson: 'l', kind: 'exception' }),
      (error: unknown) => error instanceof LockTimeoutError,
    );
    assert.ok(Date.now() - started < 5_000, 'the wait must be bounded by the timeout');
    await rm(lockFile, { force: true });
    assert.deepEqual((await store.list()).map((entry) => entry.topic), ['first']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function runChild(script: string, args: string[]) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], { stdio: 'inherit' });
  return new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

test('reflections from separate processes are all kept', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aicode-reflection-xproc-'));
  try {
    const url = await moduleUrl(join('src', 'reflection', 'store.js'));
    const script = `
      const { ReflectionStore } = await import(${JSON.stringify(url)});
      const [root, tag, count] = process.argv.slice(1);
      const store = new ReflectionStore(root);
      for (let i = 0; i < Number(count); i += 1) {
        await store.add({ topic: tag + '-' + i, failure: 'f', lesson: 'l', kind: 'exception' });
      }
    `;
    const codes = await Promise.all([0, 1, 2].map((index) => runChild(script, [root, `p${index}`, '5'])));
    assert.deepEqual(codes, [0, 0, 0]);
    const topics = new Set((await new ReflectionStore(root).list()).map((entry) => entry.topic));
    for (let index = 0; index < 3; index += 1) {
      for (let i = 0; i < 5; i += 1) assert.ok(topics.has(`p${index}-${i}`), `lost p${index}-${i}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('memory entries from separate processes are all kept', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aicode-memory-xproc-'));
  try {
    const url = await moduleUrl(join('src', 'memory', 'store.js'));
    const script = `
      const { ProjectMemoryStore } = await import(${JSON.stringify(url)});
      const [root, tag, count] = process.argv.slice(1);
      const store = new ProjectMemoryStore(root);
      for (let i = 0; i < Number(count); i += 1) {
        await store.add({ kind: 'note', summary: tag + '-' + i, source: { type: 'user' } });
      }
    `;
    const codes = await Promise.all([0, 1, 2].map((index) => runChild(script, [root, `p${index}`, '4'])));
    assert.deepEqual(codes, [0, 0, 0]);
    const summaries = new Set((await new ProjectMemoryStore(root).list()).map((entry) => entry.summary));
    for (let index = 0; index < 3; index += 1) {
      for (let i = 0; i < 4; i += 1) assert.ok(summaries.has(`p${index}-${i}`), `lost p${index}-${i}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
