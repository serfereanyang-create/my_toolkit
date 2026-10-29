import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { SessionStore, type SessionRecord } from '../src/session/store.js';

/*
 * Two writers, one conversation.
 *
 * A desktop session and a spawned sub-agent CLI (or the REPL and an automation
 * run) each build their own SessionStore from the same directory. Every append
 * reads a live in-memory record and rewrites the whole file, so without a
 * shared boundary the later save replaces the other's turns and nothing throws.
 * These cases pin the cross-process lock, the merge inside it, and the places
 * where "last writer wins" must NOT win (`/clear`, compaction).
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Compile-free child: imports the built store, or the source when run by vitest. */
async function storeModuleUrl(): Promise<string> {
  const candidates = [join(here, '..', 'src', 'session', 'store.js'), join(here, '..', '..', 'dist', 'src', 'session', 'store.js')];
  for (const candidate of candidates) {
    const ok = await import('node:fs/promises').then((fs) => fs.access(candidate).then(() => true, () => false));
    if (ok) return new URL(`file://${candidate.replace(/\\/g, '/')}`).href;
  }
  throw new Error('session store build not found; run npm run build');
}

async function workspaceWithSession() {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-session-xproc-'));
  const dir = join(workspace, 'sessions');
  const store = new SessionStore(dir);
  const session = await store.create({ provider: 'mock', model: 'mock-code-agent-v1', workspaceRoot: workspace });
  return { workspace, dir, store, session };
}

