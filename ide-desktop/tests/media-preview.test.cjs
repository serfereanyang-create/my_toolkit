'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { getMediaPreviewFormat, prepareMediaPreview, MEDIA_PREVIEW_FORMATS } = require('../electron/media-preview.cjs');

test('format table covers audio and video with correct mimes', () => {
  assert.equal(MEDIA_PREVIEW_FORMATS.filter((f) => f.kind === 'video').length, 4);
  assert.equal(MEDIA_PREVIEW_FORMATS.filter((f) => f.kind === 'audio').length, 7);
  assert.equal(getMediaPreviewFormat('C:\\v\\clip.MP4').mediaType, 'video/mp4');
  assert.equal(getMediaPreviewFormat('/home/x/song.Flac').kind, 'audio');
  assert.equal(getMediaPreviewFormat('notes.md'), null);
  assert.equal(getMediaPreviewFormat('a.mov').mediaType, 'video/quicktime');
});

test('prepare returns a local url by default and inline base64 on demand', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-'));
  try {
    const file = path.join(dir, 'clip.mp4');
    await fs.writeFile(file, Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]));
    const local = await prepareMediaPreview({ filePath: file, expectedKind: 'video' });
    assert.equal(local.kind, 'local-url');
    assert.equal(local.mediaType, 'video/mp4');
    assert.ok(local.url.startsWith('file:///'));
    assert.ok(local.url.includes('clip.mp4'));

    const inline = await prepareMediaPreview({ filePath: file, expectedKind: 'video', supportsLocalUrl: false });
    assert.equal(inline.kind, 'inline');
    assert.equal(Buffer.from(inline.dataBase64, 'base64').length, 8);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('prepare rejects kind mismatches, missing files, and oversized payloads', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-bad-'));
  try {
    const file = path.join(dir, 'clip.mp4');
    await fs.writeFile(file, Buffer.alloc(16));
    await assert.rejects(() => prepareMediaPreview({ filePath: file, expectedKind: 'audio' }), /Unsupported media preview format/);
    await assert.rejects(() => prepareMediaPreview({ filePath: path.join(dir, 'nope.mp4'), expectedKind: 'video' }), /not a media file/);

    const big = path.join(dir, 'big.mp3');
    await fs.writeFile(big, Buffer.alloc(64));
    await assert.rejects(
      () => prepareMediaPreview({ filePath: big, expectedKind: 'audio', supportsLocalUrl: false, inlineMaxBytes: 8 }),
      /too large for inline preview/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a local url is percent-encoded, so # and spaces in a filename survive', async () => {
  const { mkdtemp, writeFile, rm } = require('node:fs/promises');
  const { tmpdir } = require('node:os');
  const path = require('node:path');
  const dir = await mkdtemp(path.join(tmpdir(), 'zcode-media-url-'));
  try {
    const file = path.join(dir, 'demo #1 take.mp4');
    await writeFile(file, Buffer.from([0, 1, 2, 3]));
    const preparation = await prepareMediaPreview({ filePath: file, expectedKind: 'video' });
    assert.equal(preparation.kind, 'local-url');
    // A hand-built `file:///` left these raw: the fragment cut the name at `#`
    // and the query swallowed the rest, so the pane rendered nothing.
    assert.ok(preparation.url.includes('%23'), 'the # must be escaped');
    assert.ok(preparation.url.includes('%20'), 'the space must be escaped');
    assert.ok(preparation.url.startsWith('file:///'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
