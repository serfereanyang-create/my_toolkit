import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { SessionStore } from './store.js';

/*
 * A merged transcript must read in the order the conversation happened.
 *
 * Each writer rewrites the whole file from its own in-memory record. When two
 * records carry different stretches of the same conversation — the desktop
 * session and a sub-agent CLI appending tool results, the REPL and an automation
 * run — their messages interleave in time. Concatenating disk-then-incoming and
 * calling it a union puts every one of the second writer's messages after every
 * one of the first's, which is not the conversation's order.
 */

async function freshStore() {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-merge-order-'));
  const dir = join(workspace, 'sessions');
  const store = new SessionStore(dir);
  const session = await store.create({ provider: 'mock', model: 'm', workspaceRoot: workspace });
  return { workspace, dir, store, session };
}

/** Same directory, separate instance — the second writer's view. */
function secondStore(dir: string) {
  return new SessionStore(dir);
}

/** A plausible ISO stamp `ms` after the session start. */
function stamp(base: number, ms: number) {
  return new Date(base + ms).toISOString();
}

describe('session merge ordering', () => {
  it('interleaves two writers’ stretches by timestamp instead of concatenating them', async () => {
    const { workspace, dir, store, session } = await freshStore();
    try {
      const other = secondStore(dir);
      const base = Date.parse(session.createdAt);

      // Writer A holds turns at 0/20/40 ms, writer B holds turns at 10/30/50 ms.
      // Every one of them belongs to the same conversation.
      session.messages = [
        { role: 'user', content: 'a0', createdAt: stamp(base, 0) },
        { role: 'assistant', content: 'a20', createdAt: stamp(base, 20) },
        { role: 'user', content: 'a40', createdAt: stamp(base, 40) },
      ];
      await store.save(session);

      const view = await other.load(session.id);
      view.messages = [
        { role: 'tool', name: 'read_file', content: 'b10', createdAt: stamp(base, 10) },
        { role: 'tool', name: 'read_file', content: 'b30', createdAt: stamp(base, 30) },
        { role: 'tool', name: 'read_file', content: 'b50', createdAt: stamp(base, 50) },
      ];
      await other.save(view);

      const merged = await store.load(session.id);
      const contents = merged.messages.map((m) => m.content);
      assert.deepEqual(
        contents,
        ['a0', 'b10', 'a20', 'b30', 'a40', 'b50'],
        `transcript must read in timestamp order, got ${JSON.stringify(contents)}`,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('keeps ties in their pre-merge order and never duplicates a shared message', async () => {
    const { workspace, dir, store, session } = await freshStore();
    try {
      const other = secondStore(dir);
      const base = Date.parse(session.createdAt);
      const shared = { role: 'user' as const, content: 'shared', createdAt: stamp(base, 5) };

      session.messages = [shared, { role: 'assistant', content: 'x', createdAt: stamp(base, 6) }];
      await store.save(session);
      const view = await other.load(session.id);
      view.messages = [shared, { role: 'assistant', content: 'y', createdAt: stamp(base, 6) }];
      await other.save(view);

      const contents = (await store.load(session.id)).messages.map((m) => m.content);
      assert.equal(new Set(contents).size, contents.length, 'no duplicate message');
      assert.deepEqual(contents.slice(0, 1), ['shared']);
      assert.deepEqual([...contents].sort(), ['shared', 'x', 'y']);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('a writer that merged once keeps the merged turns on its NEXT save', async () => {
    /*
     * The per-turn pattern: a writer loads, another process appends, the writer
     * saves (merge pulls in the other's turns), then the writer appends again
     * and saves. If the merged lists are not adopted into the caller's record,
     * the second save either writes the stale transcript back or pays for a
     * full re-read forever. This is the failure the fast path introduces, so it
     * is pinned explicitly.
     */
    const { workspace, dir, store, session } = await freshStore();
    try {
      const other = new SessionStore(dir);
      await store.appendMessage(session, { role: 'user', content: 'A1' });

      // B loads, then A appends what B has not seen.
      const view = await other.load(session.id);
      await store.appendMessage(session, { role: 'user', content: 'A2' });

      // B saves (this merges A2 in), then appends its own turn and saves again.
      await other.appendMessage(view, { role: 'user', content: 'B1' });
      await other.appendMessage(view, { role: 'user', content: 'B2' });

      const contents = (await store.load(session.id)).messages.map((m) => m.content);
      assert.deepEqual(
        contents,
        ['A1', 'A2', 'B1', 'B2'],
        `a merged turn was dropped on the next save: ${JSON.stringify(contents)}`,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('interleaving 200 real appends from two writers loses and reorders nothing', async () => {
    const { workspace, dir, store, session } = await freshStore();
    try {
      const other = secondStore(dir);
      const view = await other.load(session.id);
      const expected: string[] = [];
      for (let i = 0; i < 200; i += 1) {
        const target = i % 2 === 0 ? [store, session] : [other, view];
        const content = `m${String(i).padStart(3, '0')}`;
        await (target[0] as SessionStore).appendMessage(target[1] as any, { role: 'user', content });
        expected.push(content);
      }
      const merged = await store.load(session.id);
      const contents = merged.messages.filter((m) => m.role === 'user').map((m) => m.content);
      assert.equal(contents.length, 200, 'no message lost');
      assert.deepEqual([...contents].sort(), expected, 'same set of messages');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
