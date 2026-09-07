import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import type { ToolDefinition } from './types.js';

/*
 * create_docx — generate a real, properly formatted Microsoft Word .docx with
 * genuine OOXML run/paragraph properties: Chinese + Western fonts, font size,
 * line spacing, first-line indent, and alignment. No external dependency
 * (python-docx, pandoc, Word) is needed — these are standard WordprocessingML
 * attributes we write directly into word/document.xml.
 *
 * The `body` supports lightweight heading markers so a whole structured
 * document can be produced in one call:
 *   # 一级标题   → heading level 1
 *   ## 二级标题  → heading level 2
 *   ### 三级标题 → heading level 3
 *   其余行        → body paragraph
 * A blank line becomes an empty paragraph.
 *
 * Defaults follow the common Chinese thesis convention:
 *   body   宋体 (SimSun) 小四 (12pt), 1.5x line spacing, first-line indent 2 chars
 *   H1     黑体 (SimHei) 三号 (16pt), centered
 *   H2     黑体 (SimHei) 四号 (14pt)
 *   H3     黑体 (SimHei) 小四 (12pt)
 * All of these can be overridden via the optional `format` object.
 */

// Chinese font-size names → half-points (Word's w:sz unit is half-points).
// e.g. 小四 = 12pt = 24 half-points.
const CN_FONT_SIZE_HALF_POINTS: Record<string, number> = {
  初号: 84, // 42pt
  小初: 72, // 36pt
  一号: 52, // 26pt
  小一: 48, // 24pt
  二号: 44, // 22pt
  小二: 36, // 18pt
  三号: 32, // 16pt
  小三: 30, // 15pt
  四号: 28, // 14pt
  小四: 24, // 12pt
  五号: 21, // 10.5pt
  小五: 18, // 9pt
  六号: 15, // 7.5pt
  小六: 13, // 6.5pt
};

// Font name normalization. For the eastAsia attribute, Chinese Word/WPS resolve
// the Chinese display name ("宋体") most reliably across versions, so we emit the
// Chinese name and map any English family aliases back to it.
const CN_FONT_ALIASES: Record<string, string> = {
  宋体: '宋体',
  黑体: '黑体',
  楷体: '楷体',
  仿宋: '仿宋',
  微软雅黑: '微软雅黑',
  等线: '等线',
  隶书: '隶书',
  幼圆: '幼圆',
  华文宋体: '华文宋体',
  华文楷体: '华文楷体',
  华文仿宋: '华文仿宋',
  华文中宋: '华文中宋',
  // English family names → Chinese display name (so callers can use either).
  SimSun: '宋体',
  SimHei: '黑体',
  KaiTi: '楷体',
  FangSong: '仿宋',
  'Microsoft YaHei': '微软雅黑',
  DengXian: '等线',
  'Times New Roman': 'Times New Roman',
  Arial: 'Arial',
};

type ParaFormat = {
  font: string; // resolved eastAsia font family
  ascii: string; // Western font family
  sizeHalfPoints: number;
  bold: boolean;
  align: 'left' | 'center' | 'right' | 'both';
  lineSpacing: number; // multiple, e.g. 1.5
  firstLineIndentChars: number; // in Chinese characters
  spaceBeforeHalfPoints: number; // paragraph space-before, half-points
  spaceAfterHalfPoints: number;
};

type FormatOverride = Partial<{
  font: string;
  westernFont: string;
  size: string | number; // Chinese name ("小四") or point number (12)
  lineSpacing: number;
  firstLineIndentChars: number;
  align: 'left' | 'center' | 'right' | 'both' | 'justify';
}>;

function resolveFont(name: string | undefined, fallback: string): string {
  if (!name) return fallback;
  const trimmed = name.trim();
  return CN_FONT_ALIASES[trimmed] ?? trimmed;
}

// Accept a Chinese size name ("小四"), a point number (12), or a numeric string.
function resolveSizeHalfPoints(size: string | number | undefined, fallback: number): number {
  if (size === undefined || size === null || size === '') return fallback;
  if (typeof size === 'number' && Number.isFinite(size) && size > 0) return Math.round(size * 2);
  const asString = String(size).trim();
  if (CN_FONT_SIZE_HALF_POINTS[asString]) return CN_FONT_SIZE_HALF_POINTS[asString];
  const points = Number(asString);
  if (Number.isFinite(points) && points > 0) return Math.round(points * 2);
  return fallback;
}

