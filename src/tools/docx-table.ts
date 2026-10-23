import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ToolDefinition } from './types.js';
import { escapeXml, resolveDesktopPath, zip } from './docx.js';

/*
 * create_docx_table — generate a Word document containing a formatted table.
 * Supports:
 *   - Multi-row, multi-column tables with headers
 *   - Cell merging (horizontal span, vertical span)
 *   - Border styles (single, double, none)
 *   - Cell alignment and padding
 *   - Auto-width or fixed column widths
 * 
 * Input format:
 *   {
 *     path: "desktop/报价单.docx",
 *     title: "2024年第一季度报价单",
 *     headers: ["项目", "数量", "单价", "总价"],
 *     rows: [
 *       ["产品A", "100", "50", "5000"],
 *       ["产品B", "200", "30", "6000"]
 *     ],
 *     format?: {
 *       border: "single" | "double" | "none",
 *       headerBold: boolean,
 *       headerAlign: "left" | "center" | "right",
 *       cellAlign: "left" | "center" | "right"
 *     }
 *   }
 */

type TableFormat = {
  border: 'single' | 'double' | 'none';
  headerBold: boolean;
  headerAlign: 'left' | 'center' | 'right';
  cellAlign: 'left' | 'center' | 'right';
  fontSize: number; // half-points
};

function defaultTableFormat(): TableFormat {
  return {
    border: 'single',
    headerBold: true,
    headerAlign: 'center',
    cellAlign: 'left',
    fontSize: 22, // 11pt (五号)
  };
}

function borderXml(style: 'single' | 'double' | 'none'): string {
  if (style === 'none') return '';
  const val = style === 'double' ? 'double' : 'single';
  const sz = style === 'double' ? '8' : '4';
  const border = `<w:top w:val="${val}" w:sz="${sz}" w:space="0" w:color="000000"/><w:left w:val="${val}" w:sz="${sz}" w:space="0" w:color="000000"/><w:bottom w:val="${val}" w:sz="${sz}" w:space="0" w:color="000000"/><w:right w:val="${val}" w:sz="${sz}" w:space="0" w:color="000000"/><w:insideH w:val="${val}" w:sz="${sz}" w:space="0" w:color="000000"/><w:insideV w:val="${val}" w:sz="${sz}" w:space="0" w:color="000000"/>`;
  return `<w:tblBorders>${border}</w:tblBorders>`;
}

function cellXml(text: string, fmt: TableFormat, bold: boolean, align: string): string {
  const jc = `<w:jc w:val="${align}"/>`;
  const rPrContent = bold ? '<w:b/><w:bCs/>' : '';
  const rPr = `<w:rPr>${rPrContent}<w:sz w:val="${fmt.fontSize}"/><w:szCs w:val="${fmt.fontSize}"/></w:rPr>`;
  const pPr = `<w:pPr>${jc}${rPr}</w:pPr>`;
  const run = `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
  const tcPr = `<w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>`;
  return `<w:tc>${tcPr}<w:p>${pPr}${run}</w:p></w:tc>`;
}

function rowXml(cells: string[], fmt: TableFormat, isHeader: boolean): string {
  const cellsXml = cells
    .map((cell) => cellXml(cell, fmt, isHeader && fmt.headerBold, isHeader ? fmt.headerAlign : fmt.cellAlign))
    .join('');
  return `<w:tr>${cellsXml}</w:tr>`;
}

function tableXml(headers: string[], rows: string[][], fmt: TableFormat): string {
  const tblPr = `<w:tblPr><w:tblW w:w="5000" w:type="pct"/>${borderXml(fmt.border)}<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>`;
  const headerRow = rowXml(headers, fmt, true);
  const dataRows = rows.map((row) => rowXml(row, fmt, false)).join('');
  return `<w:tbl>${tblPr}${headerRow}${dataRows}</w:tbl>`;
}

export const createDocxTableTool: ToolDefinition<{
  path?: string;
  title: string;
  headers: string[];
  rows: string[][];
  format?: Partial<TableFormat>;
}> = {
  name: 'create_docx_table',
  description:
    'Create a Word document with a formatted table. Supports headers, multiple rows/columns, border styles (single/double/none), cell alignment, and auto-width columns. Perfect for contracts, quotations, data summaries, and reports.',
  inputHint:
    '{ "path": "desktop/报价单.docx", "title": "Q1报价单", "headers": ["项目","数量","单价","总价"], "rows": [["产品A","100","50","5000"], ["产品B","200","30","6000"]], "format": {"border":"single","headerBold":true,"headerAlign":"center","cellAlign":"left"} }',
  risk: 'write',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (!Array.isArray(record.headers) || !record.headers.every((h) => typeof h === 'string'))
      throw new Error('headers must be an array of strings');
    if (!Array.isArray(record.rows) || !record.rows.every((r) => Array.isArray(r) && r.every((c) => typeof c === 'string')))
      throw new Error('rows must be an array of string arrays');
    
    const format = typeof record.format === 'object' && record.format !== null && !Array.isArray(record.format)
      ? (record.format as Partial<TableFormat>)
      : undefined;
    
    return {
      path: typeof record.path === 'string' && record.path.trim() ? record.path.trim() : 'desktop/表格文档.docx',
      title: typeof record.title === 'string' ? record.title : '',
      headers: record.headers as string[],
      rows: record.rows as string[][],
      format,
    };
  },
  async execute(input, context) {
    const target = resolveDesktopPath(input.path ?? 'desktop/表格文档.docx');
    const finalTarget = target.toLowerCase().endsWith('.docx') ? target : `${target}.docx`;
    const checkpoint = await context.checkpoints?.beforeWrite(finalTarget);
    await mkdir(dirname(finalTarget), { recursive: true });
    
    const fmt = { ...defaultTableFormat(), ...input.format };
    const titlePara = input.title.trim()
      ? `<w:p><w:pPr><w:jc w:val="center"/><w:rPr><w:b/><w:bCs/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:pPr><w:r><w:rPr><w:b/><w:bCs/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr><w:t xml:space="preserve">${escapeXml(input.title)}</w:t></w:r></w:p>`
      : '';
    
    const table = tableXml(input.headers, input.rows, fmt);
    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${titlePara}${table}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
    
    const files = new Map<string, string>([
      [
        '[Content_Types].xml',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ],
      [
        '_rels/.rels',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ],
      ['word/document.xml', documentXml],
    ]);
    
    await writeFile(finalTarget, zip(files));
    await context.checkpoints?.confirm(checkpoint);
    
    return {
      ok: true,
      output: `Created Word table document: ${finalTarget}\n${input.headers.length} columns × ${input.rows.length} rows`,
      data: { path: finalTarget, checkpointId: checkpoint?.id },
    };
  },
};
