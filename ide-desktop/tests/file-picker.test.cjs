'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeFilePickerOptions, pickWorkspaceFile } = require('../electron/file-picker.cjs');

test('file picker options are bounded and normalized before reaching Electron', () => {
  const result = normalizeFilePickerOptions({
    title: `  ${'title'.repeat(60)}  `,
    filters: [
      { name: '文档', extensions: ['.PDF', ' xlsx ', 'bad/name', 1, ''] },
      null,
      { name: '', extensions: ['md'] },
    ],
  });
  assert.equal(result.title.length, 120);
  assert.deepEqual(result.filters, [
    { name: '文档', extensions: ['pdf', 'xlsx'] },
    { name: '文件', extensions: ['md'] },
  ]);
});

test('file picker ignores caller supplied default paths and constrains the native dialog', async () => {
  const calls = [];
  const picked = await pickWorkspaceFile({
    root: 'C:/workspace',
    options: { title: '打开文档', defaultPath: 'C:/outside', filters: [{ name: 'PDF', extensions: ['.pdf'] }] },
    owner: 'window',
    dialog: { showOpenDialog: async (owner, options) => { calls.push({ owner, options }); return { canceled: false, filePaths: ['C:/workspace/readme.pdf'] }; } },
    stat: async () => ({ isFile: () => true, size: 1234 }),
  });
  assert.deepEqual(picked, { ok: true, path: 'C:/workspace/readme.pdf', size: 1234 });
  assert.equal(calls[0].owner, 'window');
  assert.deepEqual(calls[0].options, {
    title: '打开文档',
    properties: ['openFile'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    defaultPath: 'C:/workspace',
  });
});

test('cancel, missing files, and directories remain explicit outcomes', async () => {
  const options = { root: 'C:/workspace', owner: null, options: {}, stat: async () => ({ isFile: () => false }) };
  const cancelled = await pickWorkspaceFile({ ...options, dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) } });
  assert.deepEqual(cancelled, { ok: false, canceled: true });

  const missing = await pickWorkspaceFile({ ...options, dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['C:/workspace/missing'] }) }, stat: async () => { throw new Error('ENOENT'); } });
  assert.deepEqual(missing, { ok: false, error: '无法读取所选文件' });

  const directory = await pickWorkspaceFile({ ...options, dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['C:/workspace/folder'] }) } });
  assert.deepEqual(directory, { ok: false, error: '无法读取所选文件' });
});

test('selected files return real byte counts including zero and files outside the workspace', async () => {
  for (const size of [0, 69, 50 * 1024 * 1024 + 1]) {
    const result = await pickWorkspaceFile({
      root: 'C:/workspace', owner: null, options: {},
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['D:/selected/image.png'] }) },
      stat: async () => ({ isFile: () => true, size }),
    });
    assert.deepEqual(result, { ok: true, path: 'D:/selected/image.png', size });
  }
});

test('invalid file metadata is reported instead of silently becoming a zero-byte file', async () => {
  for (const size of [undefined, null, '69', NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const result = await pickWorkspaceFile({
      root: 'C:/workspace', owner: null, options: {},
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['C:/workspace/file.txt'] }) },
      stat: async () => ({ isFile: () => true, size }),
    });
    assert.deepEqual(result, { ok: false, error: '无法读取所选文件大小' });
  }
});
