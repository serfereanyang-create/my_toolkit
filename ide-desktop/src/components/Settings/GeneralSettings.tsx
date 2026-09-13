import { Volume2 } from 'lucide-react';
import { Toggle, Segmented, SelectPill, SettingsCard, SettingRow } from './controls';
import { prefBool, prefNum, prefStr, type Prefs, type SavePref } from './prefs';
import { playCue } from '../../lib/notifySounds';
import type { ApprovalMode } from '../../types';

/*
 * Full "常规" page. Every control here is wired to a real consumer:
 *  - 权限卡：直接读写 settings.approval（与 Composer 的 ApprovalMenu、CLI
 *    --approval 参数同一数据源，改动立即生效）。
 *  - 沙箱：gen.sandboxMode 由 main.cjs 的 sandbox.cjs 策略引擎消费，
 *    在审批到达用户前自动放行/拦截（off/workspace/strict）。
 *  - 确认弹窗：gen.approvalModal 控制 ApprovalModal 是否弹出（App.tsx）。
 *  - 提示音：gen.sounds / gen.soundVolume 由 App.tsx 的 notifySounds 消费。
 *  - 发送快捷键 / 上下文用量 / 插件 / 底部面板：App/Composer 读取对应 pref。
 *  - 通知：main.cjs 的 notifyKeyState 读取 gen.turnNotify / gen.permissionNotify。
 *没有后端支撑的开关一律不展示（诚实 UI）：不再有"只存不用"的假控件。
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

  // 沙箱与弹窗确认（main.cjs sandbox.cjs / App.tsx ApprovalModal 消费）
  const sandboxMode = prefStr(prefs, 'gen.sandboxMode', 'off');
  const setSandboxMode = (v: string) => savePref({ 'gen.sandboxMode': v });
  const approvalModal = prefBool(prefs, 'gen.approvalModal', true);
  const setApprovalModal = (v: boolean) => savePref({ 'gen.approvalModal': v });

  // 提示音（App.tsx notifySounds 消费；音量 0 = 静音）
  const sounds = prefBool(prefs, 'gen.sounds', true);
  const soundVolume = prefNum(prefs, 'gen.soundVolume', 0.5);
  const setSounds = (v: boolean) => savePref({ 'gen.sounds': v });
  const setSoundVolume = (v: number) => savePref({ 'gen.soundVolume': Math.max(0, Math.min(1, v)) });

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
        <SettingRow
          title="沙箱模式"
          description="在审批到达你之前由策略引擎自动放行或拦截：工作区模式拒绝越界写入与危险命令；严格模式额外禁止 shell 与网络、自动批准只读。"
          control={<Segmented value={sandboxMode} onChange={setSandboxMode} options={[
            { value: 'off', label: '关闭' },
            { value: 'workspace', label: '工作区' },
            { value: 'strict', label: '严格' },
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

      <SettingsCard heading="确认弹窗">
        <SettingRow
          title="审批弹窗"
          description="需要确认执行时，在界面中央弹出置顶确认框（含快捷键 y/a/n）。关闭后仅在消息流的审批卡片中处理。"
          control={<Toggle checked={approvalModal} onChange={setApprovalModal} label="审批弹窗" />}
        />
      </SettingsCard>

      <SettingsCard heading="提示音">
        <SettingRow
          title="系统提示音"
          description="需要确认、任务完成、执行出错时播放短促提示音（本机合成，无需网络）。"
          control={<Toggle checked={sounds} onChange={setSounds} label="系统提示音" />}
        />
        <SettingRow
          title="音量"
          description="提示音音量，0 为静音"
          control={
            <span className="sound-volume-row">
              <input
                type="range" min={0} max={1} step={0.05}
                value={soundVolume}
                disabled={!sounds}
                onChange={(e) => setSoundVolume(Number(e.target.value))}
                className="sound-volume-slider"
              />
              <button
                type="button"
                className="settings-inline-edit"
                disabled={!sounds || soundVolume <= 0}
                onClick={() => playCue('approval', soundVolume)}
                title="试听提示音"
              >
                <Volume2 size={14} /><span>试听</span>
              </button>
            </span>
          }
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
