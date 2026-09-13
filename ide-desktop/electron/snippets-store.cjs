// Iteration 4 — reusable code snippets store (main process).
//
// Persists user-curated snippets to one JSON file under userData. Writes are
// serialized through a promise chain and go temp-file-then-rename so a crash
// mid-write can never leave a half-written store behind. Reads tolerate a
// corrupt file by keeping a `.bak` copy and reseeding.

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const STORE_VERSION = 1;

function newId() {
  return `snip-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function sanitizeSnippet(input, now) {
  const title = String(input?.title ?? '').trim().slice(0, 120);
  if (!title) throw new Error('片段标题不能为空');
  const body = String(input?.body ?? '');
  if (body.length > 64 * 1024) throw new Error('片段内容过大（上限 64 KB）');
  const language = String(input?.language ?? 'text').trim().slice(0, 30) || 'text';
  const tags = Array.isArray(input?.tags)
    ? [...new Set(input.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 12)
    : [];
  const createdAt = String(input?.createdAt ?? now);
  return {
    id: typeof input?.id === 'string' && input.id ? input.id : newId(),
    title,
    language,
    body,
    tags,
    description: String(input?.description ?? '').trim().slice(0, 400),
    usageCount: Number.isFinite(input?.usageCount) ? Math.max(0, Math.floor(input.usageCount)) : 0,
    createdAt,
    updatedAt: now,
  };
}

function createSnippetsStore(userDataDir) {
  const storePath = path.join(userDataDir, 'snippets.json');
  let chain = Promise.resolve(); // serialize all file mutations

  async function readRaw() {
    try {
      const raw = await fs.readFile(storePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.snippets)) throw new Error('bad shape');
      return parsed;
    } catch (error) {
      if (error && error.code === 'ENOENT') return { version: STORE_VERSION, snippets: [] };
      // Corrupt store: move the bad file aside once so we can keep working.
      try { await fs.rename(storePath, `${storePath}.corrupt-${Date.now()}`); } catch { /* best effort */ }
      return { version: STORE_VERSION, snippets: [] };
    }
  }

  async function writeRaw(data) {
    const tmp = `${storePath}.${process.pid}.tmp`;
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmp, storePath);
  }

  /** Run `fn` against the current store, atomically persisting the result. */
  function mutate(fn) {
    const task = chain.then(async () => {
      const data = await readRaw();
      const result = await fn(data.snippets, data);
      await writeRaw({ version: STORE_VERSION, snippets: data.snippets });
      return result;
    });
    // Keep the chain alive even when a mutation rejects.
    chain = task.catch(() => undefined);
    return task;
  }

  async function list() {
    const data = await readRaw();
    return [...data.snippets].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async function create(input) {
    const now = new Date().toISOString();
    const snippet = sanitizeSnippet({ ...input, createdAt: now }, now);
    return await mutate(async (snippets) => {
      snippets.push(snippet);
      return snippet;
    });
  }

  async function update(id, patch) {
    const now = new Date().toISOString();
    return await mutate(async (snippets) => {
      const idx = snippets.findIndex((s) => s.id === id);
      if (idx < 0) throw new Error(`片段不存在：${id}`);
      const merged = sanitizeSnippet({ ...snippets[idx], ...patch, id, createdAt: snippets[idx].createdAt }, now);
      snippets[idx] = merged;
      return merged;
    });
  }

  async function remove(id) {
    return await mutate(async (snippets) => {
      const idx = snippets.findIndex((s) => s.id === id);
      if (idx < 0) return { ok: false, id };
      snippets.splice(idx, 1);
      return { ok: true, id };
    });
  }

  /** Bump the usage counter; used for "most used first" sorting options. */
  async function touch(id) {
    return await mutate(async (snippets) => {
      const found = snippets.find((s) => s.id === id);
      if (!found) return { ok: false, id };
      found.usageCount += 1;
      return { ok: true, id, usageCount: found.usageCount };
    });
  }

  /** In-memory keyword filter (case-insensitive over title/body/tags). */
  async function search(query) {
    const q = String(query || '').trim().toLowerCase();
    const all = await list();
    if (!q) return all;
    return all.filter((s) => (
      s.title.toLowerCase().includes(q)
      || s.body.toLowerCase().includes(q)
      || s.tags.some((t) => t.includes(q))
      || s.language.toLowerCase().includes(q)
    ));
  }

  /** Replace the whole collection (import path); validates every entry. */
  async function replaceAll(inputs) {
    if (!Array.isArray(inputs)) throw new Error('导入数据必须是数组');
    const now = new Date().toISOString();
    const cleaned = inputs.map((input) => sanitizeSnippet(input, now));
    await mutate(async (snippets) => {
      snippets.length = 0;
      snippets.push(...cleaned);
    });
    return cleaned;
  }

  async function exportAll() {
    const data = await readRaw();
    return JSON.stringify(data.snippets, null, 2);
  }

  return { list, create, update, remove, touch, search, replaceAll, exportAll, storePath };
}

module.exports = { createSnippetsStore, sanitizeSnippet };