function appendInChild(dir: string, id: string, tag: string, count: number, moduleUrl: string) {
  const script = `
    const { SessionStore } = await import(${JSON.stringify(moduleUrl)});
    const [dir, id, tag, count] = process.argv.slice(1);
    const store = new SessionStore(dir);
    const session = await store.load(id);
    for (let i = 0; i < Number(count); i += 1) {
      await store.appendMessage(session, { role: 'user', content: tag + '-' + i });
    }
    await store.appendToolCall(session, { tool: 'tool_' + tag, input: {}, ok: true, output: 'ok' });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir, id, tag, String(count)], { stdio: 'inherit' });
  return new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

test('three processes appending to one session lose no message or tool call', async () => {
  const { workspace, dir, store, session } = await workspaceWithSession();
  const moduleUrl = await storeModuleUrl();
  try {
    const codes = await Promise.all([0, 1, 2].map((index) => appendInChild(dir, session.id, `p${index}`, 20, moduleUrl)));
    assert.deepEqual(codes, [0, 0, 0]);
    const reloaded = await store.load(session.id);
    // appendToolCall also records a role:'tool' message, so users are counted separately.
    const contents = reloaded.messages.filter((message) => message.role === 'user').map((message) => message.content);
    assert.equal(contents.length, 60);
    assert.equal(reloaded.messages.filter((message) => message.role === 'tool').length, 3);
    for (let index = 0; index < 3; index += 1) {
      for (let i = 0; i < 20; i += 1) assert.ok(contents.includes(`p${index}-${i}`), `missing p${index}-${i}`);
    }
    // Tool calls the three writers appended are all present too.
    assert.deepEqual(reloaded.toolCalls.map((call) => call.tool).sort(), ['tool_p0', 'tool_p1', 'tool_p2']);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('two store instances in one process merge instead of overwriting', async () => {
  const { workspace, store, session } = await workspaceWithSession();
  try {
    const first = await store.load(session.id);
    const second = await store.load(session.id);
    // Interleave: each instance appends on its own copy, then saves.
    await Promise.all([
      store.appendMessage(first, { role: 'user', content: 'from first' }),
      store.appendMessage(second, { role: 'user', content: 'from second' }),
    ]);
    await Promise.all([
      store.appendMessage(first, { role: 'assistant', content: 'answer from first' }),
      store.appendMessage(second, { role: 'assistant', content: 'answer from second' }),
    ]);
    const reloaded = await store.load(session.id);
    const contents = reloaded.messages.map((message) => message.content);
    assert.deepEqual([...contents].sort(), ['answer from first', 'answer from second', 'from first', 'from second']);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('/clear is not undone by a stale copy saving afterwards', async () => {
  const { workspace, store, session } = await workspaceWithSession();
  try {
    await store.appendMessage(session, { role: 'user', content: 'first' });
    await store.appendMessage(session, { role: 'user', content: 'second' });
    const stale = await store.load(session.id);
    // `/clear`: messages, answers and tool calls emptied, then saved.
    session.messages = [];
    session.finalAnswers = [];
    session.toolCalls = [];
    await store.save(session);

    // The stale instance appends to what it still thinks is the transcript.
    await store.appendMessage(stale, { role: 'user', content: 'third' });
    const reloaded = await store.load(session.id);
    assert.deepEqual(reloaded.messages.map((m) => m.content), ['third']);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a compaction tail after saving does not resurrect the pre-compaction history', async () => {
  const { workspace, store, session } = await workspaceWithSession();
  try {
    for (const text of ['one', 'two', 'three', 'four']) await store.appendMessage(session, { role: 'user', content: text });
    // Exactly the shape /compact and auto-compact write: summary stub + recent tail.
    const tail = session.messages.slice(-1);
    session.messages = [
      { role: 'assistant', content: '[Compacted — 3 message(s) removed. Summary: …]', createdAt: new Date().toISOString() },
      ...tail,
    ];
    await store.save(session);
    const reloaded = await store.load(session.id);
    assert.deepEqual(reloaded.messages.map((m) => m.content), [
      '[Compacted — 3 message(s) removed. Summary: …]',
      'four',
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a save leaves no lock file behind and the session stays loadable', async () => {
  const { workspace, dir, store, session } = await workspaceWithSession();
  try {
    await store.appendMessage(session, { role: 'user', content: 'hello' });
    const names = await readdir(dir);
    assert.deepEqual(names.filter((name) => name.endsWith('.lock')), []);
    assert.deepEqual(names.filter((name) => name.endsWith('.tmp')), []);
    assert.equal((await store.load(session.id)).messages.length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

/*
 * Seeded concurrency: several store instances, random interleaving of
 * append/setLastTurn/save, and an invariant that does not depend on the order.
 * mulberry32 keeps the schedule reproducible from the seed printed on failure.
 */
function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('randomized concurrent writers: every appended message survives', async () => {
  const seed = 0x5eed + Math.floor(Number(process.env.AICODE_TEST_SEED ?? 0));
  const random = mulberry32(seed);
  const { workspace, dir, store, session } = await workspaceWithSession();
  try {
    const INSTANCES = 4;
    const PER_INSTANCE = 12;
    const stores = Array.from({ length: INSTANCES }, () => new SessionStore(dir));
    const copies: SessionRecord[] = await Promise.all(stores.map(() => store.load(session.id)));
    type Op = { label: string; run: () => Promise<void> };
    const operations: Op[] = [];
    const appended: string[] = [];
    for (let instance = 0; instance < INSTANCES; instance += 1) {
      const copy = copies[instance]!;
      for (let i = 0; i < PER_INSTANCE; i += 1) {
        const label = `inst${instance}-${i}`;
        if (random() < 0.5) {
          appended.push(label);
          operations.push({ label, run: () => stores[instance]!.appendMessage(copy, { role: 'user', content: label }) });
        } else {
          operations.push({
            label,
            run: () => stores[instance]!.setLastTurn(copy, { prompt: label, status: 'done', startedAt: new Date(Date.now() + i).toISOString() }),
          });
        }
      }
    }
    // Shuffle with the seeded generator so each seed runs a different schedule.
    for (let i = operations.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [operations[i], operations[j]] = [operations[j]!, operations[i]!];
    }
    await Promise.all(operations.map((operation) => operation.run()));

    const reloaded = await store.load(session.id);
    const contents = new Set(reloaded.messages.map((message) => message.content));
    for (const label of appended) {
      if (!contents.has(label)) throw new Error(`seed ${seed}: lost ${label}`);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a hand-edited record with a non-list field is rejected, not half-loaded', async () => {
  const { workspace, store, session } = await workspaceWithSession();
  try {
    const file = store.filePath(session.id);
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    raw.messages = 'not a list';
    await writeFile(file, JSON.stringify(raw), 'utf8');
    await assert.rejects(store.load(session.id), /messages is not a list/);
    // The unreadable copy is preserved, not overwritten by the next save.
    const names = await readdir(dirname(file));
    assert.equal(names.filter((name) => name.includes('.corrupt-')).length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