function normalizeAlign(align: FormatOverride['align']): ParaFormat['align'] | undefined {
  if (!align) return undefined;
  if (align === 'justify') return 'both';
  return align;
}

// Base body preset (Chinese thesis default), then apply any override.
function bodyFormat(override?: FormatOverride): ParaFormat {
  return {
    font: resolveFont(override?.font, '宋体'),
    ascii: resolveFont(override?.westernFont, 'Times New Roman'),
    sizeHalfPoints: resolveSizeHalfPoints(override?.size, 24), // 小四
    bold: false,
    align: normalizeAlign(override?.align) ?? 'both',
    lineSpacing: typeof override?.lineSpacing === 'number' && override.lineSpacing > 0 ? override.lineSpacing : 1.5,
    firstLineIndentChars:
      typeof override?.firstLineIndentChars === 'number' && override.firstLineIndentChars >= 0
        ? override.firstLineIndentChars
        : 2,
    spaceBeforeHalfPoints: 0,
    spaceAfterHalfPoints: 0,
  };
}

// Heading presets (level 1..3). Headings keep no first-line indent.
function headingFormat(level: number, override?: FormatOverride): ParaFormat {
  const base = bodyFormat(override);
  const headingFont = resolveFont(override?.font, '黑体');
  if (level <= 1) {
    return { ...base, font: headingFont, sizeHalfPoints: 32, bold: true, align: normalizeAlign(override?.align) ?? 'center', firstLineIndentChars: 0, spaceBeforeHalfPoints: 24, spaceAfterHalfPoints: 24 };
  }
  if (level === 2) {
    return { ...base, font: headingFont, sizeHalfPoints: 28, bold: true, align: 'left', firstLineIndentChars: 0, spaceBeforeHalfPoints: 18, spaceAfterHalfPoints: 12 };
  }
  return { ...base, font: headingFont, sizeHalfPoints: 24, bold: true, align: 'left', firstLineIndentChars: 0, spaceBeforeHalfPoints: 12, spaceAfterHalfPoints: 6 };
}

export const createDocxTool: ToolDefinition<{
  path?: string;
  title: string;
  body: string;
  format?: FormatOverride;
}> = {
  name: 'create_docx',
  description:
    'Create a real, formatted Microsoft Word .docx with genuine Chinese/Western fonts, font size, line spacing, first-line indent, and alignment (no external tool needed). body supports #/##/### heading markers. Defaults to the Chinese thesis convention (正文宋体小四 1.5倍行距首行缩进2字符; 标题黑体分级). Use format to override, e.g. {"font":"宋体","size":"小四","lineSpacing":1.5,"firstLineIndentChars":2}.',
  inputHint:
    '{ "path": "desktop/论文.docx", "title": "标题", "body": "## 第一章\\n正文段落...", "format": { "font": "宋体", "size": "小四", "lineSpacing": 1.5, "firstLineIndentChars": 2, "align": "both" } }',
  risk: 'write',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : 'desktop/新建文档.docx';
    const format = typeof record.format === 'object' && record.format !== null && !Array.isArray(record.format)
      ? (record.format as FormatOverride)
      : undefined;
    return {
      path,
      title: typeof record.title === 'string' ? record.title : '',
      body: typeof record.body === 'string' ? record.body : '',
      format,
    };
  },
  async execute(input, context) {
    const target = resolveDocxPath(input.path ?? 'desktop/新建文档.docx');
    const checkpoint = await context.checkpoints?.beforeWrite(target);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, buildDocx(input.title, input.body, input.format));
    const fmt = bodyFormat(input.format);
    const summary = `正文 ${input.format?.font ?? '宋体'} ${input.format?.size ?? '小四'} · ${fmt.lineSpacing}倍行距 · 首行缩进${fmt.firstLineIndentChars}字符`;
    return {
      ok: true,
      output: `Created Word document: ${target}\n格式：${summary}`,
      data: { path: target, checkpointId: checkpoint?.id },
    };
  },
};

