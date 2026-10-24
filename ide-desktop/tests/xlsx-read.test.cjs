const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { deflateRawSync, crc32 } = require('node:zlib');
const { parseXlsx } = require('../electron/xlsx-read.cjs');

/*
 * Reading .xlsx for the preview pane.
 *
 * The desktop has no spreadsheet library and this should not add one, so the
 * workbook is unzipped and parsed here. The two writers that matter produce
 * genuinely different XML, and both are covered below:
 *
 *   - the CLI's own create_xlsx: text is `t="inlineStr"`, and a formula cell is
 *     `<f>...</f>` with NO cached `<v>`.
 *   - Excel: text is `t="s"` indexing sharedStrings.xml, and a formula caches
 *     its last computed value in `<v>`.
 *
 * A fixture that only covered one of them would pass while the other showed an
 * empty grid.
 */

// ── minimal zip writer, so the test exercises the real unzip path ────────────
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(content, 'utf8');
    const deflated = deflateRawSync(raw);
    const crc = crc32(raw) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt16LE(0, 10);          // time
    local.writeUInt16LE(0, 12);          // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);          // extra length
    locals.push(local, nameBuf, deflated);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);          // version made by
    entry.writeUInt16LE(20, 6);          // version needed
    entry.writeUInt16LE(0, 8);           // flags
    entry.writeUInt16LE(8, 10);          // deflate
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(deflated.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt16LE(0, 30);          // extra
    entry.writeUInt16LE(0, 32);          // comment
    entry.writeUInt16LE(0, 34);          // disk
    entry.writeUInt16LE(0, 36);          // internal attrs
    entry.writeUInt32LE(0, 38);          // external attrs
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);

    offset += local.length + nameBuf.length + deflated.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

const WORKBOOK_XML = `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="收入明细" sheetId="1" r:id="rId1"/><sheet name="汇总" sheetId="2" r:id="rId2"/></sheets></workbook>`;
const RELS_XML = `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`;

test('parses a workbook the CLI wrote (inlineStr, formulas with no cached value)', () => {
  // Exactly the shape create_xlsx emits: inlineStr text, `<c t="n">` numbers,
  // and a formula cell with no <v>.
  const sheet1 = `<?xml version="1.0"?><worksheet><sheetData>` +
    `<row r="1"><c r="A1" t="inlineStr"><is><t>月份</t></is></c><c r="B1" t="inlineStr"><is><t>收入</t></is></c></row>` +
    `<row r="2"><c r="A2" t="inlineStr"><is><t>1月</t></is></c><c r="B2" t="n"><v>10000</v></c><c r="C2" s="0"><f>B2*0.1</f></c></row>` +
    `</sheetData></worksheet>`;
  const buffer = zip({
    '[Content_Types].xml': '<Types/>',
    'xl/workbook.xml': WORKBOOK_XML,
    'xl/_rels/workbook.xml.rels': RELS_XML,
    'xl/worksheets/sheet1.xml': sheet1,
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData/></worksheet>',
  });

  const result = parseXlsx(buffer);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.sheets.length, 2);
  assert.equal(result.sheets[0].name, '收入明细', 'sheet names come from workbook.xml, not the part filename');
  assert.equal(result.sheets[1].name, '汇总');

  const rows = result.sheets[0].rows;
  assert.equal(rows[0][0].text, '月份');
  assert.equal(rows[0][1].text, '收入');
  assert.equal(rows[1][0].text, '1月');
  assert.equal(rows[1][1].text, '10000');
  // The formula has no cached value. Showing the formula beats showing an empty
  // cell, which would read as "the agent left this blank".
  assert.equal(rows[1][2].text, '', 'no cached value');
  assert.equal(rows[1][2].formula, '=B2*0.1', 'the formula itself is reported');
});

