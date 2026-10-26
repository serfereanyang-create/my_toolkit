import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { harvestFilePaths, isImagePath, prepareUserContent, registerAttachment } from '../src/cli/attachments.js';
import { foldTextByLines } from '../src/cli/input.js';
import { assertUserTextWithinLimit, MAX_USER_TEXT_BYTES_HARD, utf8ByteLength } from '../src/cli/limits.js';
import { toAnthropicAwareMessages, toToolAwareMessages } from '../src/providers/protocol.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';

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
    assert.match(prepared.text, /\[user provided files\]/);
    assert.doesNotMatch(prepared.text, /use read_file|list_files|search_text/);
    assert.match(prepared.text, /image pic\.png/);
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

test('image and config parsing tools handle common file formats', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aicode-image-tools-'));
  try {
    const imagePath = join(root, 'sample.png');
    const width = 4;
    const height = 4;
    const rgba = Buffer.from([
      255, 255, 255, 0,   255, 255, 255, 0,   255, 255, 255, 0,   255, 255, 255, 0,
      255, 255, 255, 0,   255,   0,   0, 255, 255,   0,   0, 255, 255, 255, 255, 0,
      255, 255, 255, 0,   255,   0,   0, 255, 255,   0,   0, 255, 255, 255, 255, 0,
      255, 255, 255, 0,   255, 255, 255, 0,   255, 255, 255, 0,   255, 255, 255, 0,
    ]);
    await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toFile(imagePath);
    await writeFile(join(root, 'sample.xml'), '<feed><item id="a">Hello</item><item id="b">World</item></feed>');
    await writeFile(join(root, 'sample.ini'), '[server]\nport=8080\nhost=localhost\n');
    await writeFile(join(root, 'sample.properties'), 'spring.datasource.url=jdbc:test\napp.name=demo\n');
    await writeFile(join(root, 'sample.toml'), '[tool.demo]\nname = "demo"\ncount = 3\n');
    await writeFile(join(root, 'sample.rtf'), '{\\rtf1\\ansi Hello\\par World}');
    await writeFile(join(root, 'sample.txt'), 'alpha\nbeta\ngamma\n', 'utf8');
    await writeFile(join(root, 'sample-large.txt'), Array.from({ length: 1200 }, (_v, i) => `line-${i} ${'x'.repeat(24)}`).join('\n'), 'utf8');
    await writeFile(join(root, 'sample.pdf'), '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\nBT\n/F1 12 Tf\n72 720 Td\n(Hello PDF text) Tj\nET\n', 'utf8');

    const tools = createDefaultToolRegistry();
    const runTool = (name: string, input: unknown) => tools.execute(name, input, { workspaceRoot: root, approval: 'deny' });

    const prepared = await prepareUserContent({
      text: 'please inspect attached materials',
      workspaceRoot: root,
      sessionId: 'sess_context_preview',
      extraPaths: [join(root, 'sample.txt'), join(root, 'sample-large.txt'), join(root, 'sample.pdf')],
    });
    assert.match(prepared.text, /file sample\.txt|document sample\.txt/);
    assert.match(prepared.text, /alpha/);
    assert.match(prepared.text, /document sample\.pdf/);
    assert.match(prepared.text, /Hello PDF text|PDF attached as source material/);
    assert.match(prepared.text, /\.\.\.\(truncated\)/);
    assert.ok(prepared.text.length < 7000);

    const dominant = await runTool('image_dominant_colors', { path: imagePath, maxColors: 3 });
    assert.equal(dominant.ok, true);
    assert.match(dominant.output, /#ff0000/i);

    const transparency = await runTool('image_transparency', { path: imagePath });
    assert.equal(transparency.ok, true);
    assert.match(transparency.output, /Transparent:/);

    const bounds = await runTool('image_content_bounds', { path: imagePath, background: 'white', threshold: 8 });
    assert.equal(bounds.ok, true);
    assert.match(bounds.output, /Size: 2 × 2/);

    const xmlSummary = await runTool('xml_summary', { path: join(root, 'sample.xml') });
    assert.equal(xmlSummary.ok, true);
    assert.match(xmlSummary.output, /Root: feed/);

    const xmlQuery = await runTool('xml_query', { path: join(root, 'sample.xml'), tag: 'item' });
    assert.equal(xmlQuery.ok, true);
    assert.match(xmlQuery.output, /Hello/);

    const ini = await runTool('ini_parse', { path: join(root, 'sample.ini'), query: 'server.port' });
    assert.equal(ini.ok, true);
    assert.match(ini.output, /8080/);

    const props = await runTool('properties_parse', { path: join(root, 'sample.properties'), query: 'app.name' });
    assert.equal(props.ok, true);
    assert.match(props.output, /demo/);

    const toml = await runTool('toml_parse', { path: join(root, 'sample.toml'), query: 'tool.demo.name' });
    assert.equal(toml.ok, true);
    assert.match(toml.output, /demo/);

    const rtf = await runTool('rtf_to_text', { path: join(root, 'sample.rtf') });
    assert.equal(rtf.ok, true);
    assert.match(rtf.output, /Hello/);
    assert.match(rtf.output, /World/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
