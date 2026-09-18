import { RefreshCw } from 'lucide-react';
import { SettingsCard, SettingRow, Toggle, TextField, NumberField, SectionHeader, EmptyState } from './controls';
import { prefStr, prefBool, prefNum, type Prefs, type SavePref } from './prefs';

/* Worktrees page. Config persists through preferences. The worktree list stays
   empty until a git-worktree backend exists (none yet), so it remains an honest
   empty state rather than faked rows. */
export function WorktreesSettings({ prefs, savePref }: { prefs: Prefs; savePref: SavePref }) {
  const root = prefStr(prefs, 'worktreeRoot', '');
  const autoDelete = prefBool(prefs, 'worktreeAutoDelete', true);
  const keepLimit = prefNum(prefs, 'worktreeKeepLimit', 15);
  const setRoot = (v: string) => savePref({ worktreeRoot: v });
  const setAutoDelete = (v: boolean) => savePref({ worktreeAutoDelete: v });
  const setKeepLimit = (v: number) => savePref({ worktreeKeepLimit: v });

  return (
    <div className="settings-page">
      <h1 className="settings-page-title">工作树</h1>

      <SettingsCard>
        <SettingRow
          title="工作树根目录"
          description="YOYcode 创建托管工作树的目录；留空则使用默认位置"
          control={<TextField value={root} onChange={setRoot} placeholder="默认" />}
        />
        <SettingRow
          title="自动删除旧工作树"
          description="推荐大多数用户启用。仅当你需要手动管理旧工作树和磁盘使用空间时，再关闭此功能。"
          control={<Toggle checked={autoDelete} onChange={setAutoDelete} label="自动删除旧工作树" />}
        />
        <SettingRow
          title="自动删除限制"
          description={<>要保留的托管工作树数量；超过后，较旧的工作树会自动被清理。<br />YOYcode 会在删除工作树前创建快照，因此被清理的工作树应始终可以恢复。</>}
          control={<NumberField value={keepLimit} onChange={setKeepLimit} min={1} max={100} />}
        />
      </SettingsCard>

      <section className="settings-group">
        <SectionHeader
          title="尚无工作树"
          action={<button type="button" className="settings-icon-btn" aria-label="刷新"><RefreshCw size={16} /></button>}
        />
        <EmptyState title="YOYcode 创建的工作树将显示在此处" />
      </section>
    </div>
  );
}
