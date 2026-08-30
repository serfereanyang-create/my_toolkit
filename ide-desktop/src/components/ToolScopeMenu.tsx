import { useEffect, useRef } from 'react';
import { Boxes, Check } from 'lucide-react';
import type { ToolScope } from '../types';

const OPTIONS: { value: ToolScope; label: string; description: string }[] = [
  { value: 'auto', label: '自动', description: '按任务难度自动选择精简/标准/完整工具仓库' },
  { value: 'compact', label: '精简', description: '优先只读、轻量、低风险工具' },
  { value: 'standard', label: '标准', description: '常规编辑与结构化工具，不开放完整外部能力' },
  { value: 'full', label: '完整', description: '开放当前完整工具仓库，包括插件与 MCP' },
];

export const toolScopeLabel: Record<ToolScope, string> = {
  auto: '自动',
  compact: '精简',
  standard: '标准',
  full: '完整',
};

export function ToolScopeMenu({ value, onPick, onClose }: {
  value: ToolScope;
  onPick: (value: ToolScope) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div className="thinking-menu" ref={ref} role="menu" aria-label="工具仓库">
      <div className="thinking-menu-head">
        <Boxes size={16} />
        <span>工具仓库</span>
      </div>
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          className={`thinking-menu-item ${value === option.value ? 'selected' : ''}`}
          onClick={() => { onPick(option.value); onClose(); }}
        >
          <span className="thinking-menu-copy">
            <span className="thinking-menu-label">{option.label}</span>
            <span className="thinking-menu-desc">{option.description}</span>
          </span>
          {value === option.value && <Check size={15} />}
        </button>
      ))}
      <div className="thinking-menu-note">自动模式会复用当前任务难度与思考强度信号。</div>
    </div>
  );
}
