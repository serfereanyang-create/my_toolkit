// Iteration 10 — per-session notes (main process store).
//
// The chat transcript is owned by the CLI and must stay untouched; user
// annotations for a session therefore live in a userData sidecar keyed by
// session id. Notes are small markdown snippets ("what to remember about this
// run") with pinning so a takeaway can float to the top. Same serialized
// write chain discipline as the snippets store.

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_NOTES_PER_SESSION = 100;
const MAX_NOTE_CHARS = 4000;

function sanitizeSessionId(id) {
  const s = String(id || '');
  // Session ids are opaque tokens from the CLI; keep only safe chars so a
  // crafted id can never escape the store directory. Dot segments are out.
  const clean = s.replace(/[^A-Za-z0-9_.-]/g, '');
  if (!clean || clean.length > 120) throw new Error('Invalid session id');
  if (clean === '.' || clean === '..' || clean.startsWith('.')) throw new Error('Invalid session id');
  return clean;
}

function sanitizeNote(input, now) {
  const text = String(input?.text ?? '').replace(/\r\n/g, '\n');
  if (!text.trim()) throw new Error('笔记不能为空');
  if (text.length > MAX_NOTE_CHARS) throw new Error(`笔记过长（上限 ${MAX_NOTE_CHARS} 字符）`);
  return {
    id: typeof input?.id === 'string' && input.id ? input.id : `note-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    text,
    pinned: Boolean(input?.pinned),
    createdAt: String(input?.createdAt ?? now),
    updatedAt: now,
  };
}

function createSessionNotesStore(userDataDir) {
  const storePath = path.join(userDataDir, 'session-notes.json');
  let chain = Promise.resolve();

  async function readRaw() {
    try {
      const parsed = JSON.parse(await fs.readFile(storePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed;
    } catch (error) {
      if (error && error.code === 'ENOENT') return {};
      return {}; // corrupt: treat as empty; next write heals
    }
  }

  async function writeRaw(data) {
    const tmp = `${storePath}.${process.pid}.tmp`;
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmp, storePath);
  }

  function mutate(fn) {
    const task = chain.then(async () => {
      const data = await readRaw();
      const result = await fn(data);
      await writeRaw(data);
      return result;
    });
    chain = task.catch(() => undefined);
    return task;
  }

  function sessionNotes(data, sessionId) {
    const id = sanitizeSessionId(sessionId);
    if (!Array.isArray(data[id])) data[id] = [];
    return { id, list: data[id] };
  }

  /** Pinned first, then newest-updated. */
  function sortNotes(notes) {
    return [...notes].sort((a, b) => (
      Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt)
    ));
  }

  async function list(sessionId) {
    const data = await readRaw();
    const bucket = data[sanitizeSessionId(sessionId)];
    return sortNotes(Array.isArray(bucket) ? bucket : []);
  }

  async function add(sessionId, input) {
    const now = new Date().toISOString();
    const note = sanitizeNote({ ...input, createdAt: now }, now);
    return await mutate(async (data) => {
      const { list: bucket } = sessionNotes(data, sessionId);
      if (bucket.length >= MAX_NOTES_PER_SESSION) throw new Error('该会话的笔记数量已达上限');
      bucket.push(note);
      return note;
    });
  }

  async function update(sessionId, noteId, patch) {
    const now = new Date().toISOString();
    return await mutate(async (data) => {
      const { list: bucket } = sessionNotes(data, sessionId);
      const idx = bucket.findIndex((n) => n.id === noteId);
      if (idx < 0) throw new Error('笔记不存在');
      const merged = sanitizeNote({ ...bucket[idx], ...patch, id: noteId, createdAt: bucket[idx].createdAt }, now);
      bucket[idx] = merged;
      return merged;
    });
  }

  async function remove(sessionId, noteId) {
    return await mutate(async (data) => {
      const { id, list: bucket } = sessionNotes(data, sessionId);
      const idx = bucket.findIndex((n) => n.id === noteId);
      if (idx < 0) return { ok: false };
      bucket.splice(idx, 1);
      if (!bucket.length) delete data[id];
      return { ok: true };
    });
  }

  async function clear(sessionId) {
    return await mutate(async (data) => {
      const id = sanitizeSessionId(sessionId);
      delete data[id];
      return { ok: true };
    });
  }

  /** Cross-session roll-up for the notes drawer header. */
  async function summary() {
    const data = await readRaw();
    const out = [];
    for (const [id, bucket] of Object.entries(data)) {
      if (!Array.isArray(bucket) || !bucket.length) continue;
      out.push({
        sessionId: id,
        count: bucket.length,
        pinned: bucket.filter((n) => n.pinned).length,
        lastUpdatedAt: bucket.reduce((max, n) => (n.updatedAt > max ? n.updatedAt : max), ''),
      });
    }
    out.sort((a, b) => b.lastUpdatedAt.localeCompare(a.lastUpdatedAt));
    return out;
  }

  return { list, add, update, remove, clear, summary, storePath };
}

module.exports = { createSessionNotesStore, sanitizeSessionId, MAX_NOTES_PER_SESSION, MAX_NOTE_CHARS };
