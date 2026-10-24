/*
 * Read a .xlsx workbook into plain rows for the preview pane.
 *
 * The desktop has no spreadsheet library and this should not add one: an .xlsx
 * is a zip of XML, and all the preview needs is the cell grid. Parsing it here
 * (in the main process) also keeps the file bytes out of the renderer entirely.
 *
 * Two shapes have to work, and they differ in ways that matter:
 *
 *   - Files the CLI's own `create_xlsx` writes use `t="inlineStr"` for text and
 *     emit formulas as `<f>` with NO cached `<v>`, so a formula cell arrives
 *     with no value at all — it is shown as its formula text rather than as an
 *     empty cell, which would read as "the agent wrote nothing here".
 *   - Files Excel writes use `sharedStrings.xml` with `t="s"` indices, and cache
 *     a `<v>` beside each `<f>`.
 *
 * This is deliberately a small regex parser over a known subset rather than a
 * general XML parser. It is read-only, best-effort, and every limit it hits is
 * reported to the caller instead of throwing.
 */

const { readZipEntries, decodeXmlText, findEntry } = require('./zip-read.cjs');

// A preview is for reading, not for computing. These caps keep a pathological
// sheet (a million rows) from turning into a multi-megabyte IPC payload.
const MAX_SHEETS = 20;
const MAX_ROWS = 2000;
const MAX_COLS = 200;
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const itemRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let match;
  while ((match = itemRe.exec(xml)) !== null) {
    // A rich-text run splits the string across several <t>; concatenate them.
    const parts = [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXmlText(m[1]));
    out.push(parts.join(''));
  }
  return out;
}

function columnIndexFromRef(ref) {
  const letters = /^([A-Z]+)/.exec(ref)?.[1];
  if (!letters) return 0;
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

/** One worksheet's rows, as a sparse grid of `{ text, formula }`. */
function parseSheet(xml, sharedStrings) {
  const rows = [];
  let maxCol = 0;
  let truncatedRows = false;

  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(xml)) !== null) {
    // A row may omit r=; its position is then its order, which is what we use
    // for rendering anyway. Emitting rows in document order is correct either
    // way — only blank-row padding would differ, and blank rows are dropped.
    const cells = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
      const attrs = cellMatch[1] ?? '';
      const body = cellMatch[2] ?? '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const col = ref ? columnIndexFromRef(ref) : cells.length;
      if (col >= MAX_COLS) continue;

      const formula = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(body)?.[1];
      const valueMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
      let text = '';

      if (type === 'inlineStr') {
        text = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXmlText(m[1])).join('');
      } else if (type === 's') {
        const index = Number(valueMatch?.[1]);
        text = Number.isInteger(index) ? (sharedStrings[index] ?? '') : '';
      } else if (valueMatch) {
        text = decodeXmlText(valueMatch[1]);
      }

      cells[col] = {
        text,
        // Reported separately so the pane can show `=B2-C2` where Excel shows a
        // number. A cell with a formula and no cached value is exactly what the
        // CLI's own create_xlsx produces.
        formula: formula ? `=${decodeXmlText(formula)}` : undefined,
      };
      if (col + 1 > maxCol) maxCol = col + 1;
    }
    rows.push(cells);
    if (rows.length >= MAX_ROWS) { truncatedRows = true; break; }
  }

  const usedCols = Math.max(maxCol, ...rows.map((row) => row.length), 0);
  return { rows, maxCol: Math.min(usedCols, MAX_COLS), truncatedRows };
}

/**
 * Parse a workbook.
 *
 * Returns `{ ok: true, sheets, truncated }` or `{ ok: false, error }`. Sheets
 * are in workbook order with their display names, matched to their part through
 * the workbook relationships, because `sheet1.xml` is NOT reliably the first
 * sheet once a workbook has been reordered in Excel.
 */
function parseXlsx(buffer) {
  let entries;
  try {
    entries = readZipEntries(buffer, { maxInflatedBytes: MAX_INFLATED_BYTES });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (entries.size === 0) return { ok: false, error: '工作簿为空或无法解压' };

  const sharedStrings = parseSharedStrings(findEntry(entries, 'xl/sharedStrings.xml', 'sharedStrings.xml'));

  const workbookXml = findEntry(entries, 'xl/workbook.xml', 'workbook.xml');
  const relsXml = findEntry(entries, 'xl/_rels/workbook.xml.rels', '_rels/workbook.xml.rels');

  // rId → part name, from the relationships file.
  const relTargets = new Map();
  if (relsXml) {
    for (const match of relsXml.toString('utf8').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
      const id = /\bId="([^"]+)"/.exec(match[1])?.[1];
      const target = /\bTarget="([^"]+)"/.exec(match[1])?.[1];
      if (id && target) relTargets.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''));
    }
  }

  const sheets = [];
  if (workbookXml) {
    for (const match of workbookXml.toString('utf8').matchAll(/<sheet\b([^>]*)\/?>/g)) {
      const name = decodeXmlText(/\bname="([^"]*)"/.exec(match[1])?.[1] ?? '');
      const rid = /\br:id="([^"]+)"/.exec(match[1])?.[1];
      const target = rid ? relTargets.get(rid) : undefined;
      const part = findEntry(
        entries,
        target ? `xl/${target}` : '',
        target ?? '',
        `xl/worksheets/sheet${sheets.length + 1}.xml`,
      );
      if (!part) continue;
      const parsed = parseSheet(part.toString('utf8'), sharedStrings);
      sheets.push({ name: name || `工作表${sheets.length + 1}`, ...parsed });
      if (sheets.length >= MAX_SHEETS) break;
    }
  }

  // No workbook.xml (or no readable relationships): fall back to whatever
  // worksheet parts exist, so a slightly odd file still previews.
  if (sheets.length === 0) {
    for (const [name, value] of entries) {
      if (!/^xl\/worksheets\/.*\.xml$/i.test(name)) continue;
      const parsed = parseSheet(value.toString('utf8'), sharedStrings);
      sheets.push({ name: `工作表${sheets.length + 1}`, ...parsed });
      if (sheets.length >= MAX_SHEETS) break;
    }
  }

  if (sheets.length === 0) return { ok: false, error: '工作簿里没有可读的工作表' };
  const truncated = sheets.some((sheet) => sheet.truncatedRows);
  return { ok: true, sheets, truncated };
}

module.exports = { parseXlsx, decodeXmlText, MAX_ROWS, MAX_COLS, MAX_SHEETS };
