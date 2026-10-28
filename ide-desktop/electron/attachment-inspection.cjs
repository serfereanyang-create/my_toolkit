'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');

async function inspectAttachments(paths, { stat = fs.stat, access = fs.access } = {}) {
  if (!Array.isArray(paths) || paths.length > 100 || paths.some(source => typeof source !== 'string' || source.length > 32768 || !path.isAbsolute(source) || source.includes('\0'))) {
    throw new Error('附件检查需要有效的绝对文件路径，单次最多 100 个。');
  }
  return Promise.all(paths.map(async source => {
    try {
      const info = await stat(source);
      if (!info.isFile()) return { path: source, ok: false, error: '附件路径不是普通文件，请重新选择。' };
      if (!Number.isSafeInteger(info.size) || info.size < 0) return { path: source, ok: false, error: '无法读取附件大小，请重新选择。' };
      if (info.size > 50 * 1024 * 1024) return { path: source, ok: false, size: info.size, error: '附件已超过 50MB 大小限制，请移除或更换。' };
      await access(source, constants.R_OK);
      return { path: source, ok: true, size: info.size, mtimeMs: info.mtimeMs };
    } catch (error) {
      const message = error.code === 'ENOENT' || error.code === 'ENOTDIR'
        ? '原文件已移动或删除，请恢复文件或重新选择。'
        : error.code === 'EACCES' || error.code === 'EPERM'
          ? '没有读取附件的权限，请检查文件权限。'
          : '暂时无法读取附件，请稍后重试。';
      return { path: source, ok: false, error: message };
    }
  }));
}

module.exports = { inspectAttachments };
