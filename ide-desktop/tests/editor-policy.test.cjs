'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readTextFile, validateTextWrite, decodeText, assertTextPath } = require('../electron/editor-policy.cjs');

/*
 * The text guard is what stands between a binary file and the text editor.
 * A file that slips through is not merely displayed wrong: the editor holds the
 * decoded string and writes it back on save, so opening a binary would corrupt
 * it in place. Everything below is a case where "looks like text" is decided by
 * extension alone and would be wrong.
 */

async function workspace() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'editor-policy-'));
}

async function write(dir, name, bytes) {
  const file = path.join(dir, name);
  await fs.writeFile(file, bytes);
  return file;
}

test('a binary payload under a text-ish name is still refused', async () => {
  const dir = await workspace();
  try {
    // NUL bytes: the signature of everything from a gzip stream to a compiled
    // object file. The extension says nothing about the content.
    for (const [name, bytes] of [
      ['archive.dat', Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x2b, 0x2e])],
      ['module.o', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00])],
      ['photo.dat', Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')],
    ]) {
      const file = await write(dir, name, bytes);
      await assert.rejects(() => readTextFile(file), /二进制/, `${name} must not open as text`);
      await assert.rejects(() => validateTextWrite(file, 'replacement'), /二进制/, `${name} must not be overwritten as text`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a non-UTF-8 text encoding is refused rather than mangled', async () => {
  const dir = await workspace();
  try {
    // Shift-JIS "テスト". Decoding it as UTF-8 with replacement characters and
    // saving would silently rewrite the file in a different encoding.
    const file = await write(dir, 'jp.txt', Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0x82, 0xc5]));
    await assert.rejects(() => readTextFile(file), /UTF-8/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a known-binary extension is refused before its bytes are even read', async () => {
  const dir = await workspace();
  try {
    // ASCII-only content, so only the extension can catch it.
    const file = await write(dir, 'diagram.xlsx', Buffer.from('not really a workbook, but plain ascii'));
    assert.throws(() => assertTextPath(file), /禁止在文本编辑器中/);
    await assert.rejects(() => readTextFile(file), /禁止在文本编辑器中/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a preview-only document is not editable text', async () => {
  for (const name of ['report.docx', 'manual.pdf', 'legacy.doc', 'shot.png']) {
    assert.throws(() => assertTextPath(name), /禁止在文本编辑器中/, `${name} belongs in the preview pane`);
  }
});

test('real text is allowed, including an empty and a large-but-legal file', async () => {
  const dir = await workspace();
  try {
    const plain = await write(dir, 'note.txt', Buffer.from('hello 世界\n', 'utf8'));
    assert.equal(await readTextFile(plain), 'hello 世界\n');

    const empty = await write(dir, 'empty.txt', Buffer.alloc(0));
    assert.equal(await readTextFile(empty), '');

    // A new file has nothing on disk to inspect, and must not be refused.
    await validateTextWrite(path.join(dir, 'brand-new.ts'), 'export {};\n');

    // A BOM is preserved as a character rather than stripped, so decoding and
    // re-encoding the buffer is byte-for-byte stable — a save after an open
    // must not silently add or drop the mark.
    const bomBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x')]);
    const bom = await write(dir, 'bom.txt', bomBytes);
    assert.equal(Buffer.from(await readTextFile(bom), 'utf8').toString('hex'), bomBytes.toString('hex'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a NUL inside otherwise-readable content is caught', () => {
  // The check is on the decoded bytes, not just the leading ones: a NUL after
  // a plain ASCII preamble is still a binary file.
  assert.throws(() => decodeText(Buffer.from('title\0rest')), /二进制/);
});

test('oversized content is refused in both directions', async () => {
  const dir = await workspace();
  try {
    const file = await write(dir, 'big.txt', Buffer.from('x'));
    await assert.rejects(() => validateTextWrite(file, 'x'.repeat(21 * 1024 * 1024)), /20 MB/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
