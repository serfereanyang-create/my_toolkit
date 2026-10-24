const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { createJsonStore } = require('./json-store.cjs');

function createWorkspaceService() {
  let root = '';

  function setRoot(nextRoot) {
    if (typeof nextRoot !== 'string' || !nextRoot.trim()) throw new Error('Workspace root is required');
    const resolved = path.resolve(nextRoot);
    const canonical = fsSync.realpathSync(resolved);
    if (!fsSync.statSync(canonical).isDirectory()) throw new Error('Workspace root is not a directory');
    // Keep one canonical spelling for all downstream path comparisons. This
    // also prevents a workspace symlink from changing the security boundary.
    root = canonical;
    return root;
  }

  function getRoot() {
    return root;
  }

  function resolveInside(relativePath) {
    if (!root) throw new Error('No workspace open');
    const resolved = path.resolve(root, relativePath || '.');
    const rel = path.relative(root, resolved);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return resolved;
    throw new Error(`Path escapes workspace: ${relativePath}`);
  }

  async function readFile(relativePath) {
    return await fs.readFile(resolveInside(relativePath), 'utf8');
  }

  async function writeFile(relativePath, content) {
    const target = resolveInside(relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
    return { path: relativePath, ok: true };
  }

  async function tree(relativePath = '.') {
    const target = resolveInside(relativePath);
    const entries = await fs.readdir(target, { withFileTypes: true });
    const visible = entries
      .filter((entry) => !entry.name.startsWith('.git') && entry.name !== 'node_modules' && entry.name !== 'dist')
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

    return await Promise.all(visible.map(async (entry) => {
      const childRelative = path.posix.join(relativePath === '.' ? '' : relativePath.replace(/\\/g, '/'), entry.name);
      return {
        name: entry.name,
        path: childRelative,
        type: entry.isDirectory() ? 'directory' : 'file',
      };
    }));
  }

  function sessionRootDir() {
    return resolveInside('.aicode/sessions');
  }

  function sessionFile(id) {
    // Guard against path traversal via crafted session ids.
    const safe = String(id).replace(/[^A-Za-z0-9_.-]/g, '');
    if (!safe || safe !== String(id)) throw new Error(`Invalid session id: ${id}`);
    return path.join(sessionRootDir(), `${safe}.json`);
  }

  function overlayFile() {
    return path.join(sessionRootDir(), '.desktop-meta.json');
  }

  // Desktop-only metadata (title / pinned) kept in a sidecar so the CLI's
  // session JSON files are never mutated by the desktop.
  //
  // The sidecar holds EVERY session's title, pin and archive flag, so it is the
  // one file in the workspace whose loss is silent and total: renaming one chat
  // after a crashed write used to replace the whole map with a single entry and
  // take the other chats' names with it. It goes through the shared JSON store
  // for all three reasons that store exists — atomic replace, quarantining an
  // unreadable copy instead of overwriting it, and serialising the
  // read-modify-write pairs that pin/rename/archive all perform.
  const overlayStore = createJsonStore({
    file: overlayFile,
    empty: () => ({}),
    normalize: (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
  });

  async function readOverlay() {
    return await overlayStore.read();
  }

  /**
   * The title a session carries in its own record (`/rename` in the CLI writes
   * it there; the desktop writes its own to the sidecar overlay).
   */
  function recordTitle(record) {
    const title = record?.title;
    return typeof title === 'string' && title.trim() ? title.trim() : '';
  }

  /**
   * Pinned in the sidecar overlay (this app) or on the record (`/pin` in the
   * CLI — including the `guard.pinned` field older CLI builds wrote). The
   * overlay wins when it has an opinion, so unpinning here sticks.
   */
  function recordPinned(overlay, record) {
    if (overlay && typeof overlay.pinned === 'boolean') return overlay.pinned;
    if (record?.pinned === true) return true;
    return record?.guard?.pinned === true;
  }

  function firstUserText(record) {
    const messages = Array.isArray(record?.messages) ? record.messages : [];
    const firstUser = messages.find((m) => m && m.role === 'user' && typeof m.content === 'string' && m.content.trim());
    const text = firstUser ? firstUser.content.trim() : '';
    return text.replace(/\s+/g, ' ').slice(0, 60);
  }

  /**
   * Fallback label for a session with no user text (created but never used).
   * Falling back to the raw id put `sess_20260918154818_ddd042a6` in the
   * sidebar, which is an internal identifier, not a title. Session ids embed
   * their creation time as YYYYMMDDHHMMSS, so surface that as a readable
   * stamp and keep the raw id only for ids that don't match the shape.
   */
  function fallbackTitle(id, record) {
    const stamp = /^sess_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(String(id || ''));
    if (stamp) {
      const [, y, mo, d, h, mi] = stamp;
      return `未命名会话 · ${y}-${mo}-${d} ${h}:${mi}`;
    }
    // A record timestamp is still better than an opaque id.
    const at = record?.createdAt || record?.updatedAt;
    if (typeof at === 'string' && at.length >= 16) return `未命名会话 · ${at.slice(0, 10)} ${at.slice(11, 16)}`;
    return '未命名会话';
  }

  async function listSessions() {
    const dir = sessionRootDir();
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw error;
    }
    const overlay = await readOverlay();
    const files = entries.filter((name) => name.endsWith('.json') && name !== '.desktop-meta.json');
    const metas = [];
    for (const name of files) {
      const id = name.replace(/\.json$/, '');
      try {
        const record = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
        const ov = overlay[id] || {};
        metas.push({
          id,
          title: ov.title || recordTitle(record) || firstUserText(record) || fallbackTitle(id, record),
          pinned: recordPinned(ov, record),
          archived: Boolean(ov.archived),
          updatedAt: record.updatedAt || record.createdAt || '',
          messageCount: Array.isArray(record.messages) ? record.messages.length : 0,
        });
      } catch {
        // Skip corrupt session files rather than breaking the whole list.
      }
    }
    metas.sort((a, b) => Number(b.pinned) - Number(a.pinned) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    // A record with no message at all is a process that started and stopped —
    // a spawned CLI child that created its session file before the user typed
    // anything. Listing them filled the sidebar with same-titled 未命名会话 rows
    // and, because the cap is applied after sorting, pushed real conversations
    // out of the 50 shown. Pinned is kept: an explicit pin is the user's call.
    const real = metas.filter((m) => !m.archived && (m.messageCount > 0 || m.pinned)).slice(0, 50);
    return disambiguateTitles(real);
  }

  /**
   * Make same-titled conversations tell themselves apart.
   *
   * The title is the first user prompt, so "你好" typed eighteen times produced
   * eighteen identical rows — picking the right one was guesswork. Only the
   * clashing rows get a timestamp appended: a unique title is left exactly as
   * it was, so the list stays quiet until there is something to disambiguate.
   */
  function disambiguateTitles(metas) {
    const counts = new Map();
    for (const meta of metas) counts.set(meta.title, (counts.get(meta.title) || 0) + 1);
    return metas.map((meta) => {
      if ((counts.get(meta.title) || 0) < 2) return meta;
      const at = meta.updatedAt || meta.createdAt || '';
      // `2026-10-17T15:28:50.881Z` → `10-17 15:28`, the same stamp the
      // untitled fallback uses.
      const stamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(at);
      if (!stamp) return meta;
      const [, , month, day, hour, minute] = stamp;
      return {
        ...meta,
        // The rename box must show the real title, not the disambiguated one —
        // otherwise confirming a rename would write the timestamp into it.
        baseTitle: meta.title,
        title: `${meta.title} · ${month}-${day} ${hour}:${minute}`,
      };
    });
  }

  async function listArchivedSessions() {
    const dir = sessionRootDir();
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw error;
    }
    const overlay = await readOverlay();
    const files = entries.filter((name) => name.endsWith('.json') && name !== '.desktop-meta.json');
    const metas = [];
    for (const name of files) {
      const id = name.replace(/\.json$/, '');
      const ov = overlay[id] || {};
      if (!ov.archived) continue;
      try {
        const record = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
        metas.push({
          id,
          title: ov.title || recordTitle(record) || firstUserText(record) || fallbackTitle(id, record),
          pinned: recordPinned(ov, record),
          archived: true,
          updatedAt: record.updatedAt || record.createdAt || '',
          messageCount: Array.isArray(record.messages) ? record.messages.length : 0,
        });
      } catch {
        // Skip corrupt session files rather than breaking the whole list.
      }
    }
    metas.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return metas.slice(0, 100);
  }

  /**
   * Where sub-agent sessions live, beside the user's conversations.
   *
   * A sub-agent writes one record per segment. Those used to land in the main
   * directory, so the sidebar listed them as chats — a batch of untitled
   * shells and `## 主任务背景` internal runs pushed the real conversations past
   * the 50-row cap. The 子智能体目录 still shows the id, so this directory has
   * to stay loadable.
   */
  function subagentSessionDir() {
    return resolveInside('.aicode/sessions-subagents');
  }

  async function loadSession(id) {
    try {
      return JSON.parse(await fs.readFile(sessionFile(id), 'utf8'));
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
      // Not a conversation: fall back to the sub-agent store. Reading is all a
      // caller can do with it anyway — it is not in the session list.
      const safe = String(id).replace(/[^A-Za-z0-9_.-]/g, '');
      if (!safe || safe !== String(id)) throw error;
      return JSON.parse(await fs.readFile(path.join(subagentSessionDir(), `${safe}.json`), 'utf8'));
    }
  }

  async function deleteSession(id) {
    await fs.rm(sessionFile(id), { force: true });
    await overlayStore.mutate((overlay) => {
      delete overlay[id];
    });
    return { ok: true, id };
  }

  async function renameSession(id, title) {
    // Verify the session exists before recording a title for it.
    await fs.access(sessionFile(id));
    const nextTitle = String(title || '').slice(0, 120);
    await overlayStore.mutate((overlay) => {
      overlay[id] = { ...(overlay[id] || {}), title: nextTitle };
    });
    return { ok: true, id, title: nextTitle };
  }

  async function pinSession(id, pinned) {
    await fs.access(sessionFile(id));
    const nextPinned = Boolean(pinned);
    await overlayStore.mutate((overlay) => {
      overlay[id] = { ...(overlay[id] || {}), pinned: nextPinned };
    });
    return { ok: true, id, pinned: nextPinned };
  }

  async function archiveSession(id, archived) {
    await fs.access(sessionFile(id));
    const nextArchived = Boolean(archived);
    await overlayStore.mutate((overlay) => {
      overlay[id] = { ...(overlay[id] || {}), archived: nextArchived };
    });
    return { ok: true, id, archived: nextArchived };
  }

  function sessionAbsolutePath(id) {
    return sessionFile(id);
  }

  /**
   * Copy a session into a new one that inherits its whole conversation.
   *
   * The context menu has always offered "continue in a new chat", but it only
   * reopened the original session. A fork that carried just the last message
   * would be no better: the new conversation could not answer a follow-up about
   * anything decided earlier.
   *
   * The source file is never written, so forking cannot alter the conversation
   * it forks. Only the sidecar overlay gets a title for the new id.
   */
  async function forkSession(id) {
    const source = JSON.parse(await fs.readFile(sessionFile(id), 'utf8'));
    const now = new Date();
    const forkedId = `sess_${now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${randomBytes(4).toString('hex')}`;
    const forked = {
      ...source,
      id: forkedId,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const messages = Array.isArray(source.messages) ? source.messages : [];
    forked.messages = [
      ...messages,
      {
        role: 'user',
        content: `[forked from ${id}] 以上是继承自原会话的历史记录，请在此基础上继续。`,
        createdAt: now.toISOString(),
      },
    ];
    // A fork is a new conversation: it must not resume the source's
    // provider-side response chain, replay its last turn, or inherit a task
    // board whose board id still belongs to the source session.
    delete forked.providerContinuation;
    delete forked.lastTurn;
    delete forked.taskRuntime;

    await fs.mkdir(sessionRootDir(), { recursive: true });
    // `wx` refuses to overwrite: a colliding id must never clobber a session.
    // The trailing newline matches what the CLI's SessionStore writes, so the
    // two writers agree byte for byte on the file format.
    await fs.writeFile(sessionFile(forkedId), `${JSON.stringify(forked, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });

    // Inherit the visible title so the copy is recognisable in the sidebar, and
    // so it never falls back to "未命名会话".
    const overlay = await readOverlay();
    const sourceTitle = overlay[id]?.title || firstUserText(source) || fallbackTitle(id, source);
    const forkedTitle = `${sourceTitle}（副本）`.slice(0, 120);
    await overlayStore.mutate((current) => {
      current[forkedId] = { ...(current[forkedId] || {}), title: forkedTitle };
    });

    return { ok: true, id: forkedId, sourceId: id, messageCount: forked.messages.length };
  }

  return {
    setRoot, getRoot, resolveInside, readFile, writeFile, tree,
    listSessions, listArchivedSessions, loadSession, deleteSession,
    renameSession, pinSession, archiveSession, sessionAbsolutePath,
    forkSession,
  };
}

module.exports = { createWorkspaceService };
