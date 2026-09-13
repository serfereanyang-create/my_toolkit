'use strict';
/**
 * CSV export for the usage ledger (iteration 21). Pure function so both the
 * IPC handler and tests can call it without Electron. RFC 4180 quoting:
 * fields containing comma/quote/newline are wrapped in double quotes with
 * embedded quotes doubled. Numbers are emitted plain; missing fields empty.
 */

const COLUMNS = [
  'timestamp', 'iso', 'model', 'provider', 'baseUrl', 'source',
  'input', 'output', 'cacheRead', 'cacheCreation', 'total',
  'reasoningEffort', 'sessionId', 'turnId', 'toolCalls', 'toolsUsed',
  'boardId', 'taskId', 'durationMs',
];

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = Array.isArray(value) ? value.join('|') : String(value);
  if (/[",\r\n]/.test(s)) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * Convert usage records into a CSV string (CRLF line endings, BOM optional).
 * @param {Array<object>} records ledger rows
 * @param {{ bom?: boolean, columns?: string[] }} [options]
 */
function usageToCsv(records, options = {}) {
  const cols = Array.isArray(options.columns) && options.columns.length ? options.columns : COLUMNS;
  const lines = [cols.map(csvCell).join(',')];
  for (const rec of Array.isArray(records) ? records : []) {
    if (!rec || typeof rec !== 'object') continue;
    const row = cols.map((col) => {
      if (col === 'iso') {
        const ts = Number(rec.timestamp);
        return Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : '';
      }
      return csvCell(rec[col]);
    });
    lines.push(row.join(','));
  }
  const body = lines.join('\r\n') + '\r\n';
  return (options.bom ? '\ufeff' : '') + body;
}

module.exports = { usageToCsv, USAGE_CSV_COLUMNS: COLUMNS };
