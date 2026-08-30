import { Pencil } from 'lucide-react';
import { Toggle, Segmented, SelectPill, SettingsCard, SettingRow } from './controls';
import { prefBool, prefStr, type Prefs, type SavePref } from './prefs';

/* Full "常规" page. All controls persist through the preferences record, so the
   page survives a remount / restart. Mirrors the Codex reference screenshots
   (权限 / 常规 / 编辑器 / 弹出窗口 / 通知). */
export function GeneralSettings({ prefs, savePref }: { prefs: Prefs; savePref: SavePref }) {
  // 权限
  const defaultPermission = prefBool(prefs, 'gen.defaultPermission', true);
  const autoReview = prefBool(prefs, 'gen.autoReview', true);
  const fullAccess = prefBool(prefs, 'gen.fullAccess', true);
  const setDefaultPermission = (v: boolean) => savePref({ 'gen.defaultPermission': v });
  const setAutoReview = (v: boolean) => savePref({ 'gen.autoReview': v });
  const setFullAccess = (v: boolean) => savePref({ 'gen.fullAccess': v });

  // 常规
  const openTarget = prefStr(prefs, 'gen.openTarget', 'vscode');
  const shell = prefStr(prefs, 'terminalShell', 'powershell');
  const language = prefStr(prefs, 'gen.language', 'auto');
  const bottomPanel = prefBool(prefs, 'gen.bottomPanel', true);
  const terminalLocation = prefStr(prefs, 'gen.terminalLocation', 'bottom') as 'bottom' | 'right';
  const promptSuggestions = prefBool(prefs, 'gen.promptSuggestions', true);
  const plugins = prefBool(prefs, 'gen.plugins', true);
  const setOpenTarget = (v: string) => savePref({ 'gen.openTarget': v });
  const setShell = (v: string) => savePref({ terminalShell: v });
  const setLanguage = (v: string) => savePref({ 'gen.language': v });
  const setBottomPanel = (v: boolean) => savePref({ 'gen.bottomPanel': v });
  const setTerminalLocation = (v: 'bottom' | 'right') => savePref({ 'gen.terminalLocation': v });
  const setPromptSuggestions = (v: boolean) => savePref({ 'gen.promptSuggestions': v });
  const setPlugins = (v: boolean) => savePref({ 'gen.plugins': v });

  // 编辑器
  const showContextUsage = prefBool(prefs, 'gen.showContextUsage', false);
  const sendShortcut = prefStr(prefs, 'gen.sendShortcut', 'enter');
  const followUp = prefStr(prefs, 'gen.followUp', 'queue') as 'queue' | 'steer';
  const setShowContextUsage = (v: boolean) => savePref({ 'gen.showContextUsage': v });
  const setSendShortcut = (v: string) => savePref({ 'gen.sendShortcut': v });
  const setFollowUp = (v: 'queue' | 'steer') => savePref({ 'gen.followUp': v });

  // 弹出窗口
  const standaloneChat = prefBool(prefs, 'gen.standaloneChat', false);
  const setStandaloneChat = (v: boolean) => savePref({ 'gen.standaloneChat': v });

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
          title="默认权限"
          description="默认情况下，AI 可以读取和编辑其工作空间中的文件。需要时，它可以请求额外访问权限"
          control={<Toggle checked={defaultPermission} onChange={setDefaultPermission} label="默认权限" />}
        />
        <SettingRow
          title="自动审核"
          description={<>AI 可以读取和编辑其工作空间中的文件。AI 会自动审查额外访问权限请求。自动审查可能会出错。<a href="#" className="settings-link">了解更多</a>关于高风险的信息。</>}
          control={<Toggle checked={autoReview} onChange={setAutoReview} label="自动审核" />}
        />
        <SettingRow
          title="完整访问权限"
          description={<>当 AI 以完整访问权限运行时，它无需你的批准即可编辑你电脑上的任何文件，并运行可访问网络的命令。这会显著增加数据丢失、泄露或意外行为的风险。<a href="#" className="settings-link">了解更多</a>关于风险升高的信息。</>}
          control={<Toggle checked={fullAccess} onChange={setFullAccess} label="完整访问权限" />}
        />
      </SettingsCard>

      <SettingsCard heading="常规">
        <SettingRow
          title="默认文件打开目标"
          description="默认打开文件和文件夹的位置"
          control={<SelectPill value={openTarget} onChange={setOpenTarget} options={[
            { value: 'vscode', label: 'VS Code' },
            { value: 'system', label: '系统默认' },
            { value: 'none', label: '不打开' },
          ]} />}
        />
        <SettingRow
          title="集成终端 Shell"
          description="选择要在集成终端中打开的 Shell。"
          control={<SelectPill value={shell} onChange={setShell} options={[
            { value: 'powershell', label: 'PowerShell' },
            { value: 'cmd', label: 'Command Prompt' },
            { value: 'gitbash', label: 'Git Bash' },
          ]} />}
        />
        <SettingRow
          title="语言"
          description="应用 UI 语言"
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
          title="默认终端位置"
          description="选择终端快捷键和环境操作在何处打开终端标签页"
          control={<Segmented value={terminalLocation} onChange={setTerminalLocation} options={[
            { value: 'bottom', label: '底部' },
            { value: 'right', label: '右侧' },
          ]} />}
        />
        <SettingRow
          title="提示词建议"
          description="通过搜索项目文件和已连接的应用，建议下一步操作"
          control={<Toggle checked={promptSuggestions} onChange={setPromptSuggestions} label="提示词建议" />}
        />
        <SettingRow
          title="从其他 AI 应用导入工作内容"
          description="导入您的设置、项目和最近聊天记录"
          control={<button type="button" className="settings-action-btn">导入</button>}
        />
        <SettingRow
          title="打开源许可证"
          description="捆绑依赖项的第三方声明"
          control={<button type="button" className="settings-action-btn">查看</button>}
        />
        <SettingRow
          title="插件"
          description="允许 ChatGPT 使用已安装插件"
          control={<Toggle checked={plugins} onChange={setPlugins} label="插件" />}
        />
      </SettingsCard>

      <SettingsCard heading="编辑器">
        <SettingRow
          title="显示上下文窗口使用情况"
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
        <SettingRow
          title="跟进处理方式"
          description={<>在 AI 运行时将后续消息加入队列，或调整当前运行的方向。按 Ctrl+⏎ 可对单条消息执行相反操作</>}
          control={<Segmented value={followUp} onChange={setFollowUp} options={[
            { value: 'queue', label: '加入队列' },
            { value: 'steer', label: '调整方向' },
          ]} />}
        />
      </SettingsCard>

      <SettingsCard heading="弹出窗口">
        <SettingRow
          title="弹出窗口快捷键"
          description="为弹出窗口设置全局快捷键。不设置则保持关闭。"
          control={<button type="button" className="settings-inline-edit"><span>关闭</span><Pencil size={14} /></button>}
        />
        <SettingRow
          title="默认使用独立聊天"
          description="在任何项目外开始新聊天"
          control={<Toggle checked={standaloneChat} onChange={setStandaloneChat} label="默认使用独立聊天" />}
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
          description="在需要通知权限时显示提醒"
          control={<Toggle checked={permissionNotify} onChange={setPermissionNotify} label="启用权限通知" />}
        />
      </SettingsCard>
    </div>
  );
}
