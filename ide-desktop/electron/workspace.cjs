const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

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
  async function readOverlay() {
    try {
      return JSON.parse(await fs.readFile(overlayFile(), 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') return {};
      return {};
    }
  }

  async function writeOverlay(overlay) {
    await fs.mkdir(sessionRootDir(), { recursive: true });
    await fs.writeFile(overlayFile(), JSON.stringify(overlay, null, 2), 'utf8');
  }

  function firstUserText(record) {
    const messages = Array.isArray(record?.messages) ? record.messages : [];
    const firstUser = messages.find((m) => m && m.role === 'user' && typeof m.content === 'string' && m.content.trim());
    const text = firstUser ? firstUser.content.trim() : '';
    return text.replace(/\s+/g, ' ').slice(0, 60);
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
          title: ov.title || firstUserText(record) || id,
          pinned: Boolean(ov.pinned),
          archived: Boolean(ov.archived),
          updatedAt: record.updatedAt || record.createdAt || '',
          messageCount: Array.isArray(record.messages) ? record.messages.length : 0,
        });
      } catch {
        // Skip corrupt session files rather than breaking the whole list.
      }
    }
    metas.sort((a, b) => Number(b.pinned) - Number(a.pinned) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    // Active list excludes archived sessions; the archived page reads them via
    // listArchivedSessions below.
    return metas.filter((m) => !m.archived).slice(0, 50);
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
          title: ov.title || firstUserText(record) || id,
          pinned: Boolean(ov.pinned),
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

  async function loadSession(id) {
    return JSON.parse(await fs.readFile(sessionFile(id), 'utf8'));
  }

  async function deleteSession(id) {
    await fs.rm(sessionFile(id), { force: true });
    const overlay = await readOverlay();
    if (overlay[id]) {
      delete overlay[id];
      await writeOverlay(overlay);
    }
    return { ok: true, id };
  }

  async function renameSession(id, title) {
    // Verify the session exists before recording a title for it.
    await fs.access(sessionFile(id));
    const overlay = await readOverlay();
    overlay[id] = { ...(overlay[id] || {}), title: String(title || '').slice(0, 120) };
    await writeOverlay(overlay);
    return { ok: true, id, title: overlay[id].title };
  }

  async function pinSession(id, pinned) {
    await fs.access(sessionFile(id));
    const overlay = await readOverlay();
    overlay[id] = { ...(overlay[id] || {}), pinned: Boolean(pinned) };
    await writeOverlay(overlay);
    return { ok: true, id, pinned: overlay[id].pinned };
  }

  async function archiveSession(id, archived) {
    await fs.access(sessionFile(id));
    const overlay = await readOverlay();
    overlay[id] = { ...(overlay[id] || {}), archived: Boolean(archived) };
    await writeOverlay(overlay);
    return { ok: true, id, archived: overlay[id].archived };
  }

  function sessionAbsolutePath(id) {
    return sessionFile(id);
  }

  return {
    setRoot, getRoot, resolveInside, readFile, writeFile, tree,
    listSessions, listArchivedSessions, loadSession, deleteSession,
    renameSession, pinSession, archiveSession, sessionAbsolutePath,
  };
}

module.exports = { createWorkspaceService };
