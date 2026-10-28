import { useEffect, useRef } from 'react';
import { BrainCircuit, Check } from 'lucide-react';
import type { ReasoningEffort } from '../types';
import type { ModelReasoningCapability } from '../lib/modelCapabilities';
import { usePopoverFocus } from '../lib/usePopoverFocus';

const LABELS: Record<ReasoningEffort, string> = {
  auto: '自动', max: '极高', high: '高', medium: '中', low: '低', off: '关闭',
};

function optionsFor(capability: ModelReasoningCapability) {
  return capability.options.map((value) => ({
    value,
    label: capability.mode === 'toggle' && value === 'high' ? '开启' : LABELS[value],
    description: capability.mode === 'toggle' && value === 'high'
      ? '请求模型启用思考模式'
      : value === 'auto' ? '根据模型能力和任务复杂度自动选择'
      : value === 'off' ? '不发送推理参数'
      : capability.description,
  }));
}

export const effortLabel: Record<ReasoningEffort, string> = {
  auto: '自动',
  max: '极高',
  high: '高',
  medium: '中',
  low: '低',
  off: '关闭',
};

export function ThinkingMenu({ value, capability, onPick, onClose }: {
  value: ReasoningEffort;
  capability: ModelReasoningCapability;
  onPick: (value: ReasoningEffort) => void;
  onClose: () => void;
}) {
  const options = optionsFor(capability);
  const ref = useRef<HTMLDivElement | null>(null);
  usePopoverFocus(ref);

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
    <div className="thinking-menu" ref={ref} role="menu" aria-label="思考强度">
      <div className="thinking-menu-head">
        <BrainCircuit size={16} />
        <span>思考强度</span>
      </div>
      {options.map((option) => (
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
      <div className="thinking-menu-note">
        {capability.description}
      </div>
    </div>
  );
}
