import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';
import { extractPdfContentText, extractPdfTextFromBuffer, parseToUnicodeCMap } from '../src/tools/pdf-text.js';

/**
 * A PDF that has the shape real producers emit: a page tree, a compressed
 * content stream, and a font with its own code→Unicode map. The four PDFs this
 * tool was tested against in the user's Downloads folder are all like this, and
 * the previous extractor returned 0 characters for every one of them because it
 * only read uncompressed content.
 */
function buildPdf({ fontCode = 0x41, unicode = 'A', compress = true }: { fontCode?: number; unicode?: string; compress?: boolean }) {
  // An empty `unicode` builds a page with no text operator at all — the shape
  // of an image-only scan.
  const content = unicode
    ? `BT /F1 24 Tf 72 700 Td <${fontCode.toString(16).padStart(4, '0')}> Tj ET`
    : 'q 100 0 0 100 0 0 cm /Im1 Do Q';
  const contentBytes = Buffer.from(content, 'latin1');
  const body = compress ? deflateSync(contentBytes) : contentBytes;
  const cmap = [
    'begincmap',
    `1 beginbfchar <${fontCode.toString(16).padStart(4, '0')}> <${unicode.charCodeAt(0).toString(16).padStart(4, '0')}> endbfchar`,
    'endcmap',
  ].join('\n');

  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (textPart: string | Buffer) => {
    const buffer = typeof textPart === 'string' ? Buffer.from(textPart, 'latin1') : textPart;
    parts.push(buffer);
    length += buffer.length;
  };
  const object = (number: number, dict: string, stream?: Buffer) => {
    offsets[number] = length;
    push(`${number} 0 obj\n${dict}\n`);
    if (stream) push(Buffer.concat([Buffer.from('stream\n', 'latin1'), stream, Buffer.from('\nendstream\n', 'latin1')]));
    push('endobj\n');
  };

  push('%PDF-1.4\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>');
  object(4, `<< /Length ${body.length} /Filter /FlateDecode >>`, body);
  object(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>');
  object(6, `<< /Length ${cmap.length} >>`, Buffer.from(cmap, 'latin1'));

  const xref = length;
  push(`xref\n0 7\n0000000000 65535 f \n`);
  for (let i = 1; i <= 6; i += 1) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

test('reads text out of a compressed content stream', () => {
  // The exact failure the tool had: a FlateDecode'd page returned ''.
  const pdf = buildPdf({ fontCode: 0x48, unicode: 'H' });
  const text = extractPdfTextFromBuffer(pdf);
  assert.equal(text, 'H');
});

test('applies the font ToUnicode map instead of returning raw glyph codes', () => {
  // Code 0x0301 is the font's own glyph id, not U+0301. Without the CMap the
  // output is a wrong character — which for a subsetted Chinese font is mojibake.
  const pdf = buildPdf({ fontCode: 0x0301, unicode: '数' });
  assert.equal(extractPdfTextFromBuffer(pdf), '数');
});

test('keeps two fonts apart in the same content stream', () => {
  // The same code (0x41) means different characters in different fonts. A
  // single merged map — the first version of this reader — decodes both runs
  // with whichever font happened to be parsed last.
  const content = 'BT /F1 12 Tf (A) Tj /F2 12 Tf (A) Tj ET';
  const fonts = new Map([
    ['F1', new Map([[0x41, 'A']])],
    ['F2', new Map([[0x41, '中']])],
  ]);
  assert.deepEqual(extractPdfContentText(content, fonts), ['A中']);
});

test('reads a TJ array and joins its strings', () => {
  const content = 'BT /F1 12 Tf [(Hel) -20 (lo)] TJ ET';
  const fonts = new Map([['F1', new Map(Array.from('Helo', (c, i) => [c.charCodeAt(0), c]))]]);
  assert.deepEqual(extractPdfContentText(content, fonts), ['Hello']);
});

test('decodes a hex string through the CMap', () => {
  const content = 'BT /F1 12 Tf <4E2D> Tj ET';
  const fonts = new Map([['F1', new Map([[0x4e2d, '中']])]]);
  assert.deepEqual(extractPdfContentText(content, fonts), ['中']);
});

test('an unencrypted file with no text layer reports empty rather than throwing', () => {
  // An image-only scan: a valid PDF whose page has no text operators.
  const pdf = buildPdf({ unicode: '' });
  assert.equal(extractPdfTextFromBuffer(pdf), '');
});

test('a CMap bfrange maps a contiguous range', () => {
  const map = parseToUnicodeCMap('1 beginbfrange <0020> <0022> <0041> endbfrange');
  assert.equal(map.get(0x20), 'A');
  assert.equal(map.get(0x21), 'B');
  assert.equal(map.get(0x22), 'C');
});

test('a pathologically wide bfrange is capped instead of allocating forever', () => {
  const map = parseToUnicodeCMap('1 beginbfrange <0000> <FFFF> <0041> endbfrange');
  assert.ok(map.size <= 65_536);
});

test('a buffer that is not a PDF returns empty, never throws', () => {
  assert.equal(extractPdfTextFromBuffer(Buffer.from('just some text')), '');
});
