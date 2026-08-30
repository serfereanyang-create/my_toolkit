import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronLeft, ChevronRight, RefreshCw, ZoomIn, ZoomOut, Maximize2,
  ExternalLink, X, PanelRightClose, FileImage, FileText, Globe, File,
} from 'lucide-react';
import type { PreviewTab } from '../../types';
import type { AppAction } from '../../lib/state';
import type { PreviewGuestState } from '../../lib/ipc';
import { desktop } from '../../lib/ipc';
import { ImagePreview } from './ImagePreview';
import { DocxPreview } from './DocxPreview';
import { RuntimeStatus } from './RuntimeStatus';

type Props = {
  open: boolean;
  width: number;
  tabs: PreviewTab[];
  activeTabId: string | null;
  dispatch: React.Dispatch<AppAction>;
  workspaceRoot: string;
};

const KIND_ICONS: Record<string, React.ReactNode> = {
  image: <FileImage size={13} />,
  pdf:   <File size={13} />,
  docx:  <FileText size={13} />,
  html:  <Globe size={13} />,
  web:   <Globe size={13} />,
};

export function PreviewSidebar({ open, width, tabs, activeTabId, dispatch, workspaceRoot }: Props) {
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const viewportRef = useRef<HTMLDivElement>(null);

  // ── Guest state from native WebContentsView ─────────────────────────────────
  const [guestState, setGuestState] = useState<PreviewGuestState>({});

  useEffect(() => {
    return desktop.preview.onState((s) => {
      setGuestState((prev) => ({ ...prev, ...s }));
      if (s.canGoBack !== undefined || s.canGoForward !== undefined) {
        if (activeTabId) {
          dispatch({ type: 'preview/update', id: activeTabId, patch: {
            canGoBack: s.canGoBack,
            canGoForward: s.canGoForward,
          }});
        }
      }
      if (s.loading !== undefined && activeTabId) {
        dispatch({ type: 'preview/update', id: activeTabId, patch: { status: s.loading ? 'loading' : 'ready' } });
      }
      if (s.error && activeTabId) {
        dispatch({ type: 'preview/update', id: activeTabId, patch: { status: 'error', error: s.error } });
      }
      if (s.externalLinkRequest) {
        // Forward external link to native system browser after user confirmation
        void desktop.preview.openExternal(s.externalLinkRequest);
      }
    });
  }, [activeTabId, dispatch]);

  // ── Bounds reporting for native WebContentsView ──────────────────────────────
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const isWebKind = activeTab?.kind === 'pdf' || activeTab?.kind === 'html' || activeTab?.kind === 'web';
    if (!isWebKind) { void desktop.preview.hide(); return; }

    const report = () => {
      const rect = el.getBoundingClientRect();
      void desktop.preview.setBounds({
        x:      Math.round(rect.left),
        y:      Math.round(rect.top),
        width:  Math.round(rect.width),
        height: Math.round(rect.height),
      });
    };
    const ro = new ResizeObserver(report);
    ro.observe(el);
    report();
    return () => ro.disconnect();
  }, [activeTab?.kind]);

  // Hide native view when sidebar closes or active tab changes away from web
  useEffect(() => {
    const isWebKind = activeTab?.kind === 'pdf' || activeTab?.kind === 'html' || activeTab?.kind === 'web';
    if (!open || !isWebKind) void desktop.preview.hide();
  }, [open, activeTab?.kind]);

  // ── Resize handle ────────────────────────────────────────────────────────────
  const dragging = useRef(false);
  const startX   = useRef(0);
  const startW   = useRef(0);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    startX.current   = e.clientX;
    startW.current   = width;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [width]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const delta = startX.current - e.clientX;
    dispatch({ type: 'preview/setWidth', width: startW.current + delta });
  }, [dispatch]);

  const onPointerUp = useCallback(() => { dragging.current = false; }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft')  dispatch({ type: 'preview/setWidth', width: width - 20 });
    if (e.key === 'ArrowRight') dispatch({ type: 'preview/setWidth', width: width + 20 });
  }, [width, dispatch]);

  function closeTab(id: string) {
    const tab = tabs.find((t) => t.id === id);
    const token = (tab?.descriptor as { token?: string } | undefined)?.token;
    if (token) void desktop.preview.stopPreview(token);
    dispatch({ type: 'preview/close', id });
  }

  if (!open || tabs.length === 0) return null;

  return (
    <>
      {/* Drag handle */}
      <div
        className="preview-resize-handle"
        role="separator"
        aria-label="调整预览宽度"
        aria-orientation="vertical"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
      />

      {/* Sidebar panel */}
      <aside className="preview-sidebar" style={{ width }} aria-label="预览">
        {/* Tab bar */}
        <div className="preview-tabbar">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`preview-tab ${t.id === activeTabId ? 'active' : ''}`}
              title={t.title}
              onClick={() => dispatch({ type: 'preview/activate', id: t.id })}
            >
              {KIND_ICONS[t.kind] ?? <File size={13} />}
              <span className="preview-tab-label">{t.title}</span>
              <span
                role="button"
                aria-label={`关闭 ${t.title}`}
                className="preview-tab-close"
                onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
              ><X size={11} /></span>
            </button>
          ))}
          <button
            className="preview-sidebar-close icon-btn"
            title="关闭预览栏"
            onClick={() => dispatch({ type: 'preview/toggle' })}
          ><PanelRightClose size={14} /></button>
        </div>

        {/* Toolbar */}
        {activeTab && <Toolbar tab={activeTab} dispatch={dispatch} guestState={guestState} />}

        {/* Viewport */}
        <div className="preview-viewport" ref={viewportRef}>
          {activeTab && (
            <PreviewContent
              tab={activeTab}
              dispatch={dispatch}
              workspaceRoot={workspaceRoot}
            />
          )}
        </div>
      </aside>
    </>
  );
}

