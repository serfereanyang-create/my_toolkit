import assert from 'node:assert/strict';
import { test } from 'node:test';
import { zip } from '../src/tools/docx.js';
import { docxToText, docxXmlToText } from '../src/tools/docx-text.js';

/*
 * `docx_to_text` is what makes "打开这个 word" work. Before it existed the CLI
 * could CREATE .docx files but not read one, so the agent improvised with
 * unzip/grep/sed calls that failed and left failed tool calls in the transcript.
 */

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function docx(bodyXml: string): Buffer {
  const files = new Map<string, string>();
  files.set(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>',
  );
  files.set('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body>${bodyXml}</w:body></w:document>`);
  return zip(files);
}

const heading = (level: number, text: string) =>
  `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
const para = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

test('docxToText keeps paragraph breaks, headings and table rows', () => {
  const buffer = docx([
    heading(1, '第一章 总则'),
    para('本文档用于测试。'),
    para('第二段 &amp; 转义。'),
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>值</w:t></w:r></w:p></w:tc></w:tr>'
    + '<w:tr><w:tc><w:p><w:r><w:t>合计</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
  ].join(''));

  const result = docxToText(buffer);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.match(result.text, /^# 第一章 总则/m);
  assert.match(result.text, /本文档用于测试。/);
  // Entities are decoded once, not left as &amp;.
  assert.match(result.text, /第二段 & 转义。/);
  // A table row stays on one line with cells separated by ` | `.
  assert.match(result.text, /项目 \| 值/);
  assert.match(result.text, /合计 \| 42/);
  assert.ok(result.chars > 0);
  assert.equal(result.truncated, false);
});

test('docxToText reports a legacy .doc instead of throwing', () => {
  // OLE2 header: D0 CF 11 E0 — an old binary .doc, not a ZIP.
  const legacy = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);
  const result = docxToText(legacy);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /\.doc\b|旧版|Word 97/i);
});

test('docxToText refuses a zip with no document part', () => {
  const buffer = zip(new Map([['word/other.xml', '<x/>']]));
  const result = docxToText(buffer);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /document\.xml/);
});

test('docxToText truncates at maxChars instead of returning a huge string', () => {
  const buffer = docx(para('长'.repeat(500)));
  const result = docxToText(buffer, 50);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= 50);
});

test('docxXmlToText leaves tab and line-break markers intact', () => {
  const xml = '<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:r></w:p>';
  assert.equal(docxXmlToText(xml).replace(/\n{2,}/g, '\n'), 'a\tb\nc');
});
