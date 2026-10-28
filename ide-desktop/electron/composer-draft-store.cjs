'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { rootKey } = require('./message-queue-store.cjs');
const { assertInsideRoot } = require('./preview-policy.cjs');
const { atomicWriteText } = require('./atomic-file.cjs');
const MAX_BYTES = 32 * 1024 * 1024;
const CATEGORIES = new Set(['image', 'document', 'code', 'data', 'archive', 'unknown']);

function boundedText(value, limit, field) {
  if (typeof value !== 'string' || value.length > limit) throw new Error(`草稿的${field}格式无效，原文件保持不变。`);
  return value;
}

function normalizeDrafts(value) {
  if (!Array.isArray(value) || value.length > 1000) throw new Error('草稿列表格式或数量无效，原文件保持不变。');
  const ids = new Set();
  return value.map(entry => {
    if (!entry || typeof entry !== 'object') throw new Error('草稿条目无效。');
    const sessionId = entry.sessionId === null ? null : boundedText(entry.sessionId, 512, '会话编号');
    if (ids.has(sessionId)) throw new Error('草稿包含重复会话编号。');
    ids.add(sessionId);
    const text = boundedText(entry.text, 1_000_000, '正文');
    if (!Array.isArray(entry.files) || entry.files.length > 100 || !Array.isArray(entry.mentions) || entry.mentions.length > 100) {
      throw new Error('草稿附件或引用格式无效。');
    }
    const files = entry.files.map(file => {
      if (!file || !Number.isSafeInteger(file.size) || file.size < 0 || !CATEGORIES.has(file.category)) throw new Error('草稿附件元数据无效。');
      return {
        path: boundedText(file.path, 32768, '附件路径'),
        name: boundedText(file.name, 1024, '附件名称'),
        size: file.size,
        category: file.category,
        icon: boundedText(file.icon, 128, '附件图标'),
        ...(file.mediaType === undefined ? {} : { mediaType: boundedText(file.mediaType, 256, '附件类型') }),
      };
    });
    const mentions = entry.mentions.map(mention => {
      if (!mention || !['file', 'url', 'terminal'].includes(mention.type)) throw new Error('草稿引用类型无效。');
      return {
        id: boundedText(mention.id, 32768, '引用编号'),
        label: boundedText(mention.label, 2048, '引用名称'),
        type: mention.type,
        ...(mention.path === undefined ? {} : { path: boundedText(mention.path, 32768, '引用路径') }),
        ...(mention.content === undefined ? {} : { content: boundedText(mention.content, 1_000_000, '引用内容').slice(-6000) }),
      };
    });
    return { sessionId, text, files, mentions, ...(entry.recoverySource === undefined ? {} : { recoverySource: boundedText(entry.recoverySource, 32768, '恢复来源') }) };
  });
}

class ComposerDraftStore {
  constructor(directory) {
    this.directory = path.resolve(directory);
    this.writes = new Map();
  }

  async file(root) {
    const key = rootKey(root);
    const owner = await fs.realpath(path.dirname(this.directory));
    await fs.mkdir(this.directory, { recursive: true });
    const directory = await fs.realpath(this.directory);
    assertInsideRoot(directory, owner, { rejectBlocked: false });
    return path.join(directory, `${createHash('sha256').update(key).digest('hex')}.json`);
  }

  async readSnapshot(root) {
    const file = await this.file(root);
    try {
      const actual = await fs.realpath(file);
      assertInsideRoot(actual, await fs.realpath(this.directory), { rejectBlocked: false });
      if ((await fs.stat(actual)).size > MAX_BYTES) throw new Error('草稿超过 32 MB，原文件保持不变。');
      const stored = JSON.parse(await fs.readFile(actual, 'utf8'));
      if (stored.version !== 1 || stored.root !== rootKey(root)) throw new Error('草稿归属或版本无效，原文件保持不变。');
      return normalizeDrafts(stored.drafts);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async load(root) {
    await this.writes.get(rootKey(root))?.catch(() => undefined);
    return this.readSnapshot(root);
  }

  save(root, drafts) {
    const key = rootKey(root);
    const normalized = normalizeDrafts(drafts);
    const text = JSON.stringify({ version: 1, root: key, drafts: normalized }, null, 2);
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('草稿超过 32 MB，原文件保持不变。');
    const previous = this.writes.get(key) ?? Promise.resolve();
    const saving = previous.catch(() => undefined).then(async () => {
      await this.readSnapshot(root);
      await atomicWriteText(await this.file(root), text);
    }).finally(() => { if (this.writes.get(key) === saving) this.writes.delete(key); });
    this.writes.set(key, saving);
    return saving;
  }

  async flush() {
    while (this.writes.size) await Promise.allSettled([...this.writes.values()]);
  }
}

module.exports = { ComposerDraftStore, normalizeDrafts };
