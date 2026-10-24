import React, { useEffect, useState } from 'react';
import { FileSpreadsheet } from 'lucide-react';
import type { PreviewTab } from '../../types';
import type { AppAction } from '../../lib/state';
import type { ParsedWorkbook } from '../../lib/ipc';
import { desktop } from '../../lib/ipc';
import { XlsxBody } from './xlsx-view';

/*
 * The .xlsx pane.
 *
 * The workbook is parsed in the main process (electron/xlsx-read.cjs) and
 * arrives as a plain grid, so nothing here touches the file — which also means a
 * 20 MB workbook cannot stall the window, since only a capped number of rows and
 * columns of each sheet is ever sent.
 *
 * What the grid looks like lives in xlsx-view.tsx; this half only fetches.
 */

type Props = { tab: PreviewTab; dispatch: React.Dispatch<AppAction> };

export function XlsxPreview({ tab, dispatch }: Props) {
  const [workbook, setWorkbook] = useState<ParsedWorkbook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [showFormulas, setShowFormulas] = useState(false);

  const relativePath = tab.descriptor.relativePath;
  const token = (tab.descriptor as { token?: string }).token ?? '';
  // Re-reading is driven by `tab.revision`, which the parent bumps when the file
  // changes on disk. Without it in the deps the pane would keep showing the
  // bytes the agent just replaced.
  const revision = tab.revision ?? 0;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const result = await desktop.preview.readXlsx(relativePath, token);
        if (cancelled) return;
        if (!result.ok || !result.workbook) {
          const message = result.error ?? '无法读取工作簿';
          setError(message);
          dispatch({ type: 'preview/update', id: tab.id, patch: { status: 'error', error: message } });
          return;
        }
        setWorkbook(result.workbook);
        setError(null);
        // Keep the current sheet across a refresh, but fall back to the first if
        // the sheet was removed.
        setSheetIndex((current) => (current < result.workbook!.sheets.length ? current : 0));
        dispatch({ type: 'preview/update', id: tab.id, patch: { status: 'ready' } });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        dispatch({ type: 'preview/update', id: tab.id, patch: { status: 'error', error: message } });
      }
    }
    void load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relativePath, token, revision]);

  if (error) {
    return (
      <div className="preview-error" role="alert">
        <FileSpreadsheet size={36} opacity={0.3} />
        <p>无法读取表格</p>
        <p className="preview-error-detail">{error}</p>
      </div>
    );
  }

  if (!workbook) return <div className="preview-spinner" aria-label="读取表格…" />;

  return (
    <XlsxBody
      workbook={workbook}
      sheetIndex={sheetIndex}
      onSelectSheet={setSheetIndex}
      showFormulas={showFormulas}
      onToggleFormulas={() => setShowFormulas((v) => !v)}
      fitWidth={tab.fitWidth}
      zoom={tab.zoom}
    />
  );
}
