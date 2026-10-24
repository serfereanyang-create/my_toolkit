'use strict';
/**
 * Session tags (iteration 18): lightweight labels attached to chat sessions.
 * The session JSON itself is CLI-owned, so tags live in a workspace sidecar
 * (.aicode/desktop/session-tags.json) keyed by session id — same pattern as
 * the bookmark store. Losing the sidecar only loses tags, never transcripts.
 *
 * Durable plumbing (atomic replace, rename retry, corrupt-file quarantine,
 * serialized mutations) is json-store.cjs. There is no in-memory cache on
 * purpose: it used to be loaded once per workspace root and written back whole,
 * so a second window (or a hand-edit) silently lost whatever it did not know.
 */
const path = require('node:path');
const { createJsonStore } = require('./json-store.cjs');

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

/** Keep only well-formed { sessionId: tags[] } pairs, de-duplicated and capped. */
function sanitizeMap(parsed) {
  const out = {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  for (const [key, value] of Object.entries(parsed)) {
    const sid = sanitizeSessionId(key);
    if (!sid || !Array.isArray(value)) continue;
    const tags = [];
    for (const t of value) {
      const tag = sanitizeTag(t);
      if (tag && !tags.includes(tag) && tags.length < MAX_PER_SESSION) tags.push(tag);
    }
    if (tags.length) out[sid] = tags;
  }
  return out;
}

function distinctTags(map) {
  const all = new Set();
  for (const tags of Object.values(map)) for (const tag of tags) all.add(tag);
  return all;
}

/**
 * @param {() => string|null} getRoot current workspace root (null when none)
 */
function createSessionTagsStore(getRoot) {
  function tagsFile() {
    const root = getRoot();
    if (!root) throw new Error('没有打开工作区');
    return path.join(root, '.aicode', 'desktop', 'session-tags.json');
  }

  const store = createJsonStore({ file: tagsFile, normalize: sanitizeMap });

  /** All tags as { sessionId -> tags[] }. */
  async function listAll() {
    try {
      return await store.read();
    } catch {
      return {};
    }
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
    try {
      return await store.mutate((data) => {
        if (cleaned.length === 0) delete data[sid];
        else data[sid] = cleaned;
        return { ok: true, sessionId: sid, tags: cleaned };
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Toggle one tag on a session; returns the resulting tag list.
   *
   * The read and the write happen inside one queued mutation: checking the cap
   * against a snapshot taken before the queue (the old shape) let two toggles
   * in the same tick each pass the check and exceed it together.
   */
  async function toggleTag(sessionId, rawTag) {
    const sid = sanitizeSessionId(sessionId);
    if (!sid) return { ok: false, error: '非法会话 ID' };
    const tag = sanitizeTag(rawTag);
    if (!tag) return { ok: false, error: '标签不能为空' };
    try {
      return await store.mutate((data) => {
        const tags = Array.isArray(data[sid]) ? [...data[sid]] : [];
        const at = tags.indexOf(tag);
        if (at >= 0) {
          tags.splice(at, 1);
        } else {
          if (!distinctTags(data).has(tag) && distinctTags(data).size >= MAX_TAGS) {
            return { ok: false, error: `标签数量已达上限（${MAX_TAGS}）` };
          }
          if (tags.length >= MAX_PER_SESSION) {
            return { ok: false, error: `单个会话最多 ${MAX_PER_SESSION} 个标签` };
          }
          tags.push(tag);
        }
        if (tags.length === 0) delete data[sid];
        else data[sid] = tags;
        return { ok: true, sessionId: sid, tags };
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Drop tags for a removed/archived session. */
  async function remove(sessionId) {
    const sid = sanitizeSessionId(sessionId);
    if (!sid) return { ok: false, error: '非法会话 ID' };
    try {
      return await store.mutate((data) => {
        delete data[sid];
        return { ok: true, removed: sid };
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { listAll, setTags, toggleTag, remove };
}

module.exports = { createSessionTagsStore, sanitizeTag, sanitizeSessionId };
