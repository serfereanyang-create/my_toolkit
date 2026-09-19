const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { createSubagentRunStore } = require('../electron/subagent-runs.cjs');

async function makeStore() {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-subagent-'));
  await mkdir(path.join(root, '.aicode'), { recursive: true });
  const store = createSubagentRunStore(() => root);
  return { root, store };
}

test('a started run is running, and done moves it to finished', async () => {
  const { root, store } = await makeStore();

  await store.record({ sessionId: 'sess_1', phase: 'started', id: 'a', goal: 'research cache', expert: 'code_search' });
  let { running, finished } = await store.listGrouped('sess_1', new Set(['sess_1']));
  assert.equal(running.length, 1);
  assert.equal(running[0].status, 'running');
  assert.equal(running[0].goal, 'research cache');
  assert.equal(finished.length, 0);

  await store.record({
    sessionId: 'sess_1', phase: 'done', id: 'a', goal: 'research cache', expert: 'code_search',
    ok: true, answer: 'found it', subSessionId: 'sess_sub', durationMs: 1234, steps: 7,
  });
  ({ running, finished } = await store.listGrouped('sess_1', new Set(['sess_1'])));
  assert.equal(running.length, 0);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].status, 'done');
  assert.equal(finished[0].answer, 'found it');
  assert.equal(finished[0].subSessionId, 'sess_sub');
  assert.equal(finished[0].durationMs, 1234);
  assert.equal(finished[0].steps, 7);
  // The start time must survive the update, or elapsed/duration reads wrong.
  assert.ok(finished[0].startedAt);

  await rm(root, { recursive: true, force: true });
});

test('a failed run is recorded as failed, not done', async () => {
  const { root, store } = await makeStore();
  await store.record({ sessionId: 'sess_1', phase: 'started', id: 'a', goal: 'g', expert: 'general' });
  await store.record({ sessionId: 'sess_1', phase: 'done', id: 'a', goal: 'g', expert: 'general', ok: false, answer: 'boom' });
  const { finished } = await store.listGrouped('sess_1', new Set(['sess_1']));
  assert.equal(finished[0].status, 'failed');
  assert.equal(finished[0].answer, 'boom');
  await rm(root, { recursive: true, force: true });
});

test('a run whose bridge is gone reports interrupted, never running', async () => {
  // The core reconciliation: a stale "running" row would claim work that is
  // not happening. Only the caller knows which sessions are live.
  const { root, store } = await makeStore();
  await store.record({ sessionId: 'sess_dead', phase: 'started', id: 'a', goal: 'g', expert: 'general' });

  const stale = await store.list('sess_dead', new Set());
  assert.equal(stale[0].status, 'interrupted');
  // An interrupted run is finished, not running: it must not sit in 正在运行.
  const grouped = await store.listGrouped('sess_dead', new Set());
  assert.equal(grouped.running.length, 0);
  assert.equal(grouped.finished.length, 1);

  const live = await store.list('sess_dead', new Set(['sess_dead']));
  assert.equal(live[0].status, 'running');

  await rm(root, { recursive: true, force: true });
});

test('a done event for an unseen run still creates a finished row', async () => {
  // Events can arrive out of order (or from a bridge that restarted), and
  // dropping the result would lose a real run.
  const { root, store } = await makeStore();
  await store.record({ sessionId: 'sess_1', phase: 'done', id: 'ghost', goal: 'g', expert: 'general', ok: true, answer: 'x' });
  const { finished } = await store.listGrouped('sess_1', new Set(['sess_1']));
  assert.equal(finished.length, 1);
  assert.equal(finished[0].status, 'done');
  await rm(root, { recursive: true, force: true });
});

test('runs are scoped per session and listed newest first', async () => {
  const { root, store } = await makeStore();
  await store.record({ sessionId: 'sess_a', phase: 'started', id: 'a1', goal: 'A one', expert: 'general' });
  await store.record({ sessionId: 'sess_b', phase: 'started', id: 'b1', goal: 'B one', expert: 'general' });

  const a = await store.list('sess_a', new Set(['sess_a', 'sess_b']));
  assert.equal(a.length, 1);
  assert.equal(a[0].goal, 'A one');

  const all = await store.list(undefined, new Set(['sess_a', 'sess_b']));
  assert.equal(all.length, 2);

  await rm(root, { recursive: true, force: true });
});

test('runs persist across a reload of the store', async () => {
  const { root, store } = await makeStore();
  await store.record({ sessionId: 'sess_1', phase: 'started', id: 'a', goal: 'persisted', expert: 'general' });

  // A fresh store instance on the same workspace must read the sidecar.
  const reopened = createSubagentRunStore(() => root);
  const runs = await reopened.list('sess_1', new Set(['sess_1']));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].goal, 'persisted');

  const raw = JSON.parse(await readFile(path.join(root, '.aicode', 'desktop', 'subagent-runs.json'), 'utf8'));
  assert.ok(raw.sess_1, 'sidecar should be keyed by parent session id');

  await rm(root, { recursive: true, force: true });
});

test('remove clears one session without touching others', async () => {
  const { root, store } = await makeStore();
  await store.record({ sessionId: 'sess_a', phase: 'started', id: 'a', goal: 'A', expert: 'general' });
  await store.record({ sessionId: 'sess_b', phase: 'started', id: 'b', goal: 'B', expert: 'general' });

  await store.remove('sess_a');
  assert.equal((await store.list('sess_a', new Set())).length, 0);
  assert.equal((await store.list('sess_b', new Set(['sess_b']))).length, 1);

  await rm(root, { recursive: true, force: true });
});

test('malformed events are rejected instead of corrupting the store', async () => {
  const { root, store } = await makeStore();
  assert.equal((await store.record({ phase: 'started', id: 'a' })).ok, false);
  assert.equal((await store.record({ sessionId: 'sess_1', phase: 'started' })).ok, false);
  assert.equal((await store.list('sess_1', new Set())).length, 0);
  await rm(root, { recursive: true, force: true });
});

test('no workspace open yields an empty list rather than throwing', async () => {
  const store = createSubagentRunStore(() => null);
  assert.deepEqual(await store.list(undefined, new Set()), []);
});
