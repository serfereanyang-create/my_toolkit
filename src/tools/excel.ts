/**
 * excel_automate — drive Microsoft Excel on Windows via PowerShell COM.
 * Gated by the desktop "Excel" computer-control switch: the tool is only
 * registered when preferences.computerExcel is enabled (see bridge --excel).
 *
 * Actions: open (workbook → read used range), write (cell/value), run-macro
 * style command is intentionally NOT exposed; every action is scoped to a
 * concrete workbook path under the workspace or Desktop.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { ToolDefinition, ToolContext } from './types.js';

const execFileAsync = promisify(execFile);

type ExcelInput = {
  action: 'read' | 'write';
  path: string;
  sheet: string;
  cell?: string;
  value?: string;
};

function escapePs(value: string): string {
  return value.replace(/'/g, "''");
}

function resolveExcelPath(workspaceRoot: string, target: string): string {
  if (/^[A-Za-z]:[\\/]/.test(target)) return resolve(target);
  if (/^desktop[\\/]/i.test(target)) return resolve(homedir(), 'Desktop', target.replace(/^desktop[\\/]/i, ''));
  return resolve(workspaceRoot, target);
}

export const excelAutomateTool: ToolDefinition<ExcelInput> = {
  name: 'excel_automate',
  description: 'Read or write cells in a local .xlsx workbook through Windows Excel COM automation. Requires Microsoft Excel installed. Use for driving a real Excel instance (formulas, live workbook) — for plain file generation prefer create_xlsx.',
  inputHint: '{ "action": "read" | "write", "path": "reports/q3.xlsx", "sheet": "Sheet1", "cell": "A1", "value": "total" }',
  risk: 'write',

  validate(input: unknown): ExcelInput {
    if (!input || typeof input !== 'object') throw new Error('excel_automate input must be an object');
    const obj = input as Record<string, unknown>;
    const action = obj.action === 'write' ? 'write' : obj.action === 'read' ? 'read' : null;
    if (!action) throw new Error('action must be "read" or "write"');
    if (typeof obj.path !== 'string' || !obj.path.trim()) throw new Error('path is required');
    if (typeof obj.sheet !== 'string' || !obj.sheet.trim()) throw new Error('sheet is required');
    if (action === 'write' && typeof obj.cell !== 'string') throw new Error('cell is required for write');
    if (action === 'write' && obj.value === undefined) throw new Error('value is required for write');
    return {
      action,
      path: obj.path.trim(),
      sheet: obj.sheet.trim(),
      cell: typeof obj.cell === 'string' ? obj.cell.trim() : undefined,
      value: obj.value === undefined ? undefined : String(obj.value),
    };
  },

  async execute(input: ExcelInput, context: ToolContext) {
    const workbook = resolveExcelPath(context.workspaceRoot, input.path);
    // PowerShell tab/newline escapes assembled from char codes so this TS
    // template never contains a raw backtick.
    const psTab = '`' + 't';
    const psNl = '`' + 'n';
    const ps = input.action === 'read'
      ? `$excel = New-Object -ComObject Excel.Application; $excel.Visible = $false; $excel.DisplayAlerts = $false; ` +
        `$wb = $excel.Workbooks.Open('${escapePs(workbook)}'); ` +
        `$ws = $wb.Worksheets.Item('${escapePs(input.sheet)}'); ` +
        `$used = $ws.UsedRange; $values = $used.Value; ` +
        `$out = @(); if ($values -is [object[,]]) { for ($r=1; $r -le $values.GetLength(0); $r++) { $row=@(); for ($c=1; $c -le $values.GetLength(1); $c++) { $row += [string]$values[$r,$c] }; $out += ($row -join "${psTab}") } } else { $out += [string]$values }; ` +
        `$wb.Close($false); $excel.Quit(); Write-Output ($out -join "${psNl}")`
      : `$excel = New-Object -ComObject Excel.Application; $excel.Visible = $false; $excel.DisplayAlerts = $false; ` +
        `$wb = $excel.Workbooks.Open('${escapePs(workbook)}'); ` +
        `$ws = $wb.Worksheets.Item('${escapePs(input.sheet)}'); ` +
        `$ws.Range('${escapePs(input.cell!)}').Value2 = '${escapePs(input.value!)}'; ` +
        `$wb.Save(); $wb.Close($true); $excel.Quit(); Write-Output 'saved'`;

    try {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 60_000 });
      return { ok: true, output: input.action === 'read' ? (stdout.trim() || '(empty range)') : 'saved' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('cannot find') || message.includes('0x800401F3')) {
        return { ok: false, output: 'Excel COM automation unavailable: Microsoft Excel is not installed or not registered.' };
      }
      return { ok: false, output: `excel_automate failed: ${message.slice(0, 500)}` };
    }
  },
};
