import React, { useEffect, useState } from 'react';
import { FileSliders } from 'lucide-react';
import type { PreviewTab } from '../../types';
import type { AppAction } from '../../lib/state';
import type { ParsedDeck } from '../../lib/ipc';
import { desktop } from '../../lib/ipc';
import { PptxBody } from './pptx-view';

/*
 * The .pptx pane — the fetching half; the presentation itself is rendered by
 * pptx-view.tsx, which explains why it shows content rather than slide layout.
 */

type Props = { tab: PreviewTab; dispatch: React.Dispatch<AppAction> };

export function PptxPreview({ tab, dispatch }: Props) {
  const [deck, setDeck] = useState<ParsedDeck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNotes, setShowNotes] = useState(true);

  const relativePath = tab.descriptor.relativePath;
  const token = (tab.descriptor as { token?: string }).token ?? '';
  const revision = tab.revision ?? 0;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const result = await desktop.preview.readPptx(relativePath, token);
        if (cancelled) return;
        if (!result.ok || !result.deck) {
          const message = result.error ?? '无法读取演示文稿';
          setError(message);
          dispatch({ type: 'preview/update', id: tab.id, patch: { status: 'error', error: message } });
          return;
        }
        setDeck(result.deck);
        setError(null);
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
        <FileSliders size={36} opacity={0.3} />
        <p>无法读取演示文稿</p>
        <p className="preview-error-detail">{error}</p>
      </div>
    );
  }

  if (!deck) return <div className="preview-spinner" aria-label="读取演示文稿…" />;

  return (
    <PptxBody
      deck={deck}
      showNotes={showNotes}
      onToggleNotes={() => setShowNotes((v) => !v)}
      fitWidth={tab.fitWidth}
      zoom={tab.zoom}
    />
  );
}
