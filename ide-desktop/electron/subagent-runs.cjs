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
const path = require('node:path');
const { createJsonStore } = require('./json-store.cjs');

/** Keep the directory bounded — this is a recent-activity view, not an archive. */
const MAX_RUNS = 200;

function runsFile(root) {
  return path.join(root, '.aicode', 'desktop', 'subagent-runs.json');
}

function cleanText(raw, max) {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function createSubagentRunStore(getRoot) {
  // Durable plumbing comes from json-store.cjs. The runs are re-read on every
  // mutation instead of being cached per root: a cache loaded once meant a
  // second window wrote back a stale list, dropping runs it never saw.
  const store = createJsonStore({
    file: () => {
      const root = getRoot();
      if (!root) throw new Error('没有打开工作区');
      return runsFile(root);
    },
    normalize: shapeAll,
  });

  /** Keep only well-formed run arrays, newest first, capped per session. */
  function shapeAll(parsed) {
    const out = {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
    for (const [sessionId, runs] of Object.entries(parsed)) {
      if (!sessionId || !Array.isArray(runs)) continue;
      const kept = runs.filter((run) => run && typeof run === 'object' && typeof run.id === 'string').slice(0, MAX_RUNS);
      if (kept.length) out[sessionId] = kept;
    }
    return out;
  }

  async function readAll() {
    try {
      return await store.read();
    } catch {
      return {};
    }
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

    let outcome;
    try {
      outcome = await store.mutate((data) => {
        const runs = Array.isArray(data[sessionId]) ? [...data[sessionId]] : [];
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
        data[sessionId] = runs.slice(0, MAX_RUNS);
        return { run: next };
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true, ...outcome };
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
    const data = await readAll();
    const liveSet = live instanceof Set ? live : new Set(Array.isArray(live) ? live : []);
    const collect = (runs, ownerId) =>
      runs.map((run) => (
        run.status === 'running' && !liveSet.has(ownerId)
          ? { ...run, status: 'interrupted' }
          : run
      ));
    if (sessionId) return collect(data[String(sessionId)] ?? [], String(sessionId));
    const all = [];
    for (const [ownerId, runs] of Object.entries(data)) all.push(...collect(runs, ownerId));
    all.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    return all.slice(0, MAX_RUNS);
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
    try {
      const outcome = await store.mutate((data) => {
        delete data[sid];
        return { removed: sid };
      });
      return { ok: true, ...outcome };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { record, list, listGrouped, remove };
}

module.exports = { createSubagentRunStore, MAX_RUNS };
