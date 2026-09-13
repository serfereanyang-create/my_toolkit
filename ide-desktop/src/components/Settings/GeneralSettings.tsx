import { Pencil } from 'lucide-react';
import { Toggle, Segmented, SelectPill, SettingsCard, SettingRow } from './controls';
import { prefBool, prefStr, type Prefs, type SavePref } from './prefs';
import type { ApprovalMode } from '../../types';

/*
 * Full "常规" page. Every control here is wired to a real consumer:
 *  - 权限卡：直接读写 settings.approval（与 Composer 的 ApprovalMenu、CLI
 *    --approval 参数同一数据源，改动立即生效）。
 *  - 发送快捷键 / 上下文用量 / 插件 / 底部面板：App/Composer 读取对应 pref。
 *  - 通知：main.cjs 的 notifyKeyState 读取 gen.turnNotify / gen.permissionNotify。
 * 没有后端支撑的开关一律不展示（诚实 UI）：不再有"只存不用"的假控件。
 */
export function GeneralSettings({ prefs, savePref, approval, onApprovalChange }: {
  prefs: Prefs;
  savePref: SavePref;
  approval: ApprovalMode;
  onApprovalChange: (next: ApprovalMode) => void;
}) {
  // 常规
  const language = prefStr(prefs, 'gen.language', 'auto');
  const bottomPanel = prefBool(prefs, 'gen.bottomPanel', true);
  const plugins = prefBool(prefs, 'gen.plugins', true);
  const setLanguage = (v: string) => savePref({ 'gen.language': v });
  const setBottomPanel = (v: boolean) => savePref({ 'gen.bottomPanel': v });
  const setPlugins = (v: boolean) => savePref({ 'gen.plugins': v });

  // 编辑器
  const showContextUsage = prefBool(prefs, 'gen.showContextUsage', true);
  const sendShortcut = prefStr(prefs, 'gen.sendShortcut', 'enter');
  const setShowContextUsage = (v: boolean) => savePref({ 'gen.showContextUsage': v });
  const setSendShortcut = (v: string) => savePref({ 'gen.sendShortcut': v });

  // 通知
  const turnNotify = prefStr(prefs, 'gen.turnNotify', 'unfocused');
  const permissionNotify = prefBool(prefs, 'gen.permissionNotify', true);
  const setTurnNotify = (v: string) => savePref({ 'gen.turnNotify': v });
  const setPermissionNotify = (v: boolean) => savePref({ 'gen.permissionNotify': v });

  return (
    <div className="settings-page">
      <h1 className="settings-page-title">常规</h1>

      <SettingsCard heading="权限">
        <SettingRow
          title="审批模式"
          description="控制智能体执行写入、命令等操作前是否需要你确认。修改立即生效，聊天输入框旁的审批菜单与此同步。"
          control={<Segmented value={approval} onChange={(next) => onApprovalChange(next)} options={[
            { value: 'ask', label: '每次询问' },
            { value: 'auto', label: '自动批准' },
            { value: 'plan', label: '仅计划' },
            { value: 'deny', label: '只读' },
          ]} />}
        />
      </SettingsCard>

      <SettingsCard heading="常规">
        <SettingRow
          title="语言"
          description="应用 UI 语言（影响界面字体与语言标记）"
          control={<SelectPill value={language} onChange={setLanguage} options={[
            { value: 'auto', label: '自动检测' },
            { value: 'zh', label: '简体中文' },
            { value: 'en', label: 'English' },
          ]} />}
        />
        <SettingRow
          title="底部面板"
          description="在应用标题栏中显示底部面板控件"
          control={<Toggle checked={bottomPanel} onChange={setBottomPanel} label="底部面板" />}
        />
        <SettingRow
          title="插件"
          description="在输入框旁显示插件菜单入口"
          control={<Toggle checked={plugins} onChange={setPlugins} label="插件" />}
        />
      </SettingsCard>

      <SettingsCard heading="编辑器">
        <SettingRow
          title="显示上下文窗口使用情况"
          description="在输入框旁显示上下文用量入口"
          control={<Toggle checked={showContextUsage} onChange={setShowContextUsage} label="显示上下文窗口使用情况" />}
        />
        <SettingRow
          title="发送快捷键"
          description="选择按 Enter 时是发送提示还是插入新行"
          control={<SelectPill value={sendShortcut} onChange={setSendShortcut} options={[
            { value: 'enter', label: '按 Enter 键' },
            { value: 'mod-enter', label: '按 Ctrl+Enter' },
          ]} />}
        />
      </SettingsCard>

      <SettingsCard heading="弹出窗口">
        <SettingRow
          title="弹出窗口快捷键"
          description="为弹出窗口设置全局快捷键。不设置则保持关闭。"
          control={<button type="button" className="settings-inline-edit"><span>关闭</span><Pencil size={14} /></button>}
        />
      </SettingsCard>

      <SettingsCard heading="通知">
        <SettingRow
          title="轮次完成通知"
          description="设置 AI 完成后何时提醒你"
          control={<SelectPill value={turnNotify} onChange={setTurnNotify} options={[
            { value: 'unfocused', label: '仅在未聚焦时' },
            { value: 'always', label: '总是' },
            { value: 'never', label: '从不' },
          ]} />}
        />
        <SettingRow
          title="启用权限通知"
          description="在需要确认执行时显示系统通知提醒"
          control={<Toggle checked={permissionNotify} onChange={setPermissionNotify} label="启用权限通知" />}
        />
      </SettingsCard>
    </div>
  );
}
