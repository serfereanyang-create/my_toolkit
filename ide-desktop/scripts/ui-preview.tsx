import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FolderOpen } from 'lucide-react';
import { initialState } from '../src/lib/state';
import type { AppState, ChatItem } from '../src/types';
import '../src/styles.css';
import '../src/conversation-shell.css';

const events: Array<{ type: string; value?: unknown }> = [];
const emit = (type: string, value?: unknown) => { events.push({ type, value }); };
const timestamp = Date.now();
const messages: ChatItem[] = [
  { id: 'user', kind: 'user', text: '梳理一下这个项目的认证流程，找出可能的边界问题。', ts: timestamp },
  { id: 'assistant', kind: 'assistant', text: '我会先检查登录入口和会话存储，再核对令牌过期时的处理。' },
  { id: 'tools', kind: 'turn', startedAt: timestamp - 42000, endedAt: timestamp, steps: [
    { id: 'read', kind: 'tool', status: 'done', tool: 'read_file', input: { path: 'src/auth/session.ts' }, output: 'Read 126 lines', ok: true },
    { id: 'search', kind: 'tool', status: 'done', tool: 'search_text', input: { query: 'refreshToken', path: 'src' }, output: 'Found 4 references', ok: true },
  ], files: [], added: 0, removed: 0 },
  { id: 'answer', kind: 'assistant', text: '登录流程已经梳理完毕。\n\n### 需要关注的两处边界\n\n- **会话恢复**：页面刷新后，先校验令牌有效期，再恢复用户信息。\n- **并发刷新**：多个请求同时失败时，共用一次令牌刷新，避免重复登录。\n\n可以先在 `src/auth/session.ts` 补齐过期检查，再验证恢复流程。' },
];

const settings = {
  activeProviderId: 'preview', approval: 'ask' as const, recentWorkspaces: [],
  providers: [{ id: 'preview', type: 'custom' as const, label: '工作模型', baseUrl: 'https://preview.invalid', model: 'gpt-5.4', models: [{ id: 'gpt-5.4', contextWindow: 128000 }, { id: 'a-very-long-provider-model-name-for-responsive-menu-checks', contextWindow: 128000 }] }],
  preferences: { reasoningEffort: 'high' as const },
};

const mockDesktop = {
  dispatch: { options: async () => ({ ok: true, options: [] }) },
  commands: { list: async () => ({ ok: true, commands: [] }) },
  agent: { taskBoardAction: async () => ({ ok: true }) },
};
(window as unknown as { zcodeDesktop: unknown }).zcodeDesktop = mockDesktop;
const [{ Rail }, { ConversationStream }, { Composer }] = await Promise.all([
  import('../src/components/Rail'), import('../src/components/ConversationStream'), import('../src/components/Composer'),
]);

