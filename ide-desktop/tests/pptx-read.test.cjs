const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { parsePptx } = require('../electron/pptx-read.cjs');

/*
 * Reading .pptx for the preview pane.
 *
 * Two real decks are used as fixtures rather than hand-written XML, because the
 * two writers disagree about the parts that are easy to get wrong:
 *
 *   - `cli-created.pptx` is what the CLI's own create_pptx emits: title/ctrTitle
 *     and subTitle placeholders, no notes, no tables.
 *   - `powerpoint-authored.pptx` was written by python-pptx (the same OOXML
 *     PowerPoint produces): body paragraphs at nested levels, a real table, and
 *     speaker notes on the SECOND slide — which is exactly the case that a
 *     filename-based notes lookup gets wrong.
 */

const fixture = (name) => readFileSync(path.join(__dirname, 'fixtures', name));

test('reads a deck the CLI wrote', () => {
  const result = parsePptx(fixture('cli-created.pptx'));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.slides.length, 2, 'title slide + content slide');
  assert.equal(result.slides[0].title, '2024 Q1 业务汇报');
  assert.equal(result.slides[0].shapes.find((s) => s.type === 'subTitle').paragraphs[0].text, '技术部');
  assert.equal(result.slides[1].title, '核心指标');
});

test('slide order comes from the presentation, not the part filenames', () => {
  // Both fixtures happen to be in order; the guard is that the order is taken
  // from p:sldIdLst at all. A deck reordered in PowerPoint keeps its slideN.xml
  // names, so a reader that sorted by filename would scramble it.
  const result = parsePptx(fixture('powerpoint-authored.pptx'));
  assert.deepEqual(result.slides.map((s) => s.title), [
    'Quarterly Review',
    'Metrics & Growth',
    'Regional Split',
  ]);
});

test('paragraph levels are kept, so nested bullets can be indented', () => {
  const result = parsePptx(fixture('powerpoint-authored.pptx'));
  const body = result.slides[1].shapes.find((s) => s.type !== 'title');
  assert.deepEqual(body.paragraphs.map((p) => p.text), ['Revenue up 15%', 'Churn down', 'NPS 62']);
  assert.deepEqual(body.paragraphs.map((p) => p.level), [0, 1, 1]);
});

test("a slide's notes are found through its own relationships", () => {
  // The notes are on slide 2, and PowerPoint named the part `notesSlide1.xml`
  // because that slide's notes were created first. Deriving the notes filename
  // from the slide number reads a file that does not belong to this slide.
  const result = parsePptx(fixture('powerpoint-authored.pptx'));
  assert.equal(result.slides[0].notes, '', 'the title slide has no notes');
  assert.equal(result.slides[1].notes, 'Mention the churn work shipped late.');
  assert.equal(result.slides[2].notes, '');
});

test('a table is read as a grid and its cells are not also emitted as body text', () => {
  const result = parsePptx(fixture('powerpoint-authored.pptx'));
  const table = result.slides[2].shapes.find((s) => s.kind === 'table');
  assert.deepEqual(table.table, [
    ['Region', 'Revenue'],
    ['华东', '1.2M'],
    ['华南', '0.8M'],
  ]);
  // The cells are text bodies; if the paragraph scan ran too, every cell would
  // render twice.
  assert.deepEqual(table.paragraphs, [], 'cells must not be duplicated as paragraphs');
});

test('a corrupt or non-pptx buffer is reported, not thrown', () => {
  const result = parsePptx(Buffer.from('this is not a presentation', 'utf8'));
  assert.equal(result.ok, false);
  assert.match(result.error, /zip|Office/i);

  // A zip that is not a presentation: no slides anywhere.
  const { deflateRawSync, crc32 } = require('node:zlib');
  const raw = Buffer.from('hello', 'utf8');
  const deflated = deflateRawSync(raw);
  const name = Buffer.from('readme.txt', 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(raw) >>> 0, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(8, 10);
  entry.writeUInt32LE(crc32(raw) >>> 0, 16);
  entry.writeUInt32LE(deflated.length, 20);
  entry.writeUInt32LE(raw.length, 24);
  entry.writeUInt16LE(name.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(entry.length + name.length, 12);
  eocd.writeUInt32LE(local.length + name.length + deflated.length, 16);
  const zip = Buffer.concat([local, name, deflated, entry, name, eocd]);

  const empty = parsePptx(zip);
  assert.equal(empty.ok, false);
  assert.match(empty.error, /幻灯片/);
});
