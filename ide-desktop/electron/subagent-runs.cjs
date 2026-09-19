'use strict';
/**
 * subagent-runs.cjs — the 子智能体目录 (subagent directory) store.
 *
 * The CLI already gives every subagent its own session, but nothing listed
 * those runs: the desktop could only show a generic `spawn_subagent` tool card
 * in the conversation stream. This store keeps a workspace-scoped index of
 * runs so the directory can show what is running now and what finished.
 *
 * Runs arrive from the CLI's `subagent_started` / `subagent_done` events
 * (emitted by runSubAgent). A run that starts but never reports done — the
 * bridge died mid-flight — is reconciled on load: it is shown as 已中断 rather
 * than forever 运行中, because a stale "running" row is a lie.
 *
 * Persistence is a sidecar (.aicode/desktop/subagent-runs.json) keyed by
 * parent session id, so losing it loses only the directory listing, never a
 * transcript or a subagent's own session.
 */
const fs = require('node:fs/promises');
const path = require('node:path');

/** Keep the directory bounded — this is a recent-activity view, not an archive. */
const MAX_RUNS = 200;

function runsFile(root) {
  return path.join(root, '.aicode', 'desktop', 'subagent-runs.json');
}

function cleanText(raw, max) {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function createSubagentRunStore(getRoot) {
  let chain = Promise.resolve();
  let loadedFor = null;
  /** @type {Map<string, object[]>} parentSessionId -> runs (newest first) */
  let map = new Map();

  async function loadLocked(root) {
    if (loadedFor === root) return;
    loadedFor = root;
    map = new Map();
    try {
      const parsed = JSON.parse(await fs.readFile(runsFile(root), 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [sessionId, runs] of Object.entries(parsed)) {
          if (!sessionId || !Array.isArray(runs)) continue;
          map.set(sessionId, runs.filter((r) => r && typeof r === 'object').slice(0, MAX_RUNS));
        }
      }
    } catch { /* missing or corrupt sidecar heals to empty */ }
  }

  async function saveLocked(root) {
    const file = runsFile(root);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const obj = {};
    for (const [sessionId, runs] of map) obj[sessionId] = runs;
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
    await fs.rename(tmp, file);
  }

  function mutate(fn) {
    const run = chain.then(async () => {
      const root = getRoot();
      if (!root) return { error: '没有打开工作区', value: null };
      await loadLocked(root);
      const out = await fn(root);
      return { error: null, value: out };
    });
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Fold one CLI subagent event into the store.
   *
   * `started` inserts a running row; `done` updates it in place. A `done` for
   * an id we never saw started (events arriving out of order, or a run from a
   * previous bridge) still creates a finished row rather than dropping it.
   */
  async function record(event) {
    const sessionId = String(event?.sessionId ?? '').trim();
    const id = cleanText(event?.id, 80);
    if (!sessionId || !id) return { ok: false, error: '缺少 sessionId 或 id' };
    const phase = event?.phase === 'done' ? 'done' : 'started';

    const r = await mutate(async (root) => {
      const runs = map.get(sessionId) ?? [];
      const at = runs.findIndex((run) => run.id === id);
      const base = at >= 0 ? runs[at] : null;

      const next = {
        id,
        goal: cleanText(event?.goal, 400),
        expert: cleanText(event?.expert, 40) || 'general',
        status: phase === 'done' ? (event?.ok === false ? 'failed' : 'done') : 'running',
        startedAt: base?.startedAt ?? new Date().toISOString(),
        finishedAt: phase === 'done' ? new Date().toISOString() : base?.finishedAt,
        // A finished row keeps the answer; a running row has none yet.
        answer: phase === 'done' ? cleanText(event?.answer, 400) : base?.answer ?? '',
        subSessionId: cleanText(event?.subSessionId, 80) || base?.subSessionId || '',
        durationMs: phase === 'done' ? Number(event?.durationMs) || 0 : base?.durationMs,
        steps: phase === 'done' ? Number(event?.steps) || 0 : base?.steps,
      };

      if (at >= 0) runs[at] = next;
      else runs.unshift(next);
      map.set(sessionId, runs.slice(0, MAX_RUNS));

      await saveLocked(root);
      return { run: next };
    });

    if (r.error) return { ok: false, error: r.error };
    return { ok: true, ...r.value };
  }

  /**
   * Runs for one session (or every session when omitted), newest first.
   *
   * A `running` row whose parent bridge is gone is reported as `interrupted`:
   * the store cannot know it is still alive, and showing a finished run as
   * running misleads the user. `live` lists the session ids whose bridge is
   * currently up.
   */
  async function list(sessionId, live) {
    const r = await mutate(async () => {
      const liveSet = live instanceof Set ? live : new Set(Array.isArray(live) ? live : []);
      const collect = (runs, ownerId) =>
        runs.map((run) => (
          run.status === 'running' && !liveSet.has(ownerId)
            ? { ...run, status: 'interrupted' }
            : run
        ));
      if (sessionId) return collect(map.get(String(sessionId)) ?? [], String(sessionId));
      const all = [];
      for (const [ownerId, runs] of map) all.push(...collect(runs, ownerId));
      all.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
      return all.slice(0, MAX_RUNS);
    });
    return r.value ?? [];
  }

  /**
   * Runs for one session split into the directory's two sections.
   *
   * The split lives here rather than in the IPC handler so the contract
   * (a run is in exactly one section, and only genuinely live runs are
   * `running`) is directly testable.
   */
  async function listGrouped(sessionId, live) {
    const runs = await list(sessionId, live);
    return {
      running: runs.filter((run) => run.status === 'running'),
      finished: runs.filter((run) => run.status !== 'running'),
    };
  }

  /** Forget the runs of one session (called when its transcript is deleted). */
  async function remove(sessionId) {
    const sid = String(sessionId ?? '').trim();
    if (!sid) return { ok: false, error: '缺少 sessionId' };
    const r = await mutate(async (root) => {
      map.delete(sid);
      await saveLocked(root);
      return { removed: sid };
    });
    if (r.error) return { ok: false, error: r.error };
    return { ok: true, ...r.value };
  }

  return { record, list, listGrouped, remove };
}

module.exports = { createSubagentRunStore, MAX_RUNS };
