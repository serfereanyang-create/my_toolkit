import { useEffect, useRef } from 'react';
import { Hand, Wand2, ClipboardList, ShieldOff, Check } from 'lucide-react';
import type { ApprovalMode } from '../types';

const OPTIONS: { value: ApprovalMode; label: string; description: string; Icon: React.ElementType }[] = [
  { value: 'auto', label: '完全访问',   description: '减少确认次数。',         Icon: ShieldOff    },
  { value: 'ask',  label: '变更前确认', description: '改文件前先问我。',       Icon: Hand         },
  { value: 'plan', label: '计划模式',   description: '编辑前先出计划。',       Icon: ClipboardList },
  { value: 'deny', label: '只读模式',   description: '禁止所有写操作。',       Icon: Wand2        },
];

export const approvalMenuLabel: Record<ApprovalMode, string> = {
  auto: '完全访问',
  ask:  '变更前确认',
  plan: '计划模式',
  deny: '只读模式',
};

export function ApprovalMenu({ value, onPick, onClose }: {
  value: ApprovalMode;
  onPick: (value: ApprovalMode) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div className="thinking-menu" ref={ref} role="menu" aria-label="审批模式">
      <div className="thinking-menu-head">
        <Hand size={16} />
        <span>审批模式</span>
      </div>
      {OPTIONS.map(({ value: v, label, description, Icon }) => (
        <button
          key={v}
          className={`thinking-menu-item ${value === v ? 'selected' : ''}`}
          onClick={() => { onPick(v); onClose(); }}
        >
          <Icon size={15} className="approval-menu-icon" />
          <span className="thinking-menu-copy">
            <span className="thinking-menu-label">{label}</span>
            <span className="thinking-menu-desc">{description}</span>
          </span>
          {value === v && <Check size={15} />}
        </button>
      ))}
    </div>
  );
}
