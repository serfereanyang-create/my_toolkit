import { useEffect, useRef } from 'react';
import { Gift, Chrome, Keyboard, HelpCircle } from 'lucide-react';
import { usePopoverFocus } from '../lib/usePopoverFocus';

export type HelpAction = 'whats-new' | 'extensions' | 'shortcuts' | 'help';

const ITEMS: Array<{ id: HelpAction; name: string; icon: JSX.Element; group: 1 | 2 }> = [
  { id: 'whats-new', name: '新功能', icon: <Gift size={16} />, group: 1 },
  { id: 'extensions', name: '设置 Chrome 扩展程序', icon: <Chrome size={16} />, group: 2 },
  { id: 'shortcuts', name: '键盘快捷键', icon: <Keyboard size={16} />, group: 2 },
  { id: 'help', name: '帮助', icon: <HelpCircle size={16} />, group: 2 },
];

export function HelpMenu({ onClose, onPick }: { onClose: () => void; onPick: (action: HelpAction) => void }) {
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

  const group1 = ITEMS.filter((item) => item.group === 1);
  const group2 = ITEMS.filter((item) => item.group === 2);

  return (
    <div className="help-menu" ref={ref} role="menu">
      {group1.map((item) => (
        <button key={item.id} className="help-row" onClick={() => onPick(item.id)}>
          <span className="help-icon">{item.icon}</span>
          {item.name}
        </button>
      ))}
      <div className="help-divider" />
      {group2.map((item) => (
        <button key={item.id} className="help-row" onClick={() => onPick(item.id)}>
          <span className="help-icon">{item.icon}</span>
          {item.name}
        </button>
      ))}
    </div>
  );
}
