import { Files, MessageSquare, Search, Settings } from 'lucide-react';
import type { ActivityView } from '../types';

const items: Array<{ id: ActivityView; label: string; icon: typeof Files }> = [
  { id: 'files', label: 'Files', icon: Files },
  { id: 'search', label: 'Search', icon: Search },
  { id: 'sessions', label: 'Sessions', icon: MessageSquare },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export function ActivityBar({ active, onChange }: { active: ActivityView; onChange: (view: ActivityView) => void }) {
  return (
    <nav className="activity-bar" aria-label="Activity">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button key={item.id} className={active === item.id ? 'active' : ''} title={item.label} onClick={() => onChange(item.id)}>
            <Icon size={19} />
          </button>
        );
      })}
    </nav>
  );
}
