import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveReadablePath, resolveWorkspacePath } from '../safety/policy.js';
import type { ToolDefinition } from './types.js';

/**
 * CSV tools (read_csv, write_csv, csv_stats, csv_preview).
 *
 * parseCsv handles quoted fields, embedded commas/newlines, and "" escapes.
 * writeCsv quotes any field containing a comma, quote, CR, or LF and doubles
 * inner quotes. Both are exported so tests can exercise the pure logic.
 */

export const readCsvTool: ToolDefinition<{ path: string; maxBytes: number }> = {
  name: 'read_csv',
  description: 'Read and parse a CSV file into rows of fields (RFC-4180: quoted fields, embedded commas/newlines, "" escapes). Returns the parsed rows plus a compact text preview.',
  inputHint: '{ "path": "desktop/data.csv", "maxBytes": 200000 }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.path !== 'string' || record.path.trim() === '') throw new Error('path is required');
    const maxBytes = typeof record.maxBytes === 'number' && record.maxBytes > 0 ? Math.min(Math.floor(record.maxBytes), 5_000_000) : 200_000;
    return { path: record.path.trim(), maxBytes };
  },
  async execute(input, context) {
    const target = resolveReadablePath(context.workspaceRoot, input.path);
    const raw = await readFile(target, 'utf8');
    const sliced = raw.slice(0, input.maxBytes);
    const rows = parseCsv(sliced);
    const preview = rows
      .slice(0, 20)
      .map((row) => row.join(' | '))
      .join('\n');
    const truncated = raw.length > input.maxBytes ? ' (truncated)' : '';
    return {
      ok: true,
      output: `${rows.length} rows × ${rows[0]?.length ?? 0} cols${truncated}\n${preview}`,
      data: { path: target, rows, rowCount: rows.length, colCount: rows[0]?.length ?? 0 },
    };
  },
};

export const writeCsvTool: ToolDefinition<{ path: string; rows: unknown[] }> = {
  name: 'write_csv',
  description: 'Write rows to a CSV file. rows is a 2D array (array of arrays) or an array of flat objects (a header row is written from the keys). Fields are quoted/escaped per RFC-4180.',
  inputHint: '{ "path": "desktop/out.csv", "rows": [["name","score"],["张三",95]] }',
  risk: 'write',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.path !== 'string' || record.path.trim() === '') throw new Error('path is required');
    if (!Array.isArray(record.rows)) throw new Error('rows must be an array');
    return { path: record.path.trim(), rows: record.rows };
  },
  async execute(input, context) {
    const target = resolveWorkspacePath(context.workspaceRoot, input.path);
    const matrix = toMatrix(input.rows);
    const csv = writeCsv(matrix);
    const checkpoint = await context.checkpoints?.beforeWrite(target);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, csv, 'utf8');
    return {
      ok: true,
      output: `Wrote ${matrix.length} rows to ${input.path}`,
      data: { path: target, rows: matrix.length, checkpointId: checkpoint?.id },
    };
  },
};

type Cell = string | number | boolean | null | undefined;

function toMatrix(rows: unknown[]): Cell[][] {
  if (rows.length === 0) return [];
  const first = rows[0];
  if (Array.isArray(first)) {
    return rows.map((row) => (Array.isArray(row) ? (row as Cell[]) : [row as Cell]));
  }
  if (first && typeof first === 'object') {
    const headers = Object.keys(first as Record<string, unknown>);
    const matrix: Cell[][] = [headers];
    for (const row of rows) {
      const record = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
      matrix.push(headers.map((key) => record[key] as Cell));
    }
    return matrix;
  }
  return rows.map((value) => [value as Cell]);
}

// Parse CSV text into rows of string fields. Handles quoted fields with
// embedded commas, CR/LF, and doubled-quote ("") escapes.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ',') {
      pushField();
      i += 1;
      continue;
    }
    if (char === '\r') {
      // Normalize CRLF and lone CR as a row break.
      if (text[i + 1] === '\n') i += 1;
      pushRow();
      i += 1;
      continue;
    }
    if (char === '\n') {
      pushRow();
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }
  // Flush the final field/row unless the text ended exactly on a row break with
  // nothing pending.
  if (field !== '' || row.length > 0) pushRow();
  return rows;
}

function escapeCsvField(value: Cell): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function writeCsv(matrix: Cell[][]): string {
  return matrix.map((row) => row.map(escapeCsvField).join(',')).join('\r\n');
}

