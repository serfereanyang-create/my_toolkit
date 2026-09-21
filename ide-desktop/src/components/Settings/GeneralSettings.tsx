import { Volume2 } from 'lucide-react';
import { Toggle, Segmented, SelectPill, SettingsCard, SettingRow } from './controls';
import { prefBool, prefNum, prefStr, type Prefs, type SavePref } from './prefs';
import { playCue } from '../../lib/notifySounds';
import type { ApprovalMode } from '../../types';

/*
 * Full "常规" page. Every control here is wired to a real consumer:
 *  - 权限卡：直接读写 settings.approval（与 Composer 的 ApprovalMenu、CLI
 *    --approval 参数同一数据源，改动立即生效）。审批模式同时决定确认频率和
 *    可及的文件范围，所以这里不再单独提供沙箱模式——原来的 gen.sandboxMode
 *    只在主进程里自动回答审批、从不传给 CLI，会和审批模式互相矛盾。
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

  // 弹窗确认（App.tsx ApprovalModal 消费）。沙箱模式已并入审批模式：审批模式
  // 同时决定确认频率与可及的文件范围，见 cli/src/safety/policy.ts 的 pathScopeFor。
  const approvalModal = prefBool(prefs, 'gen.approvalModal', true);
  const setApprovalModal = (v: boolean) => savePref({ 'gen.approvalModal': v });

  // 自动审核：让模型先审一遍本该问用户的高风险动作。硬拒绝（黑名单命令、
  // SSRF、只读模式）永远轮不到它，见 cli/src/tools/registry.ts 的落点。
  const autoReview = prefBool(prefs, 'autoReview', false);
  const setAutoReview = (v: boolean) => savePref({ autoReview: v });

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
          description="同时决定确认频率和可读写的文件范围：只读/仅计划/每次询问只能访问工作区（外加桌面、文档、下载）；自动批准（完全访问）可读写本机任意文件。修改立即生效，聊天输入框旁的审批菜单与此同步。"
          control={<Segmented value={approval} onChange={(next) => onApprovalChange(next)} options={[
            { value: 'ask', label: '每次询问' },
            { value: 'auto', label: '自动批准' },
            { value: 'plan', label: '仅计划' },
            { value: 'deny', label: '只读' },
          ]} />}
        />
        <SettingRow
          title="自动审核"
          description="本该问你的高风险动作先交给模型审一遍：判定为低风险就自动放行，判定为高风险就拒绝，审不出结论才来问你。审核用同一个模型、不带任何工具，且只作用于「本来会问你」的动作——黑名单命令、越权网络、只读模式这些硬拒绝它碰不到。每次审核结果都会记在对话里。"
          control={<Toggle checked={autoReview} onChange={setAutoReview} />}
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
