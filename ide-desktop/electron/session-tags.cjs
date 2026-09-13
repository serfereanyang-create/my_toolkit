'use strict';
/**
 * Session tags (iteration 18): lightweight labels attached to chat sessions.
 * The session JSON itself is CLI-owned, so tags live in a workspace sidecar
 * (.aicode/desktop/session-tags.json) keyed by session id — same pattern as
 * the bookmark store. Losing the sidecar only loses tags, never transcripts.
 */
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_TAGS = 24;      // distinct tags across the workspace
const MAX_PER_SESSION = 6;
const MAX_TAG_LEN = 24;

function sanitizeTag(raw) {
  // Tags are case-folded for storage so "WIP" and "wip" are one tag; the
  // renderer normalises the same way (lib/sessionTags.ts).
  const t = String(raw ?? '').trim().replace(/\s+/g, ' ').toLowerCase().slice(0, MAX_TAG_LEN);
  return t || null;
}

function sanitizeSessionId(raw) {
  const id = String(raw ?? '').trim();
  if (!id || id === '.' || id === '..' || id.startsWith('.')) return null;
  if (/[\\/]|\.\./.test(id)) return null; // no paths, no traversal
  return id;
}

/**
 * @param {() => string|null} getRoot current workspace root (null when none)
 */
function createSessionTagsStore(getRoot) {
  let chain = Promise.resolve();
  let loadedFor = null; // root the in-memory map was loaded from
  /** @type {Map<string, string[]>} sessionId -> tags */
  let map = new Map();

  function tagsFile(root) {
    return path.join(root, '.aicode', 'desktop', 'session-tags.json');
  }

  async function loadLocked(root) {
    if (loadedFor === root) return;
    loadedFor = root;
    map = new Map();
    try {
      const raw = await fs.readFile(tagsFile(root), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          const sid = sanitizeSessionId(key);
          if (!sid || !Array.isArray(value)) continue;
          const tags = [];
          for (const t of value) {
            const tag = sanitizeTag(t);
            if (tag && !tags.includes(tag) && tags.length < MAX_PER_SESSION) tags.push(tag);
          }
          if (tags.length) map.set(sid, tags);
        }
      }
    } catch { /* missing or corrupt file heals to empty */ }
  }

  async function saveLocked(root) {
    const file = tagsFile(root);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const obj = {};
    for (const [sid, tags] of map) obj[sid] = tags;
    const tmp = file + '.tmp';
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

  /** All tags as { sessionId -> tags[] }. */
  async function listAll() {
    const r = await mutate(async () => {
      const out = {};
      for (const [sid, tags] of map) out[sid] = [...tags];
      return out;
    });
    return r.value ?? {};
  }

  /** Replace the tag set of one session (empty list removes it). */
  async function setTags(sessionId, tags) {
    const sid = sanitizeSessionId(sessionId);
    if (!sid) return { ok: false, error: '非法会话 ID' };
    const cleaned = [];
    for (const t of Array.isArray(tags) ? tags : []) {
      const tag = sanitizeTag(t);
      if (tag && !cleaned.includes(tag)) cleaned.push(tag);
      if (cleaned.length >= MAX_PER_SESSION) break;
    }
    const r = await mutate(async (root) => {
      if (cleaned.length === 0) map.delete(sid);
      else map.set(sid, cleaned);
      await saveLocked(root);
      return { sessionId: sid, tags: cleaned };
    });
    if (r.error) return { ok: false, error: r.error };
    return { ok: true, ...r.value };
  }

  /** Toggle one tag on a session; returns the resulting tag list. */
  async function toggleTag(sessionId, rawTag) {
    const tag = sanitizeTag(rawTag);
    if (!tag) return { ok: false, error: '标签不能为空' };
    const current = await listAll();
    const tags = current[sessionId] ? [...current[sessionId]] : [];
    const at = tags.indexOf(tag);
    if (at >= 0) tags.splice(at, 1);
    else {
      const distinct = new Set();
      for (const sid of Object.keys(current)) for (const t of current[sid]) distinct.add(t);
      if (!distinct.has(tag) && distinct.size >= MAX_TAGS) {
        return { ok: false, error: `标签数量已达上限（${MAX_TAGS}）` };
      }
      if (tags.length >= MAX_PER_SESSION) {
        return { ok: false, error: `单个会话最多 ${MAX_PER_SESSION} 个标签` };
      }
      tags.push(tag);
    }
    const out = await setTags(sessionId, tags);
    if (!out.ok) return out;
    return { ok: true, sessionId, tags: out.tags };
  }

  /** Drop tags for a removed/archived session. */
  async function remove(sessionId) {
    const sid = sanitizeSessionId(sessionId);
    if (!sid) return { ok: false, error: '非法会话 ID' };
    const r = await mutate(async (root) => {
      map.delete(sid);
      await saveLocked(root);
      return { removed: sid };
    });
    if (r.error) return { ok: false, error: r.error };
    return { ok: true, ...r.value };
  }

  return { listAll, setTags, toggleTag, remove };
}

module.exports = { createSessionTagsStore, sanitizeTag, sanitizeSessionId };
