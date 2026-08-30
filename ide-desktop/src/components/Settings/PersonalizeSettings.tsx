import { SettingsCard, SettingRow, Toggle, SelectPill, TextArea } from './controls';
import { prefBool, prefStr, type Prefs, type SavePref } from './prefs';

/* Personalize page. Persisted through the preferences record AND injected into
   the agent's system prompt at prompt time (see main.cjs buildPersonaPreamble),
   so nickname / role / tone / verbosity / custom instructions actually shape
   the assistant's replies. */
export function PersonalizeSettings({ prefs, savePref }: { prefs: Prefs; savePref: SavePref }) {
  const nickname = prefStr(prefs, 'persona.nickname', '');
  const role = prefStr(prefs, 'persona.role', '');
  const tone = prefStr(prefs, 'persona.tone', 'default') as 'default' | 'concise' | 'friendly' | 'formal';
  const verbosity = prefStr(prefs, 'persona.verbosity', 'medium') as 'low' | 'medium' | 'high';
  const instructions = prefStr(prefs, 'persona.instructions', '');
  const enabled = prefBool(prefs, 'persona.enabled', true);
  const setNickname = (v: string) => savePref({ 'persona.nickname': v });
  const setRole = (v: string) => savePref({ 'persona.role': v });
  const setTone = (v: 'default' | 'concise' | 'friendly' | 'formal') => savePref({ 'persona.tone': v });
  const setVerbosity = (v: 'low' | 'medium' | 'high') => savePref({ 'persona.verbosity': v });
  const setInstructions = (v: string) => savePref({ 'persona.instructions': v });
  const setEnabled = (v: boolean) => savePref({ 'persona.enabled': v });

  return (
    <div className="settings-page">
      <h1 className="settings-page-title">个性化</h1>

      <SettingsCard heading="关于你">
        <SettingRow
          title="称呼"
          description="助手该如何称呼你"
          control={
            <input
              className="settings-text-field"
              value={nickname}
              placeholder="例如 小明"
              onChange={(event) => setNickname(event.target.value)}
            />
          }
        />
        <SettingRow
          title="职业 / 角色"
          description="帮助助手结合你的背景给出回答"
          control={
            <input
              className="settings-text-field"
              value={role}
              placeholder="例如 前端工程师"
              onChange={(event) => setRole(event.target.value)}
            />
          }
        />
      </SettingsCard>

      <SettingsCard heading="风格">
        <SettingRow
          title="语气"
          control={
            <SelectPill
              value={tone}
              onChange={setTone}
              options={[
                { value: 'default', label: '默认' },
                { value: 'concise', label: '简洁' },
                { value: 'friendly', label: '友好' },
                { value: 'formal', label: '正式' },
              ]}
            />
          }
        />
        <SettingRow
          title="回答详细程度"
          control={
            <SelectPill
              value={verbosity}
              onChange={setVerbosity}
              options={[
                { value: 'low', label: '精简' },
                { value: 'medium', label: '适中' },
                { value: 'high', label: '详尽' },
              ]}
            />
          }
        />
      </SettingsCard>

      <SettingsCard heading="自定义指令">
        <SettingRow
          title="启用自定义指令"
          description="在每次对话中附带以下说明"
          control={<Toggle checked={enabled} onChange={setEnabled} label="启用自定义指令" />}
        />
        <SettingRow
          title="指令内容"
          description="告诉助手你希望它记住的偏好"
          control={
            <TextArea
              value={instructions}
              onChange={setInstructions}
              placeholder="例如 回答请使用中文，代码优先给 TypeScript 示例..."
            />
          }
        />
      </SettingsCard>
    </div>
  );
}
