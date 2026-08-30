import { RefreshCw } from 'lucide-react';
import { SectionHeader, EmptyState } from './controls';

/* Lifecycle hooks page. UI-only mock — the hook list is always empty for now. */
export function HooksSettings() {
  return (
    <div className="settings-page">
      <SectionHeader
        title="钩子"
        description={
          <>
            通过配置和已启用的插件管理生命周期钩子。{' '}
            <a href="#" className="settings-link">了解更多</a>
          </>
        }
        action={
          <button type="button" className="settings-icon-btn" aria-label="刷新">
            <RefreshCw size={16} />
          </button>
        }
      />

      <EmptyState title="未找到钩子" description="已配置的钩子将显示在此处" />
    </div>
  );
}
