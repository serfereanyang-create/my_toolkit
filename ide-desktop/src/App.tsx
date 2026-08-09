import { useEffect, useReducer, useRef, useState } from 'react';
import { MessageSquare, Files as FilesIcon, FolderOpen, Settings as SettingsIcon } from 'lucide-react';
import { CodeEditor } from './components/CodeEditor';
import { Composer } from './components/Composer';
import { ConversationStream } from './components/ConversationStream';
import { EditorTabs } from './components/EditorTabs';
import { FileTree } from './components/FileTree';
import { Rail } from './components/Rail';
import { SettingsPanel } from './components/SettingsPanel';
import { Welcome } from './components/Welcome';
import { desktop } from './lib/ipc';
import { appReducer, initialState, languageForPath } from './lib/state';
import type { ApprovalMode } from './types';

type MainView = 'chat' | 'files' | 'editor' | 'settings';

export default function App() {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const [sessions, setSessions] = useState<string[]>([]);
  const [mainView, setMainView] = useState<MainView>('chat');
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);

  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    desktop.settings.get().then((settings) => dispatch({ type: 'settings/loaded', settings }));
    return desktop.agent.onEvent(async (event) => {
      dispatch({ type: 'agent/event', event });
      if (event.type === 'tool_result' && event.ok !== false) {
        const data = event.data as { path?: string } | undefined;
        const path = data?.path;
        if (path && stateRef.current.tabs.some((tab) => tab.path === path)) {
          const content = await desktop.fs.read(path);
          dispatch({ type: 'tab/opened', tab: { path, content, savedContent: content, language: languageForPath(path) } });
        }
      }
    });
  }, []);

  useEffect(() => {
    if (!state.workspaceRoot) return;
    desktop.sessions.list().then(setSessions).catch(() => setSessions([]));
  }, [state.workspaceRoot, state.chat.length]);

  async function openWorkspace() {
    const result = await desktop.workspace.open();
    if (!result.canceled && result.root) {
      dispatch({ type: 'workspace/opened', root: result.root });
      const tree = await desktop.workspace.getTree('.');
      dispatch({ type: 'tree/loaded', tree });
    }
  }

  async function openFile(path: string) {
    const content = await desktop.fs.read(path);
    dispatch({ type: 'tab/opened', tab: { path, content, savedContent: content, language: languageForPath(path) } });
    setMainView('editor');
  }

  async function saveActiveFile() {
    const tab = state.tabs.find((item) => item.path === state.activeTabPath);
    if (!tab) return;
    await desktop.fs.write(tab.path, tab.content);
    dispatch({ type: 'tab/saved', path: tab.path, content: tab.content });
  }

  async function saveSettings(next: NonNullable<typeof state.settings>) {
    const settings = await desktop.settings.set(next);
    dispatch({ type: 'settings/loaded', settings });
  }

  async function saveApiKey(providerId: string, apiKey: string) {
    await desktop.secrets.setApiKey(providerId, apiKey);
    const settings = await desktop.settings.get();
    const providers = await Promise.all(settings.providers.map(async (provider) => {
      if (provider.type === 'mock') return provider;
      const keyState = await desktop.secrets.hasApiKey(provider.id);
      return { ...provider, keyHint: keyState.hint };
    }));
    dispatch({ type: 'settings/loaded', settings: { ...settings, providers } });
  }

  async function cycleApproval() {
    if (!state.settings) return;
    const order: ApprovalMode[] = ['ask', 'auto', 'deny'];
    const next = order[(order.indexOf(state.settings.approval) + 1) % order.length];
    await saveSettings({ ...state.settings, approval: next });
  }

  async function submitPrompt(text: string) {
    setMainView('chat');
    if (text === '/help') {
      dispatch({ type: 'agent/event', event: { type: 'assistant_message', text: '/help /model /provider /status' } });
      return;
    }
    if (text === '/status') {
      dispatch({ type: 'agent/event', event: { type: 'assistant_message', text: `agent=${state.agentStatus} workspace=${state.workspaceRoot}` } });
      return;
    }
    if (text === '/model') {
      const provider = state.settings?.providers.find((item) => item.id === state.settings?.activeProviderId);
      dispatch({ type: 'agent/event', event: { type: 'assistant_message', text: provider ? provider.model : 'mock-code-agent-v1' } });
      return;
    }
    if (text === '/provider') {
      const provider = state.settings?.providers.find((item) => item.id === state.settings?.activeProviderId);
      dispatch({ type: 'agent/event', event: { type: 'assistant_message', text: provider ? provider.label : 'Mock' } });
      return;
    }

    if (state.agentStatus === 'offline') {
      dispatch({ type: 'agent/status', status: 'starting' });
      await desktop.agent.start();
    }
    dispatch({ type: 'chat/user', text });
    await desktop.agent.prompt(text);
  }

  async function cancelTurn() {
    await desktop.agent.cancel();
    dispatch({ type: 'agent/status', status: 'ready' });
  }

  async function approve(requestId: string, decision: 'allow_once' | 'allow_session' | 'deny') {
    await desktop.agent.approve(requestId, decision);
  }

  function newChat() {
    dispatch({ type: 'chat/clear' });
    setMainView('chat');
  }

  if (!state.workspaceRoot) return <main className="app-shell"><Welcome onOpenWorkspace={openWorkspace} /></main>;

  const activeTab = state.tabs.find((item) => item.path === state.activeTabPath);
  const titleMap: Record<MainView, { icon: JSX.Element; label: string }> = {
    chat: { icon: <MessageSquare size={16} />, label: '对话' },
    files: { icon: <FilesIcon size={16} />, label: '文件' },
    editor: { icon: <FolderOpen size={16} />, label: activeTab ? (activeTab.path.split('/').pop() ?? '编辑器') : '编辑器' },
    settings: { icon: <SettingsIcon size={16} />, label: '设置' },
  };

  return (
    <div className="chat-shell">
      <Rail
        state={state}
        sessions={sessions}
        mainView={mainView}
        onNewChat={newChat}
        onOpenWorkspace={openWorkspace}
        onSelectView={setMainView}
        onHelpAction={(action) => {
          // UI-only for now: settings opens the settings view; others echo a note.
          if (action === 'extensions') { setMainView('settings'); return; }
          const labels: Record<string, string> = {
            'whats-new': '新功能',
            shortcuts: '键盘快捷键：Enter 发送 · Shift+Enter 换行 · Esc 关闭菜单',
            help: '帮助文档即将上线。',
          };
          dispatch({ type: 'agent/event', event: { type: 'assistant_message', text: labels[action] ?? action } });
        }}
        onConvoAction={(action, session) => {
          // UI-only for now: echo the chosen action + target session.
          dispatch({ type: 'agent/event', event: { type: 'assistant_message', text: `会话操作：${action} · ${session.replace(/\.json$/, '')}` } });
        }}
      />
      <div className="main">
        <div className="main-topbar">
          <div className="main-title">{titleMap[mainView].icon}<span>{titleMap[mainView].label}</span></div>
          <span className="main-topbar-spacer" />
          <div className="main-tabs">
            <button className={`main-tab ${mainView === 'chat' ? 'active' : ''}`} onClick={() => setMainView('chat')}>对话</button>
            <button className={`main-tab ${mainView === 'editor' ? 'active' : ''}`} onClick={() => setMainView('editor')}>编辑器</button>
          </div>
        </div>

        {mainView === 'chat' && (
          <ConversationStream
            state={state}
            onApprove={approve}
            onEditUser={(text) => setPrefill({ text, nonce: Date.now() })}
          />
        )}

        {mainView === 'files' && (
          <div className="secondary">
            <FileTree tree={state.tree} onOpenFile={openFile} />
          </div>
        )}

        {mainView === 'editor' && (
          <div className="secondary">
            <EditorTabs tabs={state.tabs} activePath={state.activeTabPath} onActivate={(path) => dispatch({ type: 'tab/activate', path })} />
            <CodeEditor
              tab={activeTab}
              onChange={(content) => state.activeTabPath && dispatch({ type: 'tab/changed', path: state.activeTabPath, content })}
              onSave={saveActiveFile}
            />
          </div>
        )}

        {mainView === 'settings' && state.settings && (
          <div className="secondary">
            <SettingsPanel settings={state.settings} onSave={saveSettings} onSaveKey={saveApiKey} />
          </div>
        )}

        {mainView === 'chat' && (
          <Composer
            state={state}
            prefill={prefill}
            onSubmit={submitPrompt}
            onCancel={cancelTurn}
            onCycleApproval={cycleApproval}
            onPickPlugin={(plugin) => {
              // UI-only for now: echo the picked plugin as an assistant note.
              // Real capability wiring comes later.
              dispatch({ type: 'agent/event', event: { type: 'assistant_message', text: `已选择插件：${plugin.name} — ${plugin.desc}` } });
            }}
          />
        )}
      </div>
    </div>
  );
}
