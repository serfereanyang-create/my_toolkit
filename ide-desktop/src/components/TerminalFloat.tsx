import { useRef, useState, useEffect, useCallback } from 'react';
import { TerminalSquare, X, Minus, Maximize2 } from 'lucide-react';
import { Terminal } from './Terminal';

/*
 * TerminalFloat — 浮动可拖动终端窗口。
 *
 * 包裹现有 Terminal 组件，加一个可拖动标题栏。
 * 支持最小化（收起至标题栏高度）和关闭。
 * 初始定位在屏幕左下角上方，不遮挡主内容。
 */

const MIN_W = 420;
const MIN_H = 200;
const DEFAULT_W = 680;
const DEFAULT_H = 340;

export function TerminalFloat({
  cwd,
  onClose,
  onCaptureOutput,
}: {
  cwd?: string;
  onClose: () => void;
  onCaptureOutput?: (text: string) => void;
}) {
  const [pos, setPos] = useState<{ x: number; y: number }>(() => ({
    x: 24,
    y: window.innerHeight - DEFAULT_H - 60,
  }));
  const [size, setSize] = useState({ w: DEFAULT_W, h: DEFAULT_H });
  const [minimized, setMinimized] = useState(false);

  const dragRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; ow: number; oh: number } | null>(null);
  const floatRef = useRef<HTMLDivElement | null>(null);

  // ── drag title bar ──────────────────────────────────────────────────────────
  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, ox: pos.x, oy: pos.y };
  }, [pos]);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      setPos({
        x: Math.max(0, Math.min(window.innerWidth - 100, dragRef.current.ox + dx)),
        y: Math.max(0, Math.min(window.innerHeight - 40, dragRef.current.oy + dy)),
      });
    }
    function onUp() { dragRef.current = null; }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, []);

  // ── resize SE corner ────────────────────────────────────────────────────────
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { startX: e.clientX, startY: e.clientY, ow: size.w, oh: size.h };
  }, [size]);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!resizeRef.current) return;
      const dw = e.clientX - resizeRef.current.startX;
      const dh = e.clientY - resizeRef.current.startY;
      setSize({
        w: Math.max(MIN_W, resizeRef.current.ow + dw),
        h: Math.max(MIN_H, resizeRef.current.oh + dh),
      });
    }
    function onUp() { resizeRef.current = null; }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, []);

  const style: React.CSSProperties = {
    left: pos.x,
    top: pos.y,
    width: size.w,
    height: minimized ? 38 : size.h,
  };

  return (
    <div className="term-float" style={style} ref={floatRef}>
      {/* Title bar — drag handle */}
      <div className="term-float-titlebar" onMouseDown={startDrag}>
        <TerminalSquare size={13} />
        <span className="term-float-title">终端</span>
        <div className="term-float-actions" onMouseDown={(e) => e.stopPropagation()}>
          <button
            className="icon-button term-float-btn"
            title={minimized ? '展开' : '最小化'}
            onClick={() => setMinimized((v) => !v)}
          >
            {minimized ? <Maximize2 size={13} /> : <Minus size={13} />}
          </button>
          <button className="icon-button term-float-btn" title="关闭" onClick={onClose}>
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Terminal body */}
      {!minimized && (
        <div className="term-float-body">
          <Terminal cwd={cwd} onClose={onClose} onCaptureOutput={onCaptureOutput} />
        </div>
      )}

      {/* Resize handle — SE corner */}
      {!minimized && (
        <div className="term-float-resize" onMouseDown={startResize} />
      )}
    </div>
  );
}
