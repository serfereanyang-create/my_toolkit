'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createFileWatchRegistry } = require('../electron/file-watch-registry.cjs');

/*
 * Polled watching, driven by an injected clock.
 *
 * The refcount is the point. The map this replaced was `path → interval` and
 * returned `{ alreadyWatching: true }` for a path that was already watched
 * WITHOUT registering the second caller — while `unwatchFile` cleared the
 * interval unconditionally. So the moment two consumers wanted the same file —
 * an editor tab and a preview pane showing the same document, which is exactly
 * what the preview panes introduced — the first `unwatch` silently killed the
 * other's notifications for good.
 */

function harness({ files = new Map() } = {}) {
  const changes = [];
  const timers = new Map();
  let nextTimer = 1;

  const registry = createFileWatchRegistry({
    stat: async (absolutePath) => {
      const entry = files.get(absolutePath);
      if (!entry) { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error; }
      return entry;
    },
    onChange: (absolutePath) => changes.push(absolutePath),
    setInterval: (fn) => { const id = nextTimer++; timers.set(id, fn); return id; },
    clearInterval: (id) => { timers.delete(id); },
    pollMs: 1000,
  });

  /** Run every live poll callback once, as the clock would. */
  async function tick() {
    for (const fn of [...timers.values()]) await fn();
  }

  return { registry, changes, files, tick, liveTimers: () => timers.size };
}

test('reports a change once, then stays quiet until the file changes again', async () => {
  const h = harness({ files: new Map([['C:/w/a.docx', { mtimeMs: 100, size: 10 }]]) });
  await h.registry.watch('C:/w/a.docx');

  await h.tick();
  assert.deepEqual(h.changes, [], 'no change on an unchanged file');

  h.files.set('C:/w/a.docx', { mtimeMs: 200, size: 10 });
  await h.tick();
  assert.deepEqual(h.changes, ['C:/w/a.docx']);

  await h.tick();
  assert.deepEqual(h.changes, ['C:/w/a.docx'], 'not reported twice for the same mtime');
});

test('a size change with the same mtime is still a change', async () => {
  // Some writers preserve mtime; size is the second signal that something moved.
  const h = harness({ files: new Map([['C:/w/a.docx', { mtimeMs: 100, size: 10 }]]) });
  await h.registry.watch('C:/w/a.docx');
  h.files.set('C:/w/a.docx', { mtimeMs: 100, size: 99 });
  await h.tick();
  assert.deepEqual(h.changes, ['C:/w/a.docx']);
});

test('two subscribers on one path share a watcher, and the first to leave does not kill it', async () => {
  // The regression. An editor tab and a preview pane both watch the same file.
  const h = harness({ files: new Map([['C:/w/a.docx', { mtimeMs: 100, size: 10 }]]) });

  const first = await h.registry.watch('C:/w/a.docx');
  const second = await h.registry.watch('C:/w/a.docx');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.alreadyWatching, true, 'the second caller reuses the watcher');
  assert.equal(h.liveTimers(), 1, 'one poller for both');
  assert.equal(h.registry.watched()[0].subscribers, 2);

  h.registry.unwatch('C:/w/a.docx');
  assert.equal(h.liveTimers(), 1, "the editor closing must not stop the pane's watcher");

  h.files.set('C:/w/a.docx', { mtimeMs: 300, size: 10 });
  await h.tick();
  assert.deepEqual(h.changes, ['C:/w/a.docx'], 'the remaining subscriber still hears about changes');

  h.registry.unwatch('C:/w/a.docx');
  assert.equal(h.liveTimers(), 0, 'the last subscriber stops the poller');
  assert.deepEqual(h.registry.watched(), []);
});

test('a path is matched regardless of separators and case', async () => {
  // The renderer holds a descriptor path; the watcher is asked for it in either
  // form. A missed match would mean two pollers on one file, or a leaked watch.
  const h = harness({ files: new Map([['c:/w/a.docx', { mtimeMs: 100, size: 10 }]]) });
  await h.registry.watch('c:/w/a.docx');
  const again = await h.registry.watch('C:\\W\\A.DOCX');
  assert.equal(again.alreadyWatching, true);
  assert.equal(h.liveTimers(), 1);
});

test('a missing file still creates a watch, which starts reporting once it appears', async () => {
  // The agent may be mid-write, or about to create the file. A watch that
  // silently does nothing is worse than one that starts working.
  const h = harness();
  const result = await h.registry.watch('C:/w/new.docx');
  assert.equal(result.ok, false, 'the caller is told it does not exist yet');
  assert.match(result.error, /not found/);

  h.files.set('C:/w/new.docx', { mtimeMs: 5, size: 1 });
  await h.tick();
  assert.deepEqual(h.changes, ['C:/w/new.docx'], 'the first successful stat reports a change');
});

test('a stat failure is not reported as a change', async () => {
  // A locked file (mid-save rename) fails to stat. Reporting that as a change
  // would make the pane re-render on every transient lock.
  const h = harness({ files: new Map([['C:/w/a.docx', { mtimeMs: 100, size: 10 }]]) });
  await h.registry.watch('C:/w/a.docx');
  h.files.delete('C:/w/a.docx');
  await h.tick();
  assert.deepEqual(h.changes, [], 'a failed stat is not evidence the file changed');

  h.files.set('C:/w/a.docx', { mtimeMs: 400, size: 10 });
  await h.tick();
  assert.deepEqual(h.changes, ['C:/w/a.docx'], 'and it recovers when the file returns');
});

test('unwatching an unknown path is a no-op, and stopAll clears everything', async () => {
  const h = harness({ files: new Map([
    ['C:/w/a.docx', { mtimeMs: 1, size: 1 }],
    ['C:/w/b.xlsx', { mtimeMs: 1, size: 1 }],
  ]) });
  assert.deepEqual(h.registry.unwatch('C:/w/never-watched'), { ok: true });

  await h.registry.watch('C:/w/a.docx');
  await h.registry.watch('C:/w/b.xlsx');
  assert.equal(h.liveTimers(), 2);

  h.registry.stopAll();
  assert.equal(h.liveTimers(), 0);
  assert.deepEqual(h.registry.watched(), []);

  // A stopped registry does not report anything from the old timers.
  h.changes.length = 0;
  h.files.set('C:/w/a.docx', { mtimeMs: 999, size: 9 });
  await h.tick();
  assert.deepEqual(h.changes, []);
});
