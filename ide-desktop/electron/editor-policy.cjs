const fs = require('node:fs/promises');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { kindForPath } = require('./preview-policy.cjs');

const MAX_TEXT_BYTES = 20 * 1024 * 1024;
const BINARY_EXTENSIONS = new Set(['.zip', '.7z', '.rar', '.exe', '.dll', '.bin', '.class', '.wasm', '.xlsx', '.xls', '.pptx', '.ppt', '.mp3', '.wav', '.mp4', '.mov', '.sqlite', '.db']);

function assertTextPath(target) {
  const kind = kindForPath(target);
  if ((kind !== 'text' && kind !== 'html') || BINARY_EXTENSIONS.has(path.extname(target).toLowerCase())) {
    throw new Error('此文件不是文本，已禁止在文本编辑器中读取或覆盖。请使用预览。');
  }
}

function decodeText(buffer) {
  if (buffer.length > MAX_TEXT_BYTES) throw new Error('文本文件超过 20 MB，已停止打开。');
  if (buffer.includes(0)) throw new Error('检测到二进制内容，已禁止在文本编辑器中读取或覆盖。');
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    throw new Error('文件不是有效 UTF-8 文本，已停止操作以保护原文件。');
  }
}

async function readTextFile(target) {
  assertTextPath(target);
  const info = await fs.stat(target);
  if (!info.isFile()) throw new Error('只能打开文本文件。');
  if (info.size > MAX_TEXT_BYTES) throw new Error('文本文件超过 20 MB，已停止打开。');
  return decodeText(await fs.readFile(target));
}

async function validateTextWrite(target, content) {
  assertTextPath(target);
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES || content.includes('\0')) {
    throw new Error('文本内容无效或超过 20 MB。');
  }
  try {
    await readTextFile(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

module.exports = { readTextFile, validateTextWrite, decodeText, assertTextPath };
