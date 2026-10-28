'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { inspectAttachments } = require('../electron/attachment-inspection.cjs');

test('attachment inspection reads actual byte counts, missing files and directories without reading content', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'yoy-attachment-inspection-'));
  try {
    const file = path.join(base, '附件.txt');
    const missing = path.join(base, 'missing.txt');
    await fs.writeFile(file, 'actual bytes');
    const results = await inspectAttachments([file, missing, base]);
    assert.equal(results[0].ok, true);
    assert.equal(results[0].size, Buffer.byteLength('actual bytes'));
    assert.equal(typeof results[0].mtimeMs, 'number');
    assert.match(results[1].error, /移动或删除/);
    assert.match(results[2].error, /不是普通文件/);
  } finally {
    const absolute = path.resolve(base);
    const relative = path.relative(path.resolve(os.tmpdir()), absolute);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(absolute, { recursive: true, force: true });
  }
});

test('inspection rejects malformed and excessive path lists before touching the filesystem', async () => {
  let calls = 0;
  const options = { stat: async () => { calls += 1; } };
  for (const input of [null, {}, ['relative.txt'], [1], Array(101).fill(path.resolve('file.txt')), [path.resolve('file.txt') + '\0']]) {
    await assert.rejects(inspectAttachments(input, options), /绝对文件路径/);
  }
  assert.equal(calls, 0);
});

test('permissions, invalid metadata and a file that grew past the limit return actionable failures', async () => {
  const source = path.resolve('file.txt');
  const fileStat = size => ({ isFile: () => true, size, mtimeMs: 123 });
  const denied = await inspectAttachments([source], {
    stat: async () => fileStat(1), access: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
  });
  assert.match(denied[0].error, /权限/);
  const large = await inspectAttachments([source], { stat: async () => fileStat(50 * 1024 * 1024 + 1) });
  assert.equal(large[0].size, 52428801);
  assert.match(large[0].error, /50MB/);
  for (const size of [NaN, -1, Infinity, 0.5]) {
    const invalid = await inspectAttachments([source], { stat: async () => fileStat(size) });
    assert.match(invalid[0].error, /大小/);
  }
  const empty = await inspectAttachments([source], { stat: async () => fileStat(0), access: async () => {} });
  assert.equal(empty[0].ok, true);
  assert.equal(empty[0].size, 0);
});