function Toolbar({ tab, dispatch, guestState }: { tab: PreviewTab; dispatch: React.Dispatch<AppAction>; guestState: PreviewGuestState }) {
  const isWeb = tab.kind === 'pdf' || tab.kind === 'html' || tab.kind === 'web';
  return (
    <div className="preview-toolbar">
      {isWeb && <>
        <button className="icon-btn" title="后退"   disabled={!tab.canGoBack}    onClick={() => void desktop.preview.back()}>   <ChevronLeft  size={15} /></button>
        <button className="icon-btn" title="前进"   disabled={!tab.canGoForward} onClick={() => void desktop.preview.forward()}><ChevronRight size={15} /></button>
        <button className="icon-btn" title="刷新"   onClick={() => void desktop.preview.reload()}><RefreshCw size={14} /></button>
        {guestState.loading && <span className="preview-loading-dot" aria-label="加载中" />}
      </>}
      {!isWeb && <>
        <button className="icon-btn" title="缩小"   onClick={() => dispatch({ type: 'preview/update', id: tab.id, patch: { zoom: Math.max(0.25, tab.zoom - 0.25) } })}><ZoomOut    size={14} /></button>
        <span className="preview-zoom-label">{Math.round(tab.zoom * 100)}%</span>
        <button className="icon-btn" title="放大"   onClick={() => dispatch({ type: 'preview/update', id: tab.id, patch: { zoom: Math.min(4, tab.zoom + 0.25) } })}><ZoomIn     size={14} /></button>
        <button className="icon-btn" title="适应宽度" onClick={() => dispatch({ type: 'preview/update', id: tab.id, patch: { fitWidth: !tab.fitWidth } })}><Maximize2  size={14} /></button>
      </>}
      <span className="preview-toolbar-spacer" />
      <button className="icon-btn" title="在系统中打开" onClick={() => {
        const webUrl = tab.webUrl;
        if (webUrl) void desktop.preview.openExternal(webUrl);
      }}><ExternalLink size={13} /></button>
    </div>
  );
}

function PreviewContent({ tab, dispatch, workspaceRoot }: { tab: PreviewTab; dispatch: React.Dispatch<AppAction>; workspaceRoot: string }) {
  if (tab.status === 'error') {
    return (
      <div className="preview-error" role="alert">
        <p>无法加载预览</p>
        <p className="preview-error-detail">{tab.error}</p>
      </div>
    );
  }

  switch (tab.kind) {
    case 'image':
      return <ImagePreview tab={tab} />;
    case 'docx':
      return <DocxPreview tab={tab} dispatch={dispatch} workspaceRoot={workspaceRoot} />;
    case 'doc_unsupported':
      return (
        <div className="preview-unsupported">
          <FileText size={40} opacity={0.3} />
          <p>不支持旧版 .doc 格式直接预览</p>
          <button className="btn-secondary" onClick={() => void desktop.preview.openExternal(tab.descriptor.absolutePath)}>
            用系统应用打开
          </button>
        </div>
      );
    case 'html':
    case 'web':
      return <RuntimeStatus tab={tab} dispatch={dispatch} workspaceRoot={workspaceRoot} />;
    case 'pdf':
      // PDF rendered in native WebContentsView — viewport div is sized by ResizeObserver
      return tab.status === 'loading'
        ? <div className="preview-spinner" aria-label="加载 PDF…" />
        : null;
    default:
      return <div className="preview-empty">不支持预览此类型文件</div>;
  }
}
