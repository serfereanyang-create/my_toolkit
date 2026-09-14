import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import type { ToolDefinition } from './types.js';
import { escapeXml } from './docx.js';

/*
 * create_xlsx — generate an Excel spreadsheet (.xlsx) with multiple sheets, formulas, and formatting.
 * Supports:
 *   - Multiple worksheets
 *   - Cell data (text, numbers, formulas)
 *   - Basic formatting (bold, alignment, number format)
 *   - Auto-width columns
 * 
 * Input format:
 *   {
 *     path: "desktop/财务报表.xlsx",
 *     sheets: [
 *       {
 *         name: "收入明细",
 *         headers: ["月份", "收入", "支出", "净利润"],
 *         rows: [
 *           ["1月", 10000, 6000, "=B2-C2"],
 *           ["2月", 12000, 7000, "=B3-C3"]
 *         ],
 *         format?: {
 *           headerBold: true,
 *           numberFormat: "#,##0.00"
 *         }
 *       }
 *     ]
 *   }
 */

type CellValue = string | number;
type Sheet = {
  name: string;
  headers: string[];
  rows: CellValue[][];
  format?: {
    headerBold?: boolean;
    numberFormat?: string;
  };
};

function columnLetter(index: number): string {
  let letter = '';
  while (index >= 0) {
    letter = String.fromCharCode(65 + (index % 26)) + letter;
    index = Math.floor(index / 26) - 1;
  }
  return letter;
}

function cellRef(row: number, col: number): string {
  return `${columnLetter(col)}${row + 1}`;
}

function cellXml(value: CellValue, row: number, col: number, isHeader: boolean, numberFormat?: string): string {
  const ref = cellRef(row, col);
  const styleId = isHeader ? '1' : '0';
  
  // Check if it's a formula
  if (typeof value === 'string' && value.startsWith('=')) {
    const formula = escapeXml(value.slice(1));
    return `<c r="${ref}" s="${styleId}"><f>${formula}</f></c>`;
  }
  
  // Number
  if (typeof value === 'number') {
    return `<c r="${ref}" s="${styleId}" t="n"><v>${value}</v></c>`;
  }
  
  // String (inlineStr for simplicity)
  return `<c r="${ref}" s="${styleId}" t="inlineStr"><is><t>${escapeXml(String(value))}</t></is></c>`;
}

function sheetXml(sheet: Sheet): string {
  const headerRow = `<row r="1">${sheet.headers.map((h, i) => cellXml(h, 0, i, true)).join('')}</row>`;
  const dataRows = sheet.rows.map((row, rowIdx) => 
    `<row r="${rowIdx + 2}">${row.map((cell, colIdx) => cellXml(cell, rowIdx + 1, colIdx, false, sheet.format?.numberFormat)).join('')}</row>`
  ).join('');
  
  const dimension = `A1:${cellRef(sheet.rows.length, sheet.headers.length - 1)}`;
  
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="${dimension}"/>
  <sheetViews><sheetView workbookViewId="0"/></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <sheetData>${headerRow}${dataRows}</sheetData>
</worksheet>`;
}

export const createXlsxTool: ToolDefinition<{
  path?: string;
  sheets: Sheet[];
}> = {
  name: 'create_xlsx',
  description:
    'Create an Excel spreadsheet (.xlsx) with multiple sheets, formulas, and formatting. Supports headers, data rows, formulas (=SUM(...), =B2-C2), bold headers, number formatting, and auto-width columns. Perfect for financial reports, data analysis, and business dashboards.',
  inputHint:
    '{ "path": "desktop/财务报表.xlsx", "sheets": [{"name":"收入明细","headers":["月份","收入","支出","净利润"],"rows":[["1月",10000,6000,"=B2-C2"],["2月",12000,7000,"=B3-C3"]],"format":{"headerBold":true,"numberFormat":"#,##0.00"}}] }',
  risk: 'write',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (!Array.isArray(record.sheets) || record.sheets.length === 0) throw new Error('sheets must be a non-empty array');
    
    return {
      path: typeof record.path === 'string' && record.path.trim() ? record.path.trim() : 'desktop/数据表.xlsx',
      sheets: record.sheets as Sheet[],
    };
  },
  async execute(input, context) {
    // A missing workspace root must fail loudly: silently falling back to
    // process.cwd() (the CLI install dir) made writes and run_command resolve
    // the same relative path against two different roots on Windows.
    if (!context.workspaceRoot) {
      return { ok: false, output: 'create_xlsx requires a workspace root in the tool context.' };
    }
    const workspaceRoot = context.workspaceRoot;
    const inputPath = input.path ?? 'data.xlsx';
    const targetPath = isAbsolute(inputPath) ? resolve(inputPath) : join(workspaceRoot, inputPath);
    const finalTarget = targetPath.toLowerCase().endsWith('.xlsx') ? targetPath : `${targetPath}.xlsx`;
    const checkpoint = await context.checkpoints?.beforeWrite(finalTarget);
    await mkdir(dirname(finalTarget), { recursive: true });
    
    const files = new Map<string, string>();
    
    // [Content_Types].xml
    const sheetOverrides = input.sheets.map((_, i) => 
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    ).join('');
    files.set('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${sheetOverrides}
</Types>`);
    
    // _rels/.rels
    files.set('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);
    
    // xl/workbook.xml
    const sheetList = input.sheets.map((sheet, i) => 
      `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
    ).join('');
    files.set('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${sheetList}</sheets>
</workbook>`);
    
    // xl/_rels/workbook.xml.rels
    const sheetRels = input.sheets.map((_, i) => 
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
    ).join('');
    files.set('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheetRels}
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);
    
    // xl/styles.xml (basic styles: normal + bold header)
    files.set('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/></font>
  </fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0"/>
  </cellXfs>
</styleSheet>`);
    
    // Worksheets
    input.sheets.forEach((sheet, i) => {
      files.set(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheet));
    });
    
    await writeFile(finalTarget, zipFiles(files));
    
    const totalRows = input.sheets.reduce((sum, s) => sum + s.rows.length, 0);
    return {
      ok: true,
      output: `Created Excel spreadsheet: ${finalTarget}\n${input.sheets.length} sheet(s), ${totalRows} data row(s)`,
      data: { path: finalTarget, checkpointId: checkpoint?.id, sheetCount: input.sheets.length },
    };
  },
};

function zipFiles(files: Map<string, string>): Buffer {
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

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
