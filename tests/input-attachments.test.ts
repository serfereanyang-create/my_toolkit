import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { harvestFilePaths, isImagePath, prepareUserContent, registerAttachment } from '../src/cli/attachments.js';
import { foldTextByLines } from '../src/cli/input.js';
import { assertUserTextWithinLimit, MAX_USER_TEXT_BYTES_HARD, utf8ByteLength } from '../src/cli/limits.js';
import { toAnthropicAwareMessages, toToolAwareMessages } from '../src/providers/protocol.js';

test('25KB text limit rejects oversized pure text', () => {
  const ok = 'x'.repeat(1000);
  assert.equal(assertUserTextWithinLimit(ok), utf8ByteLength(ok));
  const huge = 'y'.repeat(MAX_USER_TEXT_BYTES_HARD + 10);
  assert.throws(() => assertUserTextWithinLimit(huge), /25KB hard limit/);
});

test('foldTextByLines does not column-reflow long lines', () => {
  const long = `line1\n${'a'.repeat(500)}\nline3\nline4`;
  const folded = foldTextByLines(long, 2);
  assert.equal(folded.collapsed, true);
  assert.ok(folded.display.includes('a'.repeat(500)));
  assert.match(folded.display, /more line/);
  assert.ok(!folded.display.includes('\n' + 'a'.repeat(40) + '\n' + 'a'.repeat(40)));
});

test('harvestFilePaths finds quoted windows paths', () => {
  const text = 'see "C:\\\\Users\\\\me\\\\Desktop\\\\shot.png" and other';
  // single backslashes as user would paste
  const text2 = 'see "C:\\Users\\me\\Desktop\\shot.png" please';
  const paths = harvestFilePaths(text2);
  assert.ok(paths.some((p) => p.toLowerCase().includes('shot.png')));
});

test('registerAttachment and prepareUserContent classify images', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aicode-attach-'));
  try {
    const img = join(root, 'pic.png');
    // minimal PNG header bytes
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
      0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
      0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
      0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    await writeFile(img, png);
    assert.equal(isImagePath(img), true);
    const att = await registerAttachment({ workspaceRoot: root, sessionId: 'sess_test', sourcePath: img });
    assert.equal(att.kind, 'image');
    const prepared = await prepareUserContent({
      text: `look at "${img}"`,
      workspaceRoot: root,
      sessionId: 'sess_test2',
    });
    assert.ok(prepared.parts.some((p) => p.type === 'image'));
    assert.ok(prepared.parts.some((p) => p.type === 'text'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('toToolAwareMessages emits OpenAI image_url parts', () => {
  const messages = toToolAwareMessages([
    {
      role: 'user',
      content: 'see image',
      createdAt: new Date().toISOString(),
      parts: [
        { type: 'text', text: 'see image' },
        { type: 'image', mediaType: 'image/png', data: 'aaa' },
      ],
    },
  ]);
  const content = messages[0]?.content;
  assert.ok(Array.isArray(content));
  assert.ok((content as Array<{ type: string }>).some((part) => part.type === 'image_url'));
});

test('toAnthropicAwareMessages emits base64 image blocks', () => {
  const messages = toAnthropicAwareMessages([
    {
      role: 'user',
      content: 'see image',
      createdAt: new Date().toISOString(),
      parts: [
        { type: 'text', text: 'see image' },
        { type: 'image', mediaType: 'image/png', data: 'bbb' },
      ],
    },
  ]);
  const content = messages[0]?.content;
  assert.ok(Array.isArray(content));
  assert.ok((content as Array<{ type: string }>).some((part) => part.type === 'image'));
});
