import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { SessionStore } from './store.js';

/*
 * `/clear` versus a writer that never saw it.
 *
 * The REPL clears the in-memory record and saves. A sub-agent CLI started
 * before that clear still holds the old transcript; when it saves its own
 * completion, the merge must not put the cleared turns back. This is the one
 * case where "union of both histories" is the wrong answer, and the merge
 * infers a clear from the shape of the incoming record rather than trusting a
 * flag the clear itself does not set.
 */

async function freshStore() {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-clear-merge-'));
  const dir = join(workspace, 'sessions');
  const store = new SessionStore(dir);
  const session = await store.create({ provider: 'mock', model: 'm', workspaceRoot: workspace });
  return { workspace, dir, store, session };
}

describe('cleared transcript versus a stale writer', () => {
  it('a stale writer cannot resurrect turns removed by /clear', async () => {
    const { workspace, dir, store, session } = await freshStore();
    try {
      const stale = new SessionStore(dir);
      const staleView = await stale.load(session.id);

      await store.appendMessage(session, { role: 'user', content: 'before clear' });
      await store.appendMessage(session, { role: 'assistant', content: 'answer' });

      // The REPL's /clear: empty the live record and save it.
      session.messages = [];
      session.finalAnswers = [];
      session.toolCalls = [];
      await store.save(session);

      // A writer that loaded the session BEFORE the clear finishes its turn.
      await stale.appendMessage(staleView, { role: 'assistant', content: 'stale completion' });

      const contents = (await store.load(session.id)).messages.map((m) => m.content);
      assert.ok(
        !contents.includes('before clear') && !contents.includes('answer'),
        `cleared turns came back: ${JSON.stringify(contents)}`,
      );
      assert.deepEqual(contents, ['stale completion'], 'work done after the clear survives');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('the boundary is the clear itself, so a message written before it stays gone', async () => {
    /*
     * The record's `updatedAt` is stamped by the last append, which can be long
     * before the clear. A stale writer can hold a message stamped BETWEEN that
     * append and the clear — an in-flight turn the user then discarded. Using
     * `updatedAt` as the boundary keeps exactly that message.
     */
    const { workspace, dir, store, session } = await freshStore();
    try {
      const stale = new SessionStore(dir);
      await store.appendMessage(session, { role: 'user', content: 'kept until clear' });
      const staleView = await stale.load(session.id);
      const boundaryInBetween = new Date(Date.parse(session.updatedAt) + 5).toISOString();

      // The stale writer has this message in hand; it is not on disk yet.
      staleView.messages.push({ role: 'assistant', content: 'written before the clear', createdAt: boundaryInBetween });

      // The clear lands first, then the stale writer saves.
      session.messages = [];
      session.finalAnswers = [];
      session.toolCalls = [];
      await store.save(session);
      await stale.save(staleView);

      const contents = (await store.load(session.id)).messages.map((m) => m.content);
      assert.deepEqual(contents, [], `a message discarded by /clear came back: ${JSON.stringify(contents)}`);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('a compaction stub replaces the transcript instead of being merged into it', async () => {
    const { workspace, dir, store, session } = await freshStore();
    try {
      const stale = new SessionStore(dir);
      const staleView = await stale.load(session.id);
      for (let i = 1; i <= 5; i += 1) {
        await store.appendMessage(session, { role: 'user', content: `long history ${i}` });
      }

      // Compaction: summary stub + tail of two real messages (5 → 3).
      session.messages = [
        { role: 'user', content: '[compacted session history] summary of 5 turns', createdAt: new Date().toISOString() },
        ...session.messages.slice(-2),
      ];
      await store.save(session);

      const contents = (await store.load(session.id)).messages.map((m) => m.content);
      assert.equal(contents[0], '[compacted session history] summary of 5 turns');
      assert.ok(!contents.includes('long history 1'), `compaction did not shrink: ${JSON.stringify(contents)}`);
      assert.deepEqual(contents.slice(1), ['long history 4', 'long history 5']);
      void staleView;
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
