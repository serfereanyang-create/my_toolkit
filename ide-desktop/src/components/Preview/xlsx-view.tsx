import { Table2 } from 'lucide-react';
import type { ParsedSheet, ParsedWorkbook } from '../../lib/ipc';

/*
 * The rendered spreadsheet, as a pure component.
 *
 * This is split from XlsxPreview.tsx — which fetches over IPC — for the same
 * reason the project's other panels keep their presentational halves separate:
 * everything that decides what the user actually sees can then be rendered in a
 * plain `renderToStaticMarkup` test, with no preload bridge and no DOM.
 *
 * A cell with a formula and no cached value is the case worth calling out. The
 * CLI's own create_xlsx writes formulas as `<f>` with no `<v>`, so the file on
 * disk genuinely contains no value for those cells — Excel has not computed them
 * yet. Showing the formula text is the honest rendering: it says "this is a
 * formula" instead of showing an empty cell, which would read as "the agent
 * wrote nothing here".
 */

export const MAX_RENDERED_ROWS = 400;
export const MAX_RENDERED_COLS = 40;

export function XlsxBody({
  workbook, sheetIndex, onSelectSheet, showFormulas, onToggleFormulas, fitWidth, zoom,
}: {
  workbook: ParsedWorkbook;
  sheetIndex: number;
  onSelectSheet: (index: number) => void;
  showFormulas: boolean;
  onToggleFormulas: () => void;
  fitWidth: boolean;
  zoom: number;
}) {
  const sheet = workbook.sheets[sheetIndex];
  if (!sheet) return <div className="preview-empty">工作簿里没有工作表</div>;

  const colCount = Math.min(Math.max(sheet.maxCol, 1), MAX_RENDERED_COLS);
  const rowCount = Math.min(sheet.rows.length, MAX_RENDERED_ROWS);

  return (
    <div className={`xlsx-preview ${fitWidth ? 'fit-width' : ''}`} style={fitWidth ? {} : { zoom }}>
      <div className="xlsx-toolbar">
        <div className="xlsx-sheets" role="tablist" aria-label="工作表">
          {workbook.sheets.map((s, index) => (
            <button
              key={`${s.name}-${index}`}
              role="tab"
              aria-selected={index === sheetIndex}
              className={`xlsx-sheet-tab ${index === sheetIndex ? 'active' : ''}`}
              onClick={() => onSelectSheet(index)}
            >{s.name}</button>
          ))}
        </div>
        <button
          className={`icon-btn ${showFormulas ? 'active' : ''}`}
          title={showFormulas ? '显示计算结果' : '显示公式'}
          aria-pressed={showFormulas}
          onClick={onToggleFormulas}
        ><Table2 size={13} /></button>
      </div>

      <div className="xlsx-grid-wrap">
        <table className="xlsx-grid">
          <thead>
            <tr>
              <th className="xlsx-corner" />
              {Array.from({ length: colCount }, (_, col) => (
                <th key={col} className="xlsx-col-head">{columnName(col)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rowCount }, (_, row) => (
              <tr key={row}>
                <th className="xlsx-row-head">{row + 1}</th>
                {Array.from({ length: colCount }, (_, col) => {
                  const cell = sheet.rows[row]?.[col];
                  return <GridCell key={col} cell={cell} showFormula={showFormulas} />;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(sheet.rows.length > MAX_RENDERED_ROWS || sheet.maxCol > MAX_RENDERED_COLS || sheet.truncatedRows) && (
        <p className="xlsx-note" role="note">
          表格较大，仅显示前 {rowCount} 行、{colCount} 列。
        </p>
      )}
    </div>
  );
}

/** One cell. The decision it makes: formula text, or the cell's value. */
export function GridCell({ cell, showFormula }: { cell: ParsedSheet['rows'][number][number]; showFormula: boolean }) {
  if (!cell) return <td className="xlsx-cell empty" />;
  const formula = cell.formula;
  const text = showFormula && formula ? formula : cell.text;
  // A formula with no cached value has empty `text`; mark it so the pane can
  // style it as a formula rather than as a blank cell.
  const formulaOnly = !cell.text && !!formula;
  return (
    <td
      className={`xlsx-cell${formula ? ' has-formula' : ''}${formulaOnly ? ' formula-only' : ''}`}
      title={formulaOnly && !showFormula ? `公式：${formula}（尚未计算）` : undefined}
    >{text}</td>
  );
}

/** 0 → A, 25 → Z, 26 → AA. */
export function columnName(index: number): string {
  let name = '';
  let n = index;
  while (n >= 0) {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  }
  return name;
}
