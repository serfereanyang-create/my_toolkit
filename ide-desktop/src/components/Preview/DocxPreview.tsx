import React, { useEffect, useRef, useState } from 'react';
import type { PreviewTab } from '../../types';
import type { AppAction } from '../../lib/state';
import { desktop } from '../../lib/ipc';
import { FileText } from 'lucide-react';

type Props = { tab: PreviewTab; dispatch: React.Dispatch<AppAction>; workspaceRoot: string };

export function DocxPreview({ tab, dispatch, workspaceRoot }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setError(null);

    async function render() {
      try {
        const result = await desktop.preview.readDocx(
          tab.descriptor.relativePath,
          (tab.descriptor as { token: string }).token,
        );
        if (cancelled) return;
        if (!result.ok || !result.buffer) {
          setError(result.error ?? '无法读取文件');
          return;
        }

        // docx-preview is a browser library loaded via dynamic import
        const { renderAsync } = await import('docx-preview');
        if (!containerRef.current || cancelled) return;
        containerRef.current.innerHTML = '';

        const arrayBuf = result.buffer instanceof ArrayBuffer
          ? result.buffer
          : new Uint8Array(result.buffer as unknown as ArrayBufferLike).buffer;

        await renderAsync(arrayBuf, containerRef.current, undefined, {
          className:        'docx-preview-doc',
          inWrapper:        true,
          ignoreWidth:      false,
          ignoreHeight:     false,
          ignoreFonts:      false,
          breakPages:       true,
          useBase64URL:     false,
          renderChanges:    false,
          renderHeaders:    true,
          renderFooters:    true,
          renderFootnotes:  true,
          renderEndnotes:   true,
          experimental:     false,
        });
        if (!cancelled) {
          setLoaded(true);
          dispatch({ type: 'preview/update', id: tab.id, patch: { status: 'ready' } });
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          setError(msg);
          dispatch({ type: 'preview/update', id: tab.id, patch: { status: 'error', error: msg } });
        }
      }
    }

    void render();
    return () => { cancelled = true; };
  }, [tab.descriptor.relativePath, tab.descriptor.relativePath]);

  if (error) {
    return (
      <div className="preview-error" role="alert">
        <FileText size={36} opacity={0.3} />
        <p>无法渲染文档</p>
        <p className="preview-error-detail">{error}</p>
      </div>
    );
  }

  return (
    <div
      className={`docx-preview-wrapper ${tab.fitWidth ? 'fit-width' : ''}`}
      style={tab.fitWidth ? {} : { zoom: tab.zoom }}
    >
      {!loaded && <div className="preview-spinner" aria-label="渲染文档…" />}
      <div ref={containerRef} className="docx-preview-container" />
    </div>
  );
}