test('parses a workbook Excel wrote (sharedStrings and cached formula values)', () => {
  const shared = `<?xml version="1.0"?><sst><si><t>Name</t></si><si><r><t>Rich</t></r><r><t> Text</t></r></si></sst>`;
  const sheet1 = `<worksheet><sheetData>` +
    `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>` +
    `<row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2"><f>A2&amp;B2</f><v>42</v></c></row>` +
    `</sheetData></worksheet>`;
  const buffer = zip({
    '[Content_Types].xml': '<Types/>',
    'xl/workbook.xml': WORKBOOK_XML,
    'xl/_rels/workbook.xml.rels': RELS_XML,
    'xl/sharedStrings.xml': shared,
    'xl/worksheets/sheet1.xml': sheet1,
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData/></worksheet>',
  });

  const result = parseXlsx(buffer);
  assert.equal(result.ok, true, result.error);
  const rows = result.sheets[0].rows;
  assert.equal(rows[0][0].text, 'Name');
  assert.equal(rows[0][1].text, 'Rich Text', 'a rich-text run is concatenated, not truncated to its first part');
  // Excel caches the result, so the value shows even though it is a formula.
  assert.equal(rows[1][1].text, '42');
  assert.equal(rows[1][1].formula, '=A2&B2', 'the entity-decoded formula');
});

test('reports a sparse row by column, not by position in the row', () => {
  // `<c r="C1">` with no A1/B1 must land in column 2. Placing it at index 0
  // would silently shift every value in the sheet one column left.
  const buffer = zip({
    'xl/workbook.xml': WORKBOOK_XML,
    'xl/_rels/workbook.xml.rels': RELS_XML,
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData><row r="1"><c r="C1" t="inlineStr"><is><t>far</t></is></c></row></sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData/></worksheet>',
  });
  const result = parseXlsx(buffer);
  assert.equal(result.ok, true, result.error);
  const row = result.sheets[0].rows[0];
  assert.equal(row[0], undefined, 'A1 is genuinely absent');
  assert.equal(row[2].text, 'far', 'the value is in column C');
});

test('a corrupt or non-xlsx buffer is reported, not thrown', () => {
  // The pane shows an error rather than the app crashing on a bad file.
  const notAZip = Buffer.from('this is plainly not a workbook', 'utf8');
  const result = parseXlsx(notAZip);
  assert.equal(result.ok, false);
  assert.match(result.error, /xlsx|zip/i);

  // A zip that is not a workbook: no worksheets at all.
  const emptyZip = zip({ 'readme.txt': 'hello' });
  const empty = parseXlsx(emptyZip);
  assert.equal(empty.ok, false);
  assert.match(empty.error, /工作表|工作簿/);
});

test('a corrupt member does not sink the rest of the workbook', () => {
  // sharedStrings is deliberately garbage-ish; the grid must still come through.
  const buffer = zip({
    'xl/workbook.xml': WORKBOOK_XML,
    'xl/_rels/workbook.xml.rels': RELS_XML,
    'xl/sharedStrings.xml': '<sst><si><t>ok</t></si>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData/></worksheet>',
  });
  const result = parseXlsx(buffer);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.sheets[0].rows[0][0].text, 'ok');
});

test('parses a real workbook written by the CLI end to end', () => {
  // The synthetic cases above pin the parsing rules; this one pins the actual
  // contract with the CLI. `cli-created.xlsx` was produced by running the CLI's
  // own create_xlsx tool, so it is the real bytes an agent working in this app
  // will produce — including the two things that only the CLI does: text as
  // inlineStr, and formula cells with no cached value.
  const result = parseXlsx(readFileSync(path.join(__dirname, 'fixtures', 'cli-created.xlsx')));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.sheets.length, 1);
  assert.equal(result.sheets[0].name, '收入明细');

  assert.deepEqual(
    result.sheets[0].rows.slice(0, 3).map((row) => row.map((cell) => (cell?.formula ?? cell?.text ?? ''))),
    [
      ['月份', '收入', '支出', '净利润'],
      ['1月', '10000', '6000', '=B2-C2'],
      ['2月', '12000', '7000', '=B3-C3'],
    ],
  );
});

test('entity references and non-BMP characters survive the round trip', () => {
  const buffer = zip({
    'xl/workbook.xml': WORKBOOK_XML,
    'xl/_rels/workbook.xml.rels': RELS_XML,
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData><row r="1">` +
      `<c r="A1" t="inlineStr"><is><t>a &amp; b &lt;c&gt; &#21608; &#x1F600;</t></is></c>` +
      `</row></sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData/></worksheet>',
  });
  const result = parseXlsx(buffer);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.sheets[0].rows[0][0].text, 'a & b <c> 周 😀');
});
