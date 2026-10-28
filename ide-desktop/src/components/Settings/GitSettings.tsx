import { useState } from 'react';
import { SettingsCard, SettingRow, Toggle, Segmented, TextField, TextArea, SectionHeader } from './controls';
import { prefStr, prefBool, type Prefs, type SavePref } from './prefs';

/* Git page. Behavior config persists immediately through preferences and is
   materialized into .aicode/persona.md (see electron/persona.cjs) so the agent
   follows branch/PR/commit guidance on the next turn. The two guide textareas
   keep local draft state and persist on 保存 (so half-typed text isn't written
   every keystroke). Desktop GitPanel + /git slash commands use the same prefs
   where relevant (e.g. force-with-lease on push). */
export function GitSettings({ prefs, savePref }: { prefs: Prefs; savePref: SavePref }) {
  const branchPrefix = prefStr(prefs, 'gitBranchPrefix', 'yoycode/');
  const mergeMethod = prefStr(prefs, 'gitMergeMethod', 'merge') as 'merge' | 'squash' | 'rebase';
  const forcePush = prefBool(prefs, 'gitForcePush', false);
  const draftPr = prefBool(prefs, 'gitDraftPr', true);
  const reviewMode = prefStr(prefs, 'gitReviewMode', 'inline') as 'inline' | 'separate';
  const setBranchPrefix = (v: string) => savePref({ gitBranchPrefix: v });
  const setMergeMethod = (v: 'merge' | 'squash' | 'rebase') => savePref({ gitMergeMethod: v });
  const setForcePush = (v: boolean) => savePref({ gitForcePush: v });
  const setDraftPr = (v: boolean) => savePref({ gitDraftPr: v });
  const setReviewMode = (v: 'inline' | 'separate') => savePref({ gitReviewMode: v });

  // Guide texts: local draft, persisted on explicit 保存.
  const [commitGuide, setCommitGuide] = useState(prefStr(prefs, 'gitCommitGuide', ''));
  const [prGuide, setPrGuide] = useState(prefStr(prefs, 'gitPrGuide', ''));

  return (
    <div className="settings-page">
      <h1 className="settings-page-title">Git</h1>

      <SettingsCard>
        <SettingRow
          title="分支前缀"
          description="YOYcode 创建新分支时使用的前缀"
          control={<TextField label="分支前缀" value={branchPrefix} onChange={setBranchPrefix} placeholder="yoycode/" />}
        />
        <SettingRow
          title="拉取请求合并方法"
          description="选择 YOYcode 合并拉取请求的方式"
          control={<Segmented
            value={mergeMethod}
            onChange={setMergeMethod}
            options={[
              { value: 'merge', label: '合并' },
              { value: 'squash', label: '压缩合并' },
              { value: 'rebase', label: '变基' },
            ]}
          />}
        />
        <SettingRow
          title="始终强制推送"
          description="从 YOYcode 推送时使用 --force-with-lease"
          control={<Toggle checked={forcePush} onChange={setForcePush} label="始终强制推送" />}
        />
        <SettingRow
          title="创建草稿拉取请求"
          description="从 YOYcode 创建 PR 时默认使用草稿拉取请求"
          control={<Toggle checked={draftPr} onChange={setDraftPr} label="创建草稿拉取请求" />}
        />
        <SettingRow
          title="代码审查发送方式"
          description="在当前聊天或独立聊天中进行审查"
          control={<Segmented
            value={reviewMode}
            onChange={setReviewMode}
            options={[{ value: 'inline', label: '在此聊天中进行' }, { value: 'separate', label: '独立' }]}
          />}
        />
      </SettingsCard>

      <section className="settings-group">
        <SectionHeader
          title="提交说明"
          description="已添加到提交消息生成提示词中"
          action={<button type="button" className="settings-inline-save" disabled={commitGuide.trim() === prefStr(prefs, 'gitCommitGuide', '').trim()} onClick={() => savePref({ gitCommitGuide: commitGuide })}>保存</button>}
        />
        <TextArea label="提交说明" value={commitGuide} onChange={setCommitGuide} placeholder="添加提交消息指引..." />
      </section>

      <section className="settings-group">
        <SectionHeader
          title="拉取请求指令"
          description="已添加到 PR 标题/描述生成提示中"
          action={<button type="button" className="settings-inline-save" disabled={prGuide.trim() === prefStr(prefs, 'gitPrGuide', '').trim()} onClick={() => savePref({ gitPrGuide: prGuide })}>保存</button>}
        />
        <TextArea label="拉取请求指令" value={prGuide} onChange={setPrGuide} placeholder="添加拉取请求指引..." />
      </section>
    </div>
  );
}