export function resolveDesktopPath(path: string, defaultName = '新建文档.docx') {
  const normalized = path.replace(/\\/g, '/');
  const desktop = join(homedir(), 'Desktop');
  if (normalized.toLowerCase().startsWith('desktop/')) {
    return join(desktop, normalized.slice('desktop/'.length));
  }
  if (normalized.toLowerCase() === 'desktop') {
    return join(desktop, defaultName);
  }
  if (normalized.includes('/') || normalized.includes(':')) {
    return resolve(path);
  }
  return join(desktop, basename(path));
}

function resolveDocxPath(path: string) {
  return withDocxExtension(resolveDesktopPath(path));
}

function withDocxExtension(path: string) {
  return path.toLowerCase().endsWith('.docx') ? path : `${path}.docx`;
}

type Block = { level: number; text: string };

// Parse the body into blocks, honouring #/##/### heading markers. The title (if
// any) becomes a top-level heading rendered centered above the body.
function parseBlocks(title: string, body: string): Block[] {
  const blocks: Block[] = [];
  if (title.trim()) blocks.push({ level: 1, text: title.trim() });
  const lines = body.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      blocks.push({ level: heading[1].length, text: heading[2].trim() });
    } else {
      blocks.push({ level: 0, text: line });
    }
  }
  return blocks;
}

// Build a run-properties (<w:rPr>) block for a paragraph format.
function runProps(fmt: ParaFormat): string {
  const fonts = `<w:rFonts w:ascii="${escapeXml(fmt.ascii)}" w:hAnsi="${escapeXml(fmt.ascii)}" w:eastAsia="${escapeXml(fmt.font)}" w:cs="${escapeXml(fmt.ascii)}"/>`;
  const bold = fmt.bold ? '<w:b/><w:bCs/>' : '';
  const size = `<w:sz w:val="${fmt.sizeHalfPoints}"/><w:szCs w:val="${fmt.sizeHalfPoints}"/>`;
  return `<w:rPr>${fonts}${bold}${size}</w:rPr>`;
}

// Build paragraph-properties (<w:pPr>): alignment, line spacing, indent, spacing.
function paraProps(fmt: ParaFormat): string {
  const jc = `<w:jc w:val="${fmt.align}"/>`;
  // Line spacing: line=240*multiple, lineRule=auto (240 = single line).
  const line = Math.round(240 * fmt.lineSpacing);
  const spacing = `<w:spacing w:line="${line}" w:lineRule="auto" w:before="${fmt.spaceBeforeHalfPoints * 10}" w:after="${fmt.spaceAfterHalfPoints * 10}"/>`;
  // First-line indent measured in characters (firstLineChars unit = 1/100 char).
  const indent = fmt.firstLineIndentChars > 0 ? `<w:ind w:firstLineChars="${fmt.firstLineIndentChars * 100}" w:firstLine="${fmt.firstLineIndentChars * fmt.sizeHalfPoints * 10}"/>` : '';
  // Repeat run fonts at paragraph mark so empty paragraphs keep the font.
  const rPr = runProps(fmt);
  return `<w:pPr>${spacing}${jc}${indent}${rPr}</w:pPr>`;
}

function paragraphXml(text: string, fmt: ParaFormat): string {
  if (!text) return `<w:p>${paraProps(fmt)}</w:p>`;
  // xml:space="preserve" keeps leading/trailing spaces inside the run.
  return `<w:p>${paraProps(fmt)}<w:r>${runProps(fmt)}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function buildDocx(title: string, body: string, format?: FormatOverride) {
  const blocks = parseBlocks(title, body);
  const bodyFmt = bodyFormat(format);
  const paragraphsXml = blocks.length === 0
    ? '<w:p/>'
    : blocks
        .map((block) => (block.level > 0 ? paragraphXml(block.text, headingFormat(block.level, format)) : paragraphXml(block.text, bodyFmt)))
        .join('');

  const files = new Map<string, string>([
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ],
    [
      'word/document.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphsXml}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`,
    ],
  ]);
  return zip(files);
}

export function escapeXml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function zip(files: Map<string, string>) {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBuffer = Buffer.from(name);
    const data = Buffer.from(content, 'utf8');
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    chunks.push(local, nameBuffer, compressed);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBuffer.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBuffer);
    offset += local.length + nameBuffer.length + compressed.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
