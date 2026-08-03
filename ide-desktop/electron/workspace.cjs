const fs = require('node:fs/promises');
const path = require('node:path');

function createWorkspaceService() {
  let root = '';

  function setRoot(nextRoot) {
    root = path.resolve(nextRoot);
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

  async function listSessions() {
    const sessionRoot = resolveInside('.aicode/sessions');
    try {
      const entries = await fs.readdir(sessionRoot);
      return entries.filter((name) => name.endsWith('.json')).sort().reverse().slice(0, 30);
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw error;
    }
  }

  return { setRoot, getRoot, resolveInside, readFile, writeFile, tree, listSessions };
}

module.exports = { createWorkspaceService };
