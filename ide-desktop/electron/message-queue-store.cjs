'use strict';
const fs = require('node:fs/promises');
const { renameWithRetry } = require('./atomic-file.cjs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { assertInsideRoot } = require('./preview-policy.cjs');
const MAX_BYTES = 32 * 1024 * 1024;

function rootKey(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('需要绝对工作区路径。');
  const normalized = path.resolve(root);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function snapshot(value) {
  if (!value || !Array.isArray(value.messages) || !Array.isArray(value.pausedSessions)) throw new Error('消息队列数据格式无效。');
  const ids = new Set();
  const messages = value.messages.map(message => {
    if (!message || typeof message.id !== 'string' || !message.id || typeof message.sessionId !== 'string' || typeof message.text !== 'string' || !Number.isFinite(message.createdAt)) throw new Error('消息队列包含无效条目，原文件保持不变。');
    if (ids.has(message.id)) throw new Error('消息队列包含重复编号。');
    ids.add(message.id);
    if (message.files !== undefined && !Array.isArray(message.files)) throw new Error('队列附件信息无效。');
    const files = message.files === undefined ? undefined : message.files.map(file => {
      if (!file || typeof file.path !== 'string' || !file.path || typeof file.name !== 'string' || !Number.isFinite(file.size) || file.size < 0) throw new Error('队列附件信息无效。');
      return { path: file.path, name: file.name, size: file.size };
    });
    return { id: message.id, sessionId: message.sessionId, text: message.text, createdAt: message.createdAt, ...(files?.length ? { files } : {}) };
  });
  if (!value.pausedSessions.every(sessionId => typeof sessionId === 'string')) throw new Error('队列暂停状态无效。');
  return { messages, pausedSessions: [...new Set(value.pausedSessions)] };
}

class MessageQueueStore {
  constructor(directory) { this.directory = path.resolve(directory); this.writes = new Map(); }

  async file(root) {
    const owner = await fs.realpath(path.dirname(this.directory));
    await fs.mkdir(this.directory, { recursive: true });
    const directory = await fs.realpath(this.directory);
    assertInsideRoot(directory, owner, { rejectBlocked: false });
    return path.join(directory, `${createHash('sha256').update(rootKey(root)).digest('hex')}.json`);
  }

  async load(root) {
    const key = rootKey(root);
    await this.writes.get(key)?.catch(() => undefined);
    const data = await this.readSnapshot(root);
    return { ...data, pausedSessions: [...new Set([...data.pausedSessions, ...data.messages.map(message => message.sessionId)])] };
  }

  async readSnapshot(root) {
    const key = rootKey(root);
    const file = await this.file(root);
    try {
      const actual = await fs.realpath(file);
      assertInsideRoot(actual, await fs.realpath(this.directory), { rejectBlocked: false });
      const stat = await fs.stat(actual);
      if (stat.size > MAX_BYTES) throw new Error('消息队列超过 32 MB，未读取或覆盖原文件。');
      const stored = JSON.parse(await fs.readFile(actual, 'utf8'));
      if (stored.version !== 1 || stored.root !== key) throw new Error('消息队列归属或版本无效，原文件保持不变。');
      return snapshot(stored);
    } catch (error) {
      if (error.code === 'ENOENT') return { messages: [], pausedSessions: [] };
      throw error;
    }
  }

  save(root, value) {
    const key = rootKey(root);
    const normalized = snapshot(value);
    const text = JSON.stringify({ version: 1, root: key, ...normalized }, null, 2);
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('消息队列超过 32 MB，未覆盖原文件。');
    return this.enqueue(key, () => this.writeSnapshot(root, text));
  }

  restore(root, messages) {
    const key = rootKey(root);
    const recovered = snapshot({ messages, pausedSessions: [] }).messages;
    return this.enqueue(key, async () => {
      const current = await this.readSnapshot(root);
      const existing = new Set(current.messages.map(message => message.id));
      const merged = {
        messages: [...recovered.filter(message => !existing.has(message.id)), ...current.messages],
        pausedSessions: [...new Set([...current.pausedSessions, ...recovered.map(message => message.sessionId)])],
      };
      const text = JSON.stringify({ version: 1, root: key, ...merged }, null, 2);
      if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('消息队列超过 32 MB，未覆盖原文件。');
      await this.writeSnapshot(root, text);
      return merged;
    });
  }

  async writeSnapshot(root, text) {
    const file = await this.file(root);
    const temporary = path.join(path.dirname(file), `${path.basename(file)}.${randomUUID()}.tmp`);
    await fs.writeFile(temporary, text, { flag: 'wx' });
    try { await renameWithRetry(temporary, file); }
    catch (error) { await fs.unlink(temporary).catch(() => undefined); throw error; }
  }

  enqueue(key, action) {
    const previous = this.writes.get(key) ?? Promise.resolve();
    const saving = previous.catch(() => undefined).then(action).finally(() => { if (this.writes.get(key) === saving) this.writes.delete(key); });
    this.writes.set(key, saving);
    return saving;
  }

  async flush() { while (this.writes.size) await Promise.allSettled([...this.writes.values()]); }
}

module.exports = { MessageQueueStore, rootKey };
