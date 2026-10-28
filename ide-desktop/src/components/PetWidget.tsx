import { AlertCircle, Bot, Check, ChevronDown, EyeOff, LoaderCircle, Minus, Pause, Plus, RotateCcw, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { AppState } from '../types';
import { clampPetOpacity, clampPetPosition, clampPetScale, type PetSettings } from '../lib/pet';
import petSpriteUrl from '../assets/blue-maid-pet-spritesheet.webp';

export type PetSignal = { kind: 'done' | 'failed'; nonce: number } | null;

type PetWidgetProps = {
  settings: PetSettings;
  agentStatus: AppState['agentStatus'];
  needsApproval: boolean;
  needsReview: boolean;
  signal: PetSignal;
  onChange: (patch: Partial<PetSettings>) => void;
  onFocusChat: () => void;
};

type PetMode = 'idle' | 'starting' | 'running' | 'waiting' | 'review' | 'done' | 'failed' | 'offline';

const MODE_COPY: Record<PetMode, { label: string; hint: string }> = {
  idle: { label: '待命中', hint: '我在这里陪你写代码' },
  starting: { label: '连接中', hint: '正在连接智能体' },
  running: { label: '工作中', hint: '智能体正在执行任务' },
  waiting: { label: '等你确认', hint: '有一步操作需要你的决定' },
  review: { label: '等审查', hint: '改动已经准备好，等你查看' },
  done: { label: '完成啦', hint: '这一轮任务已经结束' },
  failed: { label: '遇到问题', hint: '这一轮执行失败了' },
  offline: { label: '待机', hint: '发送消息后我会回来工作' },
};

function resolveMode(props: Pick<PetWidgetProps, 'agentStatus' | 'needsApproval' | 'needsReview' | 'signal'>): PetMode {
  if (props.needsApproval) return 'waiting';
  if (props.agentStatus === 'running') return 'running';
  if (props.agentStatus === 'starting') return 'starting';
  if (props.needsReview) return 'review';
  if (props.signal?.kind === 'failed') return 'failed';
  if (props.signal?.kind === 'done') return 'done';
  if (props.agentStatus === 'offline') return 'offline';
  return 'idle';
}

function ModeIcon({ mode }: { mode: PetMode }) {
  if (mode === 'running' || mode === 'starting') return <LoaderCircle size={14} className="pet-status-spin" />;
  if (mode === 'waiting') return <Pause size={14} />;
  if (mode === 'review') return <Sparkles size={14} />;
  if (mode === 'done') return <Check size={14} />;
  if (mode === 'failed') return <AlertCircle size={14} />;
  return <Bot size={14} />;
}

export function PetWidget({ settings, agentStatus, needsApproval, needsReview, signal, onChange, onFocusChat }: PetWidgetProps) {
  const [expanded, setExpanded] = useState(false);
  const [activeSignal, setActiveSignal] = useState<PetSignal>(null);
  const [dragging, setDragging] = useState(false);
  const widgetRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; lastX: number; right: number; bottom: number; moved: boolean } | null>(null);
  const gestureTimer = useRef<number | null>(null);
  const [gesture, setGesture] = useState<'none' | 'waving'>('none');
  const [walkDirection, setWalkDirection] = useState<'left' | 'right'>('right');
  const [spriteFrame, setSpriteFrame] = useState(0);
  const mode = useMemo(() => resolveMode({ agentStatus, needsApproval, needsReview, signal: activeSignal }), [activeSignal, agentStatus, needsApproval, needsReview]);
  const copy = MODE_COPY[mode];

  useEffect(() => {
    setActiveSignal(signal);
    if (!signal) return;
    const timer = window.setTimeout(() => setActiveSignal(null), 4800);
    return () => window.clearTimeout(timer);
  }, [signal]);

  function clampPosition(right: number, bottom: number) {
    const rect = widgetRef.current?.getBoundingClientRect();
    const width = rect?.width ?? 96;
    const height = rect?.height ?? 112;
    return clampPetPosition(right, bottom, window.innerWidth, window.innerHeight, width, height);
  }

  function updatePosition(right: number, bottom: number) {
    const position = clampPosition(right, bottom);
    onChange({
      right: position.right,
      bottom: position.bottom,
    });
  }

  function moveDrag(clientX: number, clientY: number) {
    const drag = dragRef.current;
    if (!drag) return;
    if (clientX !== drag.lastX) setWalkDirection(clientX < drag.lastX ? 'left' : 'right');
    drag.lastX = clientX;
    const dx = clientX - drag.x;
    const dy = clientY - drag.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
    updatePosition(drag.right - dx, drag.bottom - dy);
  }

  useEffect(() => {
    const keepVisible = () => updatePosition(settings.right, settings.bottom);
    window.addEventListener('resize', keepVisible);
    const frame = window.requestAnimationFrame(keepVisible);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', keepVisible);
    };
  }, [settings.bottom, settings.right]);

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => moveDrag(event.clientX, event.clientY);
    const onMouseUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      setDragging(false);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  });

  useEffect(() => {
    const animated = dragging || gesture === 'waving';
    setSpriteFrame(0);
    if (!animated) return;
    const frameCount = dragging ? 8 : 4;
    const frameTimer = window.setInterval(() => {
      setSpriteFrame((frame) => (frame + 1) % frameCount);
    }, dragging ? 120 : 145);
    return () => window.clearInterval(frameTimer);
  }, [dragging, gesture]);

  function handlePointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    if (gestureTimer.current !== null) window.clearTimeout(gestureTimer.current);
    setGesture('none');
    setWalkDirection('right');
    dragRef.current = { x: event.clientX, y: event.clientY, lastX: event.clientX, right: settings.right, bottom: settings.bottom, moved: false };
    setDragging(true);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    moveDrag(event.clientX, event.clientY);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    const moved = dragRef.current?.moved ?? false;
    dragRef.current = null;
    setDragging(false);
    if (!moved) {
      setGesture('waving');
      gestureTimer.current = window.setTimeout(() => setGesture('none'), 620);
      setExpanded((open) => !open);
      event.currentTarget.blur();
    }
  }

  return (
    <div
      ref={widgetRef}
      className={`pet-widget pet-mode-${mode}${dragging ? ' is-dragging' : ''}${expanded ? ' is-expanded' : ''}${gesture === 'waving' ? ' is-waving' : ''}${walkDirection === 'left' ? ' pet-walk-left' : ' pet-walk-right'}`}
      style={{ right: `${settings.right}px`, bottom: `${settings.bottom}px`, opacity: settings.opacity, '--pet-scale': settings.scale } as CSSProperties}
      data-testid="pet-widget"
    >
      {expanded && (
        <div className="pet-popover" role="dialog" aria-label="YOY 宠物设置">
          <div className="pet-popover-head">
            <div>
              <strong>YOY 宠物</strong>
              <span>{copy.hint}</span>
            </div>
            <button type="button" className="pet-icon-button" title="收起" aria-label="收起宠物面板" onClick={() => setExpanded(false)}>
              <ChevronDown size={15} />
            </button>
          </div>
          <button type="button" className="pet-status-row" onClick={onFocusChat}>
            <span className="pet-status-icon"><ModeIcon mode={mode} /></span>
            <span>{copy.label}</span>
            <span className="pet-status-open">打开对话</span>
          </button>
          <div className="pet-setting-row">
            <span>大小</span>
            <div className="pet-setting-controls">
              <button type="button" className="pet-icon-button" title="缩小" aria-label="缩小宠物" onClick={() => onChange({ scale: clampPetScale(settings.scale - 0.1) })}><Minus size={14} /></button>
              <span>{Math.round(settings.scale * 100)}%</span>
              <button type="button" className="pet-icon-button" title="放大" aria-label="放大宠物" onClick={() => onChange({ scale: clampPetScale(settings.scale + 0.1) })}><Plus size={14} /></button>
            </div>
          </div>
          <label className="pet-setting-row pet-range-row">
            <span>透明度</span>
            <input type="range" min="0.55" max="1" step="0.05" value={settings.opacity} onChange={(event) => onChange({ opacity: clampPetOpacity(event.currentTarget.value) })} />
          </label>
          <div className="pet-popover-actions">
            <button type="button" className="pet-action-button" onClick={() => onChange({ right: 24, bottom: 24 })}><RotateCcw size={14} />重置位置</button>
            <button type="button" className="pet-action-button" onClick={() => onChange({ visible: false })}><EyeOff size={14} />隐藏宠物</button>
          </div>
        </div>
      )}
      <div className="pet-caption" aria-live="polite"><ModeIcon mode={mode} /><span>{copy.label}</span></div>
      <button
        type="button"
        className="pet-orb"
        aria-label={`YOY 宠物：${copy.label}。点击打开设置，按住拖动`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <span
          className="pet-sprite"
          data-pet-frame={spriteFrame}
          style={{ '--pet-sprite-image': `url(${petSpriteUrl})`, '--pet-frame': spriteFrame } as CSSProperties}
          aria-hidden="true"
        />
      </button>
    </div>
  );
}

export function PetReopenButton({ onShow }: { onShow: () => void }) {
  return (
    <button type="button" className="pet-reopen" aria-label="显示 YOY 宠物" title="显示 YOY 宠物" onClick={onShow}>
      <Bot size={15} />
    </button>
  );
}