export const csvStatsTool: ToolDefinition<{
  path: string;
  header: boolean;
  maxBytes: number;
}> = {
  name: 'csv_stats',
  description:
    'Get statistics about a CSV file: row/column count, column names (if header=true), non-empty cell count per column. Use to understand CSV structure without loading full content.',
  inputHint: '{ "path": "data.csv", "header": true }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    
    if (typeof record.path !== 'string' || !record.path.trim()) throw new Error('path is required');
    
    const maxBytes = typeof record.maxBytes === 'number' ? Math.min(5_000_000, Math.max(10_000, record.maxBytes)) : 500_000;
    const header = record.header === true;
    
    return {
      path: record.path.trim(),
      header,
      maxBytes,
    };
  },
  async execute(input, context) {
    const target = resolveReadablePath(context.workspaceRoot, input.path);
    const raw = await readFile(target, 'utf8');
    const sliced = raw.slice(0, input.maxBytes);
    const rows = parseCsv(sliced);
    
    if (rows.length === 0) {
      return { ok: true, output: 'Empty CSV file', data: { rowCount: 0, colCount: 0 } };
    }
    
    const colCount = rows[0].length;
    const dataRows = input.header ? rows.slice(1) : rows;
    const columns = input.header ? rows[0] : rows[0].map((_, i) => `col${i + 1}`);
    
    const stats = columns.map((name, idx) => {
      const nonEmpty = dataRows.filter(row => row[idx] && row[idx].trim() !== '').length;
      return { name, nonEmpty, total: dataRows.length };
    });
    
    const summary = stats
      .map(s => `  ${s.name.padEnd(20)} ${s.nonEmpty.toString().padStart(5)} / ${s.total} non-empty`)
      .join('\n');
    
    const truncatedNote = raw.length > input.maxBytes ? ` (truncated at ${input.maxBytes} bytes)` : '';
    
    return {
      ok: true,
      output: `CSV stats for ${input.path}${truncatedNote}:\n\nRows: ${rows.length} (${dataRows.length} data${input.header ? ' + 1 header' : ''})\nColumns: ${colCount}\n\n${summary}`,
      data: {
        path: input.path,
        rowCount: rows.length,
        dataRowCount: dataRows.length,
        colCount,
        columns: stats,
      },
    };
  },
};

export const csvPreviewTool: ToolDefinition<{
  path: string;
  rows: number;
  columns: number;
  maxBytes: number;
}> = {
  name: 'csv_preview',
  description:
    'Preview a CSV file with limited rows and columns. Returns a formatted table preview. Use to quickly inspect CSV content without loading the entire file.',
  inputHint: '{ "path": "data.csv", "rows": 10, "columns": 5 }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    
    if (typeof record.path !== 'string' || !record.path.trim()) throw new Error('path is required');
    
    const rows = typeof record.rows === 'number' ? Math.max(1, Math.min(100, record.rows)) : 20;
    const columns = typeof record.columns === 'number' ? Math.max(1, Math.min(50, record.columns)) : 10;
    const maxBytes = typeof record.maxBytes === 'number' ? Math.min(5_000_000, Math.max(1000, record.maxBytes)) : 200_000;
    
    return {
      path: record.path.trim(),
      rows,
      columns,
      maxBytes,
    };
  },
  async execute(input, context) {
    const target = resolveReadablePath(context.workspaceRoot, input.path);
    const raw = await readFile(target, 'utf8');
    const sliced = raw.slice(0, input.maxBytes);
    const allRows = parseCsv(sliced);
    
    if (allRows.length === 0) {
      return { ok: true, output: 'Empty CSV file' };
    }
    
    const previewRows = allRows.slice(0, input.rows);
    const truncatedRows = allRows.length > input.rows;
    const truncatedCols = allRows[0].length > input.columns;
    
    const preview = previewRows
      .map(row => row.slice(0, input.columns).join(' | ') + (truncatedCols ? ' | ...' : ''))
      .join('\n');
    
    const notes: string[] = [];
    if (truncatedRows) notes.push(`showing ${input.rows} of ${allRows.length} rows`);
    if (truncatedCols) notes.push(`showing ${input.columns} of ${allRows[0].length} columns`);
    if (raw.length > input.maxBytes) notes.push('file truncated');
    
    const noteText = notes.length > 0 ? ` (${notes.join(', ')})` : '';
    
    return {
      ok: true,
      output: `CSV preview: ${input.path}${noteText}\n\n${preview}`,
      data: {
        path: input.path,
        rowsReturned: previewRows.length,
        columnsReturned: Math.min(input.columns, allRows[0]?.length ?? 0),
        totalRows: allRows.length,
        totalColumns: allRows[0]?.length ?? 0,
        truncated: truncatedRows || truncatedCols,
      },
    };
  },
};
