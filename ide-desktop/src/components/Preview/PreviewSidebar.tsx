import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronLeft, ChevronRight, RefreshCw, ZoomIn, ZoomOut, Maximize2,
  ExternalLink, X, PanelRightClose, FileImage, FileText, Globe, File,
  FileSpreadsheet, FileSliders, LayoutGrid, Square, Eye,
} from 'lucide-react';
import type { PreviewFileDescriptor, PreviewKind, PreviewLayout, PreviewTab } from '../../types';
import type { AppAction } from '../../lib/state';
import type { PreviewGuestState } from '../../lib/ipc';
import { desktop } from '../../lib/ipc';
import { ImagePreview } from './ImagePreview';
import { DocxPreview } from './DocxPreview';
import { XlsxPreview } from './XlsxPreview';
import { PptxPreview } from './PptxPreview';
import { RuntimeStatus } from './RuntimeStatus';
import { ConfirmDialog } from '../ConfirmDialog';
import { nextPreviewTabId } from '../../lib/previewNavigation';

type Props = {
  open: boolean;
  width: number;
  tabs: PreviewTab[];
  activeTabId: string | null;
  layout: PreviewLayout;
  dispatch: React.Dispatch<AppAction>;
  workspaceRoot: string;
};

const KIND_ICONS: Record<string, React.ReactNode> = {
  image: <FileImage size={13} />,
  pdf:   <File size={13} />,
  docx:  <FileText size={13} />,
  xlsx:  <FileSpreadsheet size={13} />,
  pptx:  <FileSliders size={13} />,
  html:  <Globe size={13} />,
  web:   <Globe size={13} />,
};

/**
 * Kinds that render in the DOM, and so can be tiled.
 *
 * The others go through the single native `WebContentsView` the preview service
 * owns, and there is exactly one of it. See `isNativeKind` below for what that
 * means for a grid.
 */
function isNativeKind(kind: PreviewKind): boolean {
  return kind === 'pdf' || kind === 'html' || kind === 'web';
}

