import { useState, useRef, useEffect, useCallback } from 'react';
import { X, Globe, RefreshCw, ChevronLeft, ChevronRight, Home, ExternalLink } from 'lucide-react';
import { desktop } from '../lib/ipc';

/*
 * BrowserPanel — 内置浏览器面板。
 *
 * 拖宽方案：用 setPointerCapture 在标题栏左边缘处理 resize，
 * 因为 WebContentsView 原生层覆盖了 React DOM，绝对定位的 resize handle
 * 会被原生视图遮挡。标题栏在原生视图上方，可以正常响应指针事件。
 */

export function BrowserPanel({
  open,
  width,
  onClose,
  onWidthChange,
  initialUrl,
}: {
  open: boolean;
  width: number;
  onClose: () => void;
  onWidthChange: (width: number) => void;
  initialUrl?: string;
}) {
  const DEFAULT_URL = 'https://www.bing.com';
  const [currentUrl, setCurrentUrl] = useState(initialUrl || DEFAULT_URL);
  const [inputUrl, setInputUrl] = useState(initialUrl || DEFAULT_URL);
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const [loading, setLoading] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  // Drag-resize state (using pointer capture — works above the native WebContentsView)
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = width;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }, [width]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const delta = startX.current - e.clientX;
    const next = Math.max(320, Math.min(1200, startW.current + delta));
    onWidthChange(next);
  }, [onWidthChange]);

  const onPointerUp = useCallback(() => { dragging.current = false; }, []);

  // Position the native WebContentsView over our transparent viewport div
  const syncBounds = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    void desktop.preview.setBounds({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  }, []);

  // Show/hide the native view as panel opens/closes
  useEffect(() => {
    if (!open) {
      void desktop.preview.hide();
      return;
    }
    const t = setTimeout(() => {
      syncBounds();
      void (desktop.preview.show as (url: string, allowedPort?: number | string) => Promise<unknown>)(currentUrl, 'browser');
    }, 50);
    return () => clearTimeout(t);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-sync bounds on resize/layout changes
  useEffect(() => {
    if (!open || !viewportRef.current) return;
    observerRef.current = new ResizeObserver(() => syncBounds());
    observerRef.current.observe(viewportRef.current);
    return () => observerRef.current?.disconnect();
  }, [open, syncBounds]);

  // Also sync bounds on width change
  useEffect(() => {
    if (open) syncBounds();
  }, [width, open, syncBounds]);

  // Listen for navigation state changes from the native view
  useEffect(() => {
    if (!open) return;
    const unsub = desktop.preview.onState((state) => {
      setCanBack(state.canGoBack ?? false);
      setCanForward(state.canGoForward ?? false);
      if (state.url) {
        setCurrentUrl(state.url);
        setInputUrl(state.url);
      }
      setLoading(false);
    });
    return unsub;
  }, [open]);

  // Hide on unmount
  useEffect(() => {
    return () => { void desktop.preview.hide(); };
  }, []);

  async function navigate(url: string) {
    let target = url.trim();
    if (!target) return;
    if (!target.startsWith('http://') && !target.startsWith('https://')) {
      if (target.includes('.') && !target.includes(' ')) {
        target = 'https://' + target;
      } else {
        target = `https://www.bing.com/search?q=${encodeURIComponent(target)}`;
      }
    }
    setInputUrl(target);
    setCurrentUrl(target);
    setLoading(true);
    await (desktop.preview.show as (url: string, allowedPort?: number | string) => Promise<unknown>)(target, 'browser');
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    void navigate(inputUrl);
  }

  if (!open) return null;

  return (
    <aside className="browser-panel" style={{ width }}>
      {/* Resize handle embedded IN the header (above native WebContentsView layer) */}
      <div
        className="browser-resize-handle"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />

      <div className="browser-header">
        <div className="browser-nav-btns">
          <button className="icon-button" title="后退" disabled={!canBack}
            onClick={() => { setLoading(true); void desktop.preview.back(); }}>
            <ChevronLeft size={15} />
          </button>
          <button className="icon-button" title="前进" disabled={!canForward}
            onClick={() => { setLoading(true); void desktop.preview.forward(); }}>
            <ChevronRight size={15} />
          </button>
          <button className={`icon-button${loading ? ' spin-icon' : ''}`} title="刷新"
            onClick={() => { setLoading(true); void desktop.preview.reload(); }}>
            <RefreshCw size={14} />
          </button>
          <button className="icon-button" title="主页" onClick={() => void navigate(DEFAULT_URL)}>
            <Home size={14} />
          </button>
        </div>

        <form className="browser-urlbar" onSubmit={handleSubmit}>
          <Globe size={13} style={{ flexShrink: 0, opacity: 0.5 }} />
          <input
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onFocus={(e) => e.target.select()}
            placeholder="输入网址或搜索内容…"
            spellCheck={false}
          />
        </form>

        <div style={{ display: 'flex', gap: 2 }}>
          <button className="icon-button" title="在系统浏览器中打开"
            onClick={() => void desktop.preview.openExternal(currentUrl)}>
            <ExternalLink size={14} />
          </button>
          <button className="icon-button" title="关闭"
            onClick={() => { void desktop.preview.hide(); onClose(); }}>
            <X size={15} />
          </button>
        </div>
      </div>

      {/* Transparent viewport — native WebContentsView positioned over this */}
      <div className="browser-viewport" ref={viewportRef} />
    </aside>
  );
}