function Preview() {
  const [scenario, setScenario] = useState('empty');
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const [approval, setApproval] = useState(settings.approval);
  const [decided, setDecided] = useState<string | null>(null);
  const [view, setView] = useState('chat');
  const [sendShortcut, setSendShortcut] = useState('enter');
  const [activeSessionId, setActiveSessionId] = useState('current');
  const [sessionTitles, setSessionTitles] = useState<Record<string, string>>({});
  const chat: ChatItem[] = scenario === 'empty' ? [] : messages.map((item): ChatItem => {
    if (item.kind !== 'turn') return item;
    if (scenario === 'tool-failure') return { ...item, steps: [...item.steps, { id: 'failed', kind: 'tool', status: 'failed', tool: 'run_command', input: { command: 'npm test' }, output: '1 test failed: expired session should be rejected', ok: false }] };
    if (scenario === 'changes') return { ...item, files: [{ path: 'src/auth/very-long-module-name-for-authentication-boundary-and-session-refresh.ts', added: 12, removed: 4, checkpointIds: ['preview-checkpoint'] }], added: 12, removed: 4 };
    return item;
  });
  if (scenario === 'running') chat.push({ id: 'live', kind: 'turn', startedAt: timestamp, steps: [{ id: 'running', kind: 'tool', status: 'running', tool: 'run_command', input: { command: 'npm test' }, output: '' }], files: [], added: 0, removed: 0 });
  // The card's tint is keyed off the risk, so each risk needs its own scenario
  // to be contrast-checked against the surface it actually paints.
  const approvalRisk = scenario === 'approval-shell' ? 'shell' : scenario === 'approval-network' ? 'network' : 'write';
  if (scenario === 'approval' || scenario === 'approval-shell' || scenario === 'approval-network') chat.push({ id: 'approval', kind: 'approval', requestId: 'preview-approval', tool: approvalRisk === 'write' ? 'apply_patch' : 'run_command', risk: approvalRisk, message: '允许修改 src/auth/session.ts 吗？', input: approvalRisk === 'write' ? { path: 'src/auth/session.ts' } : { command: 'npm test' }, ...(decided ? { decided: decided as 'deny' } : {}) });
  if (scenario === 'failure') chat.push({ id: 'error', kind: 'error', text: '模型连接暂时中断。已完成的工作已保留，可以稍后继续。' });
  const state: AppState = { ...initialState, settings: { ...settings, approval, preferences: { ...settings.preferences, 'gen.sendShortcut': sendShortcut } }, workspaceRoot: 'C:/workspace/YOYcode', activeSessionId, chat, agentStatus: scenario === 'running' ? 'running' : 'ready' };

  useEffect(() => {
    (window as unknown as { uiPreview: unknown }).uiPreview = {
      scenario: (value: string) => { setScenario(value); setDecided(null); setPrefill({ text: '', nonce: Date.now() }); },
      draft: (value: string) => setPrefill({ text: value, nonce: Date.now() }),
      events: () => events,
      clear: () => { events.length = 0; },
      sendShortcut: setSendShortcut,
    };
    document.documentElement.dataset.previewReady = 'true';
  }, []);

  return <div className="chat-shell">
    <Rail state={state} sessions={[
      { id: 'current', title: sessionTitles.current ?? '认证流程与边界检查', pinned: true, updatedAt: new Date(timestamp).toISOString(), messageCount: 4 },
      { id: 'other', title: '整理项目结构和模块依赖', pinned: false, updatedAt: new Date(timestamp - 3600000).toISOString(), messageCount: 8 },
      { id: 'yesterday', title: sessionTitles.yesterday ?? '修复长文件名在预览面板中的布局', pinned: false, updatedAt: new Date(timestamp - 86400000).toISOString(), messageCount: 12 },
    ]} sessionTags={{}} recentFiles={[]} mainView={view as 'chat'} runningIds={scenario === 'running' ? ['current'] : []} approvals={scenario === 'approval' && !decided ? { current: 1 } : {}}
      shortcuts={{ newChat: 'Ctrl+N', search: 'Ctrl+Shift+F' }}
      onNewChat={() => { emit('new-chat'); setScenario('empty'); }} onOpenWorkspace={() => emit('workspace')}
      onSelectView={(value) => { emit('view', value); setView(value); }} onOpenSession={(value) => { emit('session', value); setActiveSessionId(value); }}
      onHelpAction={(value) => emit('help', value)} onConvoAction={(action, payload) => {
        emit('session-action', { action, payload });
        if (action === 'rename') {
          const separator = payload.indexOf('::');
          setSessionTitles((previous) => ({ ...previous, [payload.slice(0, separator)]: payload.slice(separator + 2) }));
        }
      }} onOpenRecent={() => {}} onSetTags={() => {}} />
    <div className="main">
      <div className="main-topbar"><div className="main-title"><FolderOpen size={16} /><span>YOYcode</span></div><span className="main-topbar-spacer" /></div>
      <ConversationStream state={state} onApprove={(id, decision) => { emit('approval', { id, decision }); setDecided(decision); }} onEditUser={(text) => { emit('prefill', text); setPrefill({ text, nonce: Date.now() }); }} onUndo={(id) => emit('undo', id)} onOpenFile={(value) => emit('file', value)} dispatch={() => {}} onCancel={() => { emit('stop'); setScenario('conversation'); }} />
      <Composer state={state} prefill={prefill} onSubmit={(text) => emit('submit', text)} onCancel={() => { emit('stop'); setScenario('conversation'); }} onPickApproval={(value) => { emit('mode', value); setApproval(value as 'ask'); }} onPickPlugin={(value) => emit('plugin', value.name)} onPickModel={(id, model) => emit('model', { id, model })} onPickEffort={(value) => emit('effort', value)} onPickToolScope={() => {}} onManageModels={() => emit('manage-models')} />
    </div>
  </div>;
}

createRoot(document.getElementById('root')!).render(<Preview />);