export function PreviewSidebar({ open, width, tabs, activeTabId, layout, dispatch, workspaceRoot }: Props) {
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const viewportRef = useRef<HTMLDivElement>(null);
  const grid = layout === 'grid';

  // ── Guest state from native WebContentsView ─────────────────────────────────
  const [guestState, setGuestState] = useState<PreviewGuestState>({});
  // In grid mode several panes are on screen but only one native view exists, so
  // the pane that "owns" it is chosen explicitly rather than being whichever tab
  // happens to be active.
  const [nativeTabId, setNativeTabId] = useState<string | null>(null);
  const [externalLink, setExternalLink] = useState<string | null>(null);

  const nativeTab = grid
    ? tabs.find((t) => t.id === nativeTabId) ?? null
    : activeTab;
  const nativeKindTab = nativeTab && isNativeKind(nativeTab.kind) ? nativeTab : null;

  useEffect(() => {
    return desktop.preview.onState((s) => {
      setGuestState((prev) => ({ ...prev, ...s }));
      const target = grid ? nativeTabId : activeTabId;
      if (!target) return;
      if (s.canGoBack !== undefined || s.canGoForward !== undefined) {
        dispatch({ type: 'preview/update', id: target, patch: {
          canGoBack: s.canGoBack,
          canGoForward: s.canGoForward,
        }});
      }
      if (s.loading !== undefined) {
        dispatch({ type: 'preview/update', id: target, patch: { status: s.loading ? 'loading' : 'ready' } });
      }
      if (s.error) {
        dispatch({ type: 'preview/update', id: target, patch: { status: 'error', error: s.error } });
      }
      if (s.externalLinkRequest) setExternalLink(s.externalLinkRequest);
    });
  }, [activeTabId, dispatch, grid, nativeTabId]);

  // ── Bounds reporting for native WebContentsView ──────────────────────────────
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    if (!nativeKindTab) { void desktop.preview.hide(); return; }

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
  }, [nativeKindTab?.id, nativeKindTab?.kind]);

  // Hide native view when sidebar closes or no native pane is on screen
  useEffect(() => {
    if (!open || !nativeKindTab) void desktop.preview.hide();
  }, [open, nativeKindTab?.id, nativeKindTab?.kind]);

  useEffect(() => {
    if (!open || !nativeKindTab) return;
    if (nativeKindTab.kind === 'pdf' || nativeKindTab.kind === 'html') {
      const descriptor = nativeKindTab.descriptor as PreviewFileDescriptor;
      const relative = descriptor.relativePath.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
      void desktop.preview.show(`yoycode-preview://${descriptor.token}/${relative}`);
    } else if (nativeKindTab.kind === 'web' && nativeKindTab.webUrl) {
      void desktop.preview.show(nativeKindTab.webUrl, nativeKindTab.allowedPort);
    }
  }, [open, nativeKindTab?.id, nativeKindTab?.webUrl, nativeKindTab?.descriptor.token, nativeKindTab?.revision]);

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
    if (nativeTabId === id) setNativeTabId(null);
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
      <aside className={`preview-sidebar ${grid ? 'grid-layout' : ''}`} style={{ width }} aria-label="预览">
        {/* Tab bar */}
        <div className="preview-tabbar" role="tablist" aria-label="预览标签">
          {tabs.map((t) => (
            <div
              key={t.id}
              className={`preview-tab ${t.id === activeTabId ? 'active' : ''}`}
              role="tab"
              tabIndex={t.id === activeTabId ? 0 : -1}
              aria-selected={t.id === activeTabId}
              title={t.title}
              onClick={() => dispatch({ type: 'preview/activate', id: t.id })}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); dispatch({ type: 'preview/activate', id: t.id }); }
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
                  event.preventDefault();
                  const next = nextPreviewTabId(tabs.map((tab) => tab.id), t.id, event.key);
                  if (!next) return;
                  dispatch({ type: 'preview/activate', id: next });
                  window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-preview-tab-id="${CSS.escape(next)}"]`)?.focus());
                }
              }}
              data-preview-tab-id={t.id}
            >
              {KIND_ICONS[t.kind] ?? <File size={13} />}
              <span className="preview-tab-label">{t.title}</span>
              <button
                type="button"
                tabIndex={0}
                aria-label={`关闭 ${t.title}`}
                className="preview-tab-close"
                onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); closeTab(t.id); }
                }}
              ><X size={11} /></button>
            </div>
          ))}
          <button type="button"
            className={`preview-sidebar-close icon-btn ${grid ? 'active' : ''}`}
            title={grid ? '切换为单窗口' : '切换为平铺多窗口'}
            aria-pressed={grid}
            onClick={() => dispatch({ type: 'preview/setLayout', layout: grid ? 'single' : 'grid' })}
          >{grid ? <Square size={14} /> : <LayoutGrid size={14} />}</button>
          <button type="button"
            className="preview-sidebar-close icon-btn"
            title="关闭预览栏"
            onClick={() => dispatch({ type: 'preview/toggle' })}
          ><PanelRightClose size={14} /></button>
        </div>

        {grid ? (
          <div className="preview-grid">
            {tabs.map((t) => (
              <GridPane
                key={t.id}
                tab={t}
                isActive={t.id === activeTabId}
                nativeTabId={nativeTabId}
                viewportRef={t.id === nativeTabId ? viewportRef : undefined}
                dispatch={dispatch}
                workspaceRoot={workspaceRoot}
                guestState={guestState}
                onActivate={() => dispatch({ type: 'preview/activate', id: t.id })}
                onShowNative={() => setNativeTabId(t.id)}
                onClose={() => closeTab(t.id)}
              />
            ))}
          </div>
        ) : (
          <>
            {/* Toolbar */}
            {activeTab && <Toolbar tab={activeTab} dispatch={dispatch} guestState={guestState} />}

            {/* Viewport */}
            <div className="preview-viewport" ref={viewportRef}>
              {activeTab && (
                <PreviewContent
                  key={`${activeTab.id}:${activeTab.revision ?? 0}`}
                  tab={activeTab}
                  dispatch={dispatch}
                  workspaceRoot={workspaceRoot}
                />
              )}
            </div>
          </>
        )}
      </aside>
      <ConfirmDialog
        open={externalLink !== null}
        title="打开外部链接？"
        message={`预览页面请求在系统浏览器中打开：\n${externalLink ?? ''}`}
        confirmLabel="打开链接"
        onConfirm={() => { const url = externalLink; setExternalLink(null); if (url) void desktop.preview.openExternal(url); }}
        onCancel={() => setExternalLink(null)}
      />
    </>
  );
}

/**
 * One tile in the grid.
 *
 * Each pane is keyed on its revision by the parent, so a file change remounts
 * just that tile. Native panes (pdf/html/web) cannot be tiled — the preview
 * service owns a single `WebContentsView` — so a tile in that state shows a
 * button that assigns the view to it, and only the assigned tile gets the
 * viewport element the bounds are measured from.
 */
function GridPane({
  tab, isActive, nativeTabId, viewportRef, dispatch, workspaceRoot, guestState, onActivate, onShowNative, onClose,
}: {
  tab: PreviewTab;
  isActive: boolean;
  nativeTabId: string | null;
  viewportRef?: React.RefObject<HTMLDivElement>;
  dispatch: React.Dispatch<AppAction>;
  workspaceRoot: string;
  guestState: PreviewGuestState;
  onActivate: () => void;
  onShowNative: () => void;
  onClose: () => void;
}) {
  const native = isNativeKind(tab.kind);
  const ownsNativeView = native && tab.id === nativeTabId;

  return (
    <section
      className={`preview-grid-pane ${isActive ? 'active' : ''}`}
      aria-label={tab.title}
      onMouseDown={onActivate}
      onFocusCapture={onActivate}
    >
      <header className="preview-grid-head">
        <span className="preview-grid-title" title={tab.title}>
          {KIND_ICONS[tab.kind] ?? <File size={13} />}
          <span className="preview-grid-name">{tab.title}</span>
        </span>
        <span className="preview-grid-actions">
          {native && (
            <button
              className={`icon-btn ${ownsNativeView ? 'active' : ''}`}
              title={ownsNativeView ? '正在此窗口显示' : '在此窗口显示'}
              aria-pressed={ownsNativeView}
              onClick={(e) => { e.stopPropagation(); onShowNative(); onActivate(); }}
            ><Eye size={12} /></button>
          )}
          <button
            className="icon-btn"
            title="在系统中打开"
            onClick={(e) => {
              e.stopPropagation();
              const absolute = (tab.descriptor as { absolutePath?: string }).absolutePath;
              if (absolute) void desktop.preview.openExternal(absolute);
            }}
          ><ExternalLink size={12} /></button>
          <button
            className="icon-btn"
            title={`关闭 ${tab.title}`}
            onClick={(e) => { e.stopPropagation(); onClose(); }}
          ><X size={12} /></button>
        </span>
      </header>

      {native ? (
        ownsNativeView ? (
          // The one tile that actually holds the native view. Its bounds are
          // measured from this element.
          <div className="preview-grid-native" ref={viewportRef}>
            {tab.status === 'loading' && <div className="preview-spinner" aria-label="加载中…" />}
          </div>
        ) : (
          <button className="preview-grid-placeholder" onClick={() => { onShowNative(); onActivate(); }}>
            <Globe size={22} opacity={0.35} />
            <span>点击在此窗口显示</span>
            <span className="preview-grid-placeholder-hint">
              网页 / PDF 使用系统的内嵌浏览器，同一时间只能显示一个窗口
            </span>
          </button>
        )
      ) : (
        <div className="preview-grid-content">
          <PreviewContent
            key={`${tab.id}:${tab.revision ?? 0}`}
            tab={tab}
            dispatch={dispatch}
            workspaceRoot={workspaceRoot}
          />
        </div>
      )}
      {native && ownsNativeView && <Toolbar tab={tab} dispatch={dispatch} guestState={guestState} compact />}
    </section>
  );
}

function Toolbar({ tab, dispatch, guestState, compact }: { tab: PreviewTab; dispatch: React.Dispatch<AppAction>; guestState: PreviewGuestState; compact?: boolean }) {
  const isWeb = isNativeKind(tab.kind);
  return (
    <div className={`preview-toolbar ${compact ? 'compact' : ''}`}>
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
      {!compact && <span className="preview-toolbar-spacer" />}
      {!compact && (
        <button className="icon-btn" title="在系统中打开" onClick={() => {
          const target = tab.webUrl ?? (tab.descriptor as PreviewFileDescriptor).absolutePath;
          if (target) void desktop.preview.openExternal(target);
        }}><ExternalLink size={13} /></button>
      )}
    </div>
  );
}

function PreviewContent({ tab, dispatch, workspaceRoot }: { tab: PreviewTab; dispatch: React.Dispatch<AppAction>; workspaceRoot: string }) {
  if (tab.status === 'error') {
    const retry = () => {
      if (isNativeKind(tab.kind)) void desktop.preview.reload();
      dispatch({ type: 'preview/update', id: tab.id, patch: { status: 'loading', error: undefined, revision: (tab.revision ?? 0) + 1 } });
    };
    return (
      <div className="preview-error" role="alert">
        <p>无法加载预览</p>
        <p className="preview-error-detail">{tab.error}</p>
        <button type="button" className="btn-secondary preview-retry" onClick={retry}>
          <RefreshCw size={13} />重试预览
        </button>
      </div>
    );
  }

  switch (tab.kind) {
    case 'image':
      return <ImagePreview tab={tab} />;
    case 'docx':
      return <DocxPreview tab={tab} dispatch={dispatch} workspaceRoot={workspaceRoot} />;
    case 'xlsx':
      return <XlsxPreview tab={tab} dispatch={dispatch} />;
    case 'pptx':
      return <PptxPreview tab={tab} dispatch={dispatch} />;
    case 'doc_unsupported':
      return (
        <div className="preview-unsupported">
          <FileText size={40} opacity={0.3} />
          <p>这种格式无法在内嵌预览中打开</p>
          <p className="preview-error-detail">
            {describeUnsupported(tab)}
          </p>
          <button className="btn-secondary" onClick={() => void desktop.preview.openExternal(tab.descriptor.absolutePath)}>
            用系统应用打开
          </button>
        </div>
      );
    case 'html':
      return tab.status === 'loading' ? <div className="preview-spinner" aria-label="加载 HTML…" /> : null;
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

/**
 * Why a file cannot be previewed, in the user's terms.
 *
 * The old copy said "不支持旧版 .doc 格式直接预览" for every unsupported
 * document, which became wrong the moment .xls/.ppt/.ods were added to the same
 * kind — a user opening a spreadsheet was told they had opened an old Word file.
 */
function describeUnsupported(tab: PreviewTab): string {
  const ext = (tab.descriptor as { ext?: string }).ext?.toLowerCase() ?? '';
  switch (ext) {
    case '.doc': case '.rtf': case '.odt':
      return `${ext} 是旧版或非 OOXML 的文档格式，内嵌预览只读取 .docx。`;
    case '.xls': case '.ods':
      return `${ext} 是旧版或非 OOXML 的表格格式，内嵌预览只读取 .xlsx。`;
    case '.ppt': case '.odp':
      return `${ext} 是旧版或非 OOXML 的演示文稿格式，内嵌预览只读取 .pptx。`;
    default:
      return '这个文件格式无法在内嵌预览中显示。';
  }
}
