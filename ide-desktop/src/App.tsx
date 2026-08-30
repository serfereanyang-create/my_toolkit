import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { MessageSquare, Files as FilesIcon, Settings as SettingsIcon, Minimize2, AppWindow, PanelBottom, CalendarClock, PanelRight, GitBranch, LayoutDashboard, FileCode } from 'lucide-react';
import { AutomationPanel } from './components/AutomationPanel';
import { Composer } from './components/Composer';
import { ConversationStream } from './components/ConversationStream';
import { DiffReview } from './components/DiffReview/DiffReview';
import { EditorView } from './components/Editor/EditorView';
import { FileTree } from './components/FileTree';
import { GitPanel } from './components/GitPanel';
import { InfoPanel } from './components/InfoPanel';
import { PreviewSidebar } from './components/Preview/PreviewSidebar';
import { SideChatPanel } from './components/SideChatPanel';
import { BrowserPanel } from './components/BrowserPanel';
import { WorkDetailsPanel } from './components/WorkDetailsPanel';
import { Rail } from './components/Rail';
import { SettingsView, type SettingsNavId } from './components/Settings/SettingsView';
import { TaskCard } from './components/TaskCard';
import { Terminal } from './components/Terminal';
import { TerminalFloat } from './components/TerminalFloat';
import { Welcome } from './components/Welcome';
import { desktop } from './lib/ipc';
import { appReducer, initialState, languageForPath, sessionChangeTotals, activeTurnProgress, sessionToChat } from './lib/state';
import type { MentionItem } from './components/MentionPicker';
import type { ApprovalMode, PreviewFileDescriptor, ProjectDescriptor, ReasoningEffort, SessionMeta, ThemeMode, ToolScope } from './types';

type MainView = 'chat' | 'files' | 'git' | 'automation' | 'settings' | 'editor';

function applyTheme(theme: ThemeMode | undefined) {
  const resolved = theme === 'dark' || theme === 'light'
    ? theme
    : (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = resolved;
}

// Electron wraps IPC errors as "Error invoking remote method 'x': Error: <msg>".
// Strip that noise so the chat surfaces just the underlying cause.
function cleanIpcError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const match = raw.match(/Error invoking remote method '[^']*':\s*(?:Error:\s*)?(.*)$/s);
  return (match ? match[1] : raw).trim() || '未知错误';
}

export default function App() {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [mainView, setMainView] = useState<MainView>('chat');
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const [booting, setBooting] = useState(true);
  const [settingsPage, setSettingsPage] = useState<SettingsNavId | undefined>(undefined);
  // Terminal output ring-buffer for @terminal mention
  const [terminalOutput, setTerminalOutput] = useState<string>('');
  // Floating terminal window (launched from ChatLauncher / left-area)
  const [terminalFloatOpen, setTerminalFloatOpen] = useState(false);
  // Info panel visibility
  const [infoPanelOpen, setInfoPanelOpen] = useState(false);
  // Editor state
  const [openFiles, setOpenFiles] = useState<Array<{ path: string; content: string; dirty: boolean; language: string }>>([]);
  // Last-known on-disk mtime per open file, for external-change conflict checks.
  const diskMtimes = useRef<Map<string, number>>(new Map());
  // Deferred bridge restart: set when the user switches model mid-turn.
  const pendingRestartRef = useRef(false);
  const approvingRequests = useRef(new Set<string>());
  const [activeFile, setActiveFile] = useState<string | null>(null);

  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    desktop.settings.get().then((settings) => {
      dispatch({ type: 'settings/loaded', settings });
      applyTheme(settings.preferences?.theme);
    });
    // Auto-restore the last workspace (or fall back to home) so the app opens
    // straight into a project instead of forcing a folder picker every launch.
    desktop.workspace.restore().then(async ({ root }) => {
      dispatch({ type: 'workspace/opened', root });
      try {
        const tree = await desktop.workspace.getTree('.');
        dispatch({ type: 'tree/loaded', tree });
      } catch {
        // A stale or unreadable directory shouldn't block startup.
      }
    }).catch(() => {
      // If restore fails entirely, the user can still open a folder manually.
    }).finally(() => {
      setBooting(false);
    });
    return desktop.agent.onEvent(async (event) => {
      dispatch({ type: 'agent/event', event });
      if (event.type === 'turn_done' && pendingRestartRef.current) {
        // Model was switched mid-turn; now that files are no longer being
        // written, it's safe to swap the bridge to the new provider/model.
        pendingRestartRef.current = false;
        dispatch({ type: 'agent/status', status: 'starting' });
        try { await desktop.agent.restart(); } catch { /* next prompt retries */ }
      }
      if (event.type === 'tool_result' && event.ok !== false) {
        // file-change events are reflected in the file tree only
        void event;
      }
    });
  }, []);

  const refreshSessions = useCallback(() => {
    if (!stateRef.current.workspaceRoot) return;
    desktop.sessions.list().then(setSessions).catch(() => setSessions([]));
  }, []);

  useEffect(() => {
    refreshSessions();
  }, [state.workspaceRoot, state.chat.length, refreshSessions]);

  // Apply the persisted theme to the document root. 'system' follows the OS
  // preference live; 'light'/'dark' pin an explicit token set (see styles.css).
  const theme = state.settings?.preferences?.theme ?? 'system';
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const resolved = theme === 'system'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : theme;
      root.setAttribute('data-theme', resolved);
    };
    apply();
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);

  // Apply persisted font-size preferences as CSS custom properties so the whole
  // UI scales. Falls back to the stylesheet defaults when unset.
  const uiFontSize = Number(state.settings?.preferences?.uiFontSize) || undefined;
  const codeFontSize = Number(state.settings?.preferences?.codeFontSize) || undefined;
  useEffect(() => {
    const root = document.documentElement;
    if (uiFontSize) root.style.setProperty('--fs-base', `${uiFontSize}px`);
    else root.style.removeProperty('--fs-base');
  }, [uiFontSize]);
  useEffect(() => {
    const root = document.documentElement;
    if (codeFontSize) root.style.setProperty('--fs-code', `${codeFontSize}px`);
    else root.style.removeProperty('--fs-code');
  }, [codeFontSize]);

  // Global keyboard shortcuts advertised by the launcher and shortcuts page.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === 'p' && !event.altKey) { event.preventDefault(); setMainView('files'); return; }
      if (key === 't' && !event.altKey) { event.preventDefault(); dispatch({ type: 'bottom/toggle' }); return; }
      if (key === 'n' && !event.altKey) { event.preventDefault(); dispatch({ type: 'chat/clear' }); setMainView('chat'); return; }
      if (key === ',' && !event.altKey) { event.preventDefault(); setMainView('settings'); return; }
      if (key === 's' && event.altKey) { event.preventDefault(); dispatch({ type: 'sidechat/toggle' }); return; }
      if (key === 'b' && event.altKey) { event.preventDefault(); dispatch({ type: 'browser/toggle' }); return; }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Editor tabs belong to a workspace. On any workspace change, drop them all
  // (and their disk watchers) so saves/watch events can't touch the old tree.
  function resetEditorTabs() {
    for (const file of openFilesRef.current) {
      void desktop.editor.unwatchFile(file.path);
    }
    diskMtimes.current.clear();
    setOpenFiles([]);
    setActiveFile(null);
  }

  async function openWorkspace() {
    const result = await desktop.workspace.open();
    if (!result.canceled && result.root) {
      resetEditorTabs();
      dispatch({ type: 'workspace/opened', root: result.root });
      const tree = await desktop.workspace.getTree('.');
      dispatch({ type: 'tree/loaded', tree });
    }
  }

  async function openFile(path: string) {
    try {
      const desc = await desktop.preview.describe(path);
      // Route binary/preview-able formats to the preview sidebar
      if (desc.kind !== 'text') {
        const tabId = `preview-${desc.token}`;
        dispatch({
          type: 'preview/open',
          tab: {
            id: tabId,
            title: desc.name,
            kind: desc.kind,
            descriptor: desc,
            status: desc.kind === 'pdf' || desc.kind === 'html' ? 'loading' : 'ready',
            zoom: 1,
            fitWidth: true,
          },
        });
        // For PDF: load in native WebContentsView
        if (desc.kind === 'pdf') {
          const url = `yoycode-preview://${desc.token}/${encodeURIComponent(desc.relativePath)}`;
          await desktop.preview.show(url, undefined);
        }
        return;
      }
    } catch {
      // Fall through: if describe fails, try as text
    }
    // Bug-8 fix: for plain text files there is no editor to display content in,
    // so reading the file content was pointless and injected a misleading message.
    // Just select the file in the tree silently (no IPC read, no chat injection).
    void path; // path is used above by describe(); nothing more to do for text files.
  }

  async function openDirectory(path: string) {
    const info = await desktop.preview.inspectProject(path);
    if (!info) return;
    const tabId = `preview-project-${info.token}`;
    dispatch({
      type: 'preview/open',
      tab: {
        id: tabId,
        title: info.name,
        kind: 'web',
        descriptor: info,
        status: 'ready',
        zoom: 1,
        fitWidth: true,
      },
    });
  }

  async function saveActiveFile() {
    // No-op: editor removed
  }

  // Editor handlers
  function detectLanguage(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase();
    const languageMap: Record<string, string> = {
      'js': 'javascript', 'jsx': 'javascript', 'ts': 'typescript', 'tsx': 'typescript',
      'py': 'python', 'go': 'go', 'rs': 'rust', 'java': 'java', 'c': 'c',
      'cpp': 'cpp', 'cc': 'cpp', 'cxx': 'cpp', 'h': 'cpp', 'hpp': 'cpp',
      'cs': 'csharp', 'rb': 'ruby', 'php': 'php', 'sh': 'shell', 'bash': 'shell',
      'json': 'json', 'xml': 'xml', 'html': 'html', 'css': 'css', 'scss': 'scss',
      'md': 'markdown', 'yaml': 'yaml', 'yml': 'yaml', 'sql': 'sql',
    };
    return languageMap[ext || ''] || 'plaintext';
  }

  async function handleOpenFile(path: string) {
    // Check if already open
    if (openFiles.find(f => f.path === path)) {
      setActiveFile(path);
      setMainView('editor');
      return;
    }

    // Read file content
    const result = await desktop.editor.readFile(path);
    if (!result.ok) {
      alert(`无法打开文件: ${result.error || '未知错误'}`);
      return;
    }
    const fileContent = result.content ?? '';
    // Record on-disk mtime and start watching for external (agent) writes.
    const stat = await desktop.editor.stat(path);
    if (stat.ok && stat.mtimeMs !== undefined) diskMtimes.current.set(path, stat.mtimeMs);
    void desktop.editor.watchFile(path);

    const newFile = {
      path,
      content: fileContent,
      dirty: false,
      language: detectLanguage(path),
    };

    setOpenFiles(prev => [...prev, newFile]);
    setActiveFile(path);
    setMainView('editor');
  }

  async function handleSaveFile(path: string, content: string) {
    // Conflict guard: if the file changed on disk after we opened/last synced
    // it (e.g. the agent rewrote it), refuse to silently clobber those edits.
    const disk = await desktop.editor.stat(path);
    const known = diskMtimes.current.get(path);
    if (disk.ok && known && disk.mtimeMs !== known) {
      const reload = window.confirm(
        '文件在你编辑期间被外部修改（可能是 agent 写入）。\n' +
        '确定 = 覆盖外部修改并保存我的版本\n取消 = 丢弃我的编辑，加载磁盘上的最新内容'
      );
      if (!reload) {
        const fresh = await desktop.editor.readFile(path);
        if (fresh.ok && fresh.content !== undefined) {
          const newContent = fresh.content;
          setOpenFiles(prev => prev.map(f => f.path === path ? { ...f, content: newContent, dirty: false } : f));
          diskMtimes.current.set(path, disk.mtimeMs!);
        }
        return;
      }
    }
    const result = await desktop.editor.saveFile(path, content);
    if (!result.ok) {
      alert(`保存失败: ${result.error || '未知错误'}`);
      return;
    }
    const after = await desktop.editor.stat(path);
    if (after.ok && after.mtimeMs !== undefined) diskMtimes.current.set(path, after.mtimeMs);

    // Mark as not dirty
    setOpenFiles(prev => prev.map(f =>
      f.path === path ? { ...f, content, dirty: false } : f
    ));
  }

  function handleCloseFile(path: string) {
    void desktop.editor.unwatchFile(path);
    diskMtimes.current.delete(path);
    setOpenFiles(prev => {
      const newFiles = prev.filter(f => f.path !== path);
      // If closing active file, switch to another
      if (path === activeFile && newFiles.length > 0) {
        setActiveFile(newFiles[0].path);
      } else if (newFiles.length === 0) {
        setActiveFile(null);
      }
      return newFiles;
    });
  }

  // External file changes (agent writes, git checkout): auto-reload in the
  // editor unless the user has unsaved edits in that tab — then mark stale and
  // let them choose on save via the conflict guard.
  const openFilesRef = useRef(openFiles);
  openFilesRef.current = openFiles;
  useEffect(() => {
    const unsub = desktop.editor.onFileChanged(async ({ path }) => {
      const tab = openFilesRef.current.find((f) => f.path === path);
      if (!tab) return;
      const fresh = await desktop.editor.readFile(path);
      if (!fresh.ok || fresh.content === undefined) return;
      const stat = await desktop.editor.stat(path);
      if (stat.ok && stat.mtimeMs !== undefined) diskMtimes.current.set(path, stat.mtimeMs);
      const newContent = fresh.content;
      setOpenFiles((prev) => prev.map((f) =>
        f.path === path
          ? { ...f, content: newContent, dirty: f.dirty && f.content !== newContent }
          : f,
      ));
    });
    return unsub;
  }, []);

  function handleContentChange(path: string, content: string) {
    setOpenFiles(prev => prev.map(f =>
      f.path === path ? { ...f, content, dirty: true } : f
    ));
  }

  function handleSetActiveFile(path: string) {
    setActiveFile(path);
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

  async function setReasoningEffort(reasoningEffort: ReasoningEffort) {
    if (!state.settings) return;
    const provider = state.settings.providers.find((p) => p.id === state.settings?.activeProviderId);
    const modelKey = `${state.settings.activeProviderId}/${provider?.model ?? ''}`;
    const next = {
      ...state.settings,
      preferences: {
        ...state.settings.preferences,
        reasoningEffort,
        reasoningEffortByModel: {
          ...state.settings.preferences?.reasoningEffortByModel,
          [modelKey]: reasoningEffort,
        },
      },
    };
    // Persist first so a future/restarted bridge starts with the same real tier.
    await saveSettings(next);
    // If a bridge is already running, update it live for the very next turn.
    if (stateRef.current.agentStatus !== 'offline') {
      await desktop.agent.setEffort(reasoningEffort);
    }
  }

  async function setToolScope(toolScope: ToolScope) {
    if (!state.settings) return;
    const next = {
      ...state.settings,
      preferences: { ...state.settings.preferences, toolScope },
    };
    await saveSettings(next);
    if (stateRef.current.agentStatus !== 'offline') {
      await desktop.agent.setToolScope(toolScope);
    }
  }

  async function submitPrompt(text: string, files?: Array<{ path: string; name: string; size: number; category: string; mediaType?: string; icon: string }>, mentions?: MentionItem[]) {
    setMainView('chat');

    // ── AI action slash commands ───────────────────────────────────────────────
    // These commands require code context. Since the inline editor was removed,
    // users must use @filename to attach a file. If no file/mention is attached,
    // we surface a helpful message instead of sending an empty codeBlock.
    const hasCodeContext = (files && files.length > 0) || (mentions && mentions.some((m) => m.type === 'file'));

    if (text.startsWith('/explain')) {
      const extra = text.replace('/explain', '').trim();
      if (!hasCodeContext) {
        dispatch({ type: 'agent/event', event: { type: 'assistant_message', text: '请先用 **@文件名** 引用要解释的文件，再执行 /explain。' } });
        return;
      }
      const msg = `请解释以下引用文件的逻辑、复杂度和潜在问题${extra ? `（${extra}）` : ''}：`;
      return submitPrompt(msg, files, mentions);
    }
    if (text.startsWith('/fix')) {
      if (!hasCodeContext) {
        dispatch({ type: 'agent/event', event: { type: 'assistant_message', text: '请先用 **@文件名** 引用要修复的文件，再执行 /fix。' } });
        return;
      }
      const msg = '请修复以下引用文件中的 bug，只返回修改后的完整代码：';
      return submitPrompt(msg, files, mentions);
    }
    if (text.startsWith('/test')) {
      if (!hasCodeContext) {
        dispatch({ type: 'agent/event', event: { type: 'assistant_message', text: '请先用 **@文件名** 引用要测试的文件，再执行 /test。' } });
        return;
      }
      const msg = '请为以下引用文件生成完整的单元测试，覆盖主要分支和边界条件：';
      return submitPrompt(msg, files, mentions);
    }
    if (text.startsWith('/comment')) {
      if (!hasCodeContext) {
        dispatch({ type: 'agent/event', event: { type: 'assistant_message', text: '请先用 **@文件名** 引用要注释的文件，再执行 /comment。' } });
        return;
      }
      const msg = '请为以下引用文件添加规范的文档注释（JSDoc/类型注释），不要改变逻辑：';
      return submitPrompt(msg, files, mentions);
    }
    if (text.startsWith('/edit ')) {
      const instruction = text.replace('/edit ', '').trim();
      if (!hasCodeContext) {
        dispatch({ type: 'agent/event', event: { type: 'assistant_message', text: '请先用 **@文件名** 引用要修改的文件，再执行 /edit。' } });
        return;
      }
      const msg = `按照以下指令修改引用文件，只返回修改后的完整代码：\n指令：${instruction}`;
      return submitPrompt(msg, files, mentions);
    }

    // Expand @-mentions into real context before sending
    let expandedText = text;
    if (mentions && mentions.length > 0) {
      const parts: string[] = [];
      for (const m of mentions) {
        if (m.type === 'file' && m.path) {
          try {
            const content = await desktop.fs.read(m.path);
            parts.push(`**@${m.label}** (\`${m.path}\`):\n\`\`\`\n${content.slice(0, 6000)}\n\`\`\``);
          } catch { parts.push(`**@${m.label}** (\`${m.path}\`) — 无法读取`); }
        } else if (m.type === 'url' && m.path) {
          parts.push(`**@${m.label}**: ${m.path}`);
        }
      }
      if (parts.length > 0) {
        expandedText = `${text}\n\n--- 引用上下文 ---\n${parts.join('\n\n')}`;
      }
    }

    if (expandedText === '/help') {
      dispatch({
        type: 'agent/event',
        event: {
          type: 'assistant_message',
          text: [
            '常用命令：',
            '/help · /status · /model · /provider',
            '/explain · /fix · /test · /comment · /edit <指令>',
            '/git status · /git commit · /git publish <remote> <local-ref> <remote-branch>',
            '/rollback list|show|preview|apply <unit-id>',
            '/diff · /grep · /doctor',
            'Git 设置（分支前缀 / 合并方式 / 强制推送 / 草稿 PR / 提交与 PR 指引）在 设置 → Git，会写入工作区 .aicode/persona.md 供助手遵循。',
          ].join('\n'),
        },
      });
      return;
    }
    if (expandedText === '/status') {
      dispatch({ type: 'agent/event', event: { type: 'assistant_message', text: `agent=${state.agentStatus} workspace=${state.workspaceRoot}` } });
      return;
    }
    if (expandedText === '/model') {
      const provider = state.settings?.providers.find((item) => item.id === state.settings?.activeProviderId);
      dispatch({ type: 'agent/event', event: { type: 'assistant_message', text: provider ? provider.model : 'mock-code-agent-v1' } });
      return;
    }
    if (expandedText === '/provider') {
      const provider = state.settings?.providers.find((item) => item.id === state.settings?.activeProviderId);
      dispatch({ type: 'agent/event', event: { type: 'assistant_message', text: provider ? provider.label : 'Mock' } });
      return;
    }

    // Show the user's message immediately so it never silently disappears,
    // even if starting the agent or sending the prompt fails below.
    dispatch({ type: 'chat/user', text: expandedText });
    try {
      if (stateRef.current.agentStatus === 'offline') {
        dispatch({ type: 'agent/status', status: 'starting' });
        await desktop.agent.start(stateRef.current.activeSessionId ?? undefined);
      }
      const toolScope = (stateRef.current.settings?.preferences?.toolScope as ToolScope | undefined) ?? 'auto';
      await desktop.agent.prompt(expandedText, files, toolScope);
    } catch (error) {
      // Surface the real reason (e.g. "API key is missing") in the conversation
      // instead of failing silently, and reset so the next prompt can retry.
      const message = error instanceof Error ? error.message : String(error);
      dispatch({ type: 'agent/event', event: { type: 'error', message: `无法启动对话：${cleanIpcError(message)}` } });
      dispatch({ type: 'agent/status', status: 'offline' });
    }
  }

  async function cancelTurn() {
    await desktop.agent.cancel();
    // agent-bridge.cancel() now emits both turn_done and agent_offline, so the
    // agent/event listener will set agentStatus → 'offline' automatically.
    // We do NOT force 'ready' here; that would leave the bridge in a dead state
    // where prompt() would throw "Agent bridge is not running".
  }

  async function approve(requestId: string, decision: 'allow_once' | 'allow_session' | 'deny') {
    const approval = stateRef.current.chat.find((item) => item.kind === 'approval' && item.requestId === requestId);
    if ((approval?.kind === 'approval' && approval.decided) || approvingRequests.current.has(requestId)) return;
    approvingRequests.current.add(requestId);
    try {
      await desktop.agent.approve(requestId, decision);
      dispatch({ type: 'approval/decided', requestId, decision });
    } catch (error) {
      dispatch({ type: 'agent/event', event: { type: 'error', message: `审批提交失败：${cleanIpcError(error)}` } });
    } finally {
      approvingRequests.current.delete(requestId);
    }
  }

  async function undoTurn(turnId: string) {
    // Collect the real checkpoint ids this turn produced, then ask the CLI to
    // roll each file back to its pre-turn backup. The CLI owns the actual
    // restore; the UI only reflects success/failure.
    const turn = stateRef.current.chat.find((item) => item.id === turnId);
    if (!turn || turn.kind !== 'turn') return;
    const checkpointIds = turn.files.flatMap((file) => file.checkpointIds);
    if (checkpointIds.length === 0) return;
    dispatch({ type: 'turn/undo-state', turnId, undo: 'undoing' });
    try {
      const result = await desktop.agent.undo(checkpointIds);
      dispatch({ type: 'turn/undo-state', turnId, undo: result.ok ? 'undone' : 'failed' });
      if (result.ok) {
        // Refresh the file tree so reverted content shows.
        if (stateRef.current.workspaceRoot) {
          const tree = await desktop.workspace.getTree('.');
          dispatch({ type: 'tree/loaded', tree });
        }
      }
    } catch {
      dispatch({ type: 'turn/undo-state', turnId, undo: 'failed' });
    }
  }

  function newChat() {
    // Detaching while the agent is still running would leave the CLI child
    // writing files "in the background" with the UI showing an empty chat.
    // Restart the bridge so the old turn dies with its process.
    if (stateRef.current.agentStatus === 'running' || stateRef.current.agentStatus === 'starting') {
      void desktop.agent.restart();
    }
    // The CLI persists the live session to .aicode/sessions as it runs, so a
    // fresh chat just detaches from the current one; nothing is lost.
    dispatch({ type: 'chat/clear' });
    setMainView('chat');
    refreshSessions();
  }

  async function openSession(id: string) {
    // Same guard as newChat: never leave a live bridge attached while the UI
    // swaps to a different session — events from the old turn would bleed in.
    if (stateRef.current.agentStatus === 'running' || stateRef.current.agentStatus === 'starting') {
      try { await desktop.agent.restart(); } catch { /* next prompt will retry start */ }
    }
    try {
      const record = await desktop.sessions.load(id);
      dispatch({ type: 'chat/load', sessionId: id, chat: sessionToChat(record) });
      setMainView('chat');
    } catch {
      dispatch({ type: 'agent/event', event: { type: 'error', message: `无法加载会话 ${id}` } });
    }
  }

  async function handleConvoAction(action: string, sessionId: string) {
    const meta = sessions.find((s) => s.id === sessionId);
    switch (action) {
      case 'continue-chat':
        await openSession(sessionId);
        return;
      case 'remove':
        await desktop.sessions.delete(sessionId);
        if (stateRef.current.activeSessionId === sessionId) dispatch({ type: 'chat/clear' });
        refreshSessions();
        return;
      case 'archive':
        await desktop.sessions.archive(sessionId, true);
        if (stateRef.current.activeSessionId === sessionId) dispatch({ type: 'chat/clear' });
        refreshSessions();
        return;
      case 'rename': {
        // sessionId may carry "id::newTitle" from the inline Rail rename
        const sep = sessionId.indexOf('::');
        if (sep !== -1) {
          const id = sessionId.slice(0, sep);
          const title = sessionId.slice(sep + 2);
          if (title.trim()) { await desktop.sessions.rename(id, title.trim()); refreshSessions(); }
        }
        return;
      }
      case 'pin':
        await desktop.sessions.pin(sessionId, !(meta?.pinned));
        refreshSessions();
        return;
      case 'reveal':
        await desktop.sessions.reveal(sessionId);
        return;
      case 'copy-id':
        await desktop.clipboard.write(sessionId);
        return;
      case 'copy-cwd':
        await desktop.clipboard.write(stateRef.current.workspaceRoot);
        return;
      case 'copy-deeplink':
        await desktop.clipboard.write(`yoycode://session/${sessionId}`);
        return;
      default:
        // move / continue-worktree / open-window need multi-window / git
        // backends that don't exist yet; surface an honest note.
        dispatch({ type: 'agent/event', event: { type: 'assistant_message', text: `该操作（${action}）尚未接入。` } });
    }
  }

  function handleLaunch(id: string) {
    if (id === 'files') { setMainView('files'); return; }
    // terminal from ChatLauncher → floating window
    if (id === 'terminal') { setTerminalFloatOpen(true); return; }
    if (id === 'side-chat') { dispatch({ type: 'sidechat/toggle' }); return; }
    if (id === 'browser') { dispatch({ type: 'browser/toggle' }); return; }
    dispatch({ type: 'agent/event', event: { type: 'assistant_message', text: `未知操作：${id}` } });
  }

  // During the brief startup restore, show a neutral splash instead of the
  // folder picker. Restore always resolves a workspace (last-used or home), so
  // Welcome only appears if restore genuinely failed to set any root.
  if (booting) return <main className="app-shell" />;
  if (!state.workspaceRoot) return <main className="app-shell"><Welcome onOpenWorkspace={openWorkspace} /></main>;

  if (mainView === 'settings' && state.settings) {
    return (
      <SettingsView
        settings={state.settings}
        onBack={() => setMainView('chat')}
        onSave={saveSettings}
        onSaveKey={saveApiKey}
        initialPage={settingsPage}
      />
    );
  }

  const titleMap: Record<MainView, { icon: JSX.Element; label: string }> = {
    chat: { icon: <MessageSquare size={16} />, label: '对话' },
    files: { icon: <FilesIcon size={16} />, label: '文件' },
    git: { icon: <GitBranch size={16} />, label: 'Git' },
    automation: { icon: <CalendarClock size={16} />, label: '自动化' },
    settings: { icon: <SettingsIcon size={16} />, label: '设置' },
    editor: { icon: <FileCode size={16} />, label: '编辑器' },
  };

  return (
    <div
      className="chat-shell"
      style={{
        // Drive the grid's 3rd column width from state so browser/sidechat panels
        // actually resize when the user drags. The column is `auto` in CSS but
        // overridden here with the live pixel value.
        gridTemplateColumns: `280px minmax(0,1fr) ${
          state.browserOpen ? `${state.browserWidth}px`
          : state.sideChatOpen ? `${state.sideChatWidth}px`
          : 'auto'
        }`,
      } as React.CSSProperties}
    >
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
        onConvoAction={handleConvoAction}
        onOpenSession={openSession}
      />
      <div className="main">
        <div className="main-topbar">
          <div className="main-title">{titleMap[mainView].icon}<span>{titleMap[mainView].label}</span></div>
          {mainView === 'chat' && state.taskSummary && (
            <TaskCard 
              summary={state.taskSummary}
              chat={state.chat}
              onToggle={() => dispatch({ type: 'task/toggle' })}
            />
          )}
          <span className="main-topbar-spacer" />
          <div className="main-tabs">
            <button className={`main-tab ${mainView === 'chat' ? 'active' : ''}`} onClick={() => setMainView('chat')}>对话</button>
            <button className={`main-tab ${mainView === 'editor' ? 'active' : ''}`} onClick={() => setMainView('editor')}>编辑器</button>
            {openFiles.length > 0 && <span className="main-tab-badge">{openFiles.length}</span>}
          </div>
          <div className="window-controls">
            <button className="window-control" title="最小化" onClick={() => void desktop.window.minimize()}><Minimize2 size={15} /></button>
            <button className="window-control" title="最大化 / 还原" onClick={() => void desktop.window.toggleMaximize()}><AppWindow size={15} /></button>
            <button
              className={`window-control ${infoPanelOpen ? 'active' : ''}`}
              title="概览面板"
              onClick={() => setInfoPanelOpen(v => !v)}
            >
              <LayoutDashboard size={15} />
            </button>
            <button
              className={`window-control ${state.bottomOpen ? 'active' : ''}`}
              title="底部面板"
              onClick={() => dispatch({ type: 'bottom/toggle' })}
            >
              <PanelBottom size={15} />
            </button>
            <button
              className={`window-control ${state.preview.open ? 'active' : ''}`}
              title="预览栏"
              onClick={() => dispatch({ type: 'preview/toggle' })}
            >
              <PanelRight size={15} />
            </button>
          </div>
        </div>

        {mainView === 'chat' && (
          <ConversationStream
            state={state}
            onApprove={approve}
            onEditUser={(text) => setPrefill({ text, nonce: Date.now() })}
            onLaunch={handleLaunch}
            onUndo={undoTurn}
            onOpenFile={handleOpenFile}
            dispatch={dispatch}
          />
        )}

        {state.workPanelOpen && mainView === 'chat' && (
          <WorkDetailsPanel state={state} onClose={() => dispatch({ type: 'work/toggle' })} />
        )}

        {state.pendingDiffs.length > 0 && mainView !== 'settings' && (
          <DiffReview diffs={state.pendingDiffs} dispatch={dispatch} onApprove={approve} />
        )}

        {mainView === 'files' && (
          <div className="secondary">
            <FileTree tree={state.tree} onOpenFile={handleOpenFile} />
          </div>
        )}

        {mainView === 'git' && (
          <div className="secondary">
            <GitPanel forcePush={Boolean(state.settings?.preferences?.gitForcePush)} branchPrefix={typeof state.settings?.preferences?.gitBranchPrefix === 'string' ? state.settings.preferences.gitBranchPrefix : 'codex/'} />
          </div>
        )}

        {mainView === 'automation' && <AutomationPanel />}

        {mainView === 'editor' && (
          <EditorView
            openFiles={openFiles}
            activeFile={activeFile}
            onOpenFile={handleOpenFile}
            onSaveFile={handleSaveFile}
            onCloseFile={handleCloseFile}
            onContentChange={handleContentChange}
            onSetActive={handleSetActiveFile}
          />
        )}

        {mainView === 'chat' && (
          <Composer
            state={state}
            prefill={prefill}
            onSubmit={submitPrompt}
            onCancel={cancelTurn}
            onPickApproval={async (mode) => {
              if (!state.settings) return;
              await saveSettings({ ...state.settings, approval: mode });
            }}
            terminalOutput={terminalOutput}
            onPickPlugin={(plugin) => {
              dispatch({ type: 'agent/event', event: { type: 'assistant_message', text: `已选择插件：${plugin.name} — ${plugin.desc}` } });
            }}
            onPickModel={async (providerId, model) => {
              if (!state.settings) return;
              const providers = state.settings.providers.map((p) => (p.id === providerId ? { ...p, model } : p));
              const next = { ...state.settings, activeProviderId: providerId, providers };
              await saveSettings(next);
              // A running bridge was created with the old provider/model. If a
              // turn is mid-flight, DON'T kill it — a half-written file is worse
              // than a delayed switch. Defer restart until the turn ends.
              if (stateRef.current.agentStatus === 'running') {
                pendingRestartRef.current = true;
                dispatch({ type: 'agent/event', event: { type: 'info', message: '当前任务完成后将切换模型。' } });
                return;
              }
              if (stateRef.current.agentStatus !== 'offline') {
                dispatch({ type: 'agent/status', status: 'starting' });
                try {
                  await desktop.agent.restart();
                } catch (error) {
                  dispatch({ type: 'agent/event', event: {
                    type: 'error',
                    message: `切换模型失败：${error instanceof Error ? error.message : String(error)}`,
                  } });
                }
              }
            }}
            onPickEffort={(effort) => { void setReasoningEffort(effort); }}
            onPickToolScope={(toolScope) => { void setToolScope(toolScope); }}
            onManageModels={() => { setSettingsPage('model'); setMainView('settings'); }}
          />
        )}
      </div>

      <PreviewSidebar
        open={state.preview.open}
        width={state.preview.width}
        tabs={state.preview.tabs}
        activeTabId={state.preview.activeTabId}
        dispatch={dispatch}
        workspaceRoot={state.workspaceRoot}
      />

      <SideChatPanel
        open={state.sideChatOpen}
        width={state.sideChatWidth}
        mainAgentBusy={state.agentStatus === 'running' || state.agentStatus === 'starting'}
        onClose={() => dispatch({ type: 'sidechat/toggle' })}
        onWidthChange={(w) => dispatch({ type: 'sidechat/setWidth', width: w })}
        settings={state.settings}
      />

      <BrowserPanel
        open={state.browserOpen}
        width={state.browserWidth}
        onClose={() => dispatch({ type: 'browser/toggle' })}
        onWidthChange={(w) => dispatch({ type: 'browser/setWidth', width: w })}
      />

      {state.bottomOpen && (
        <Terminal
          cwd={state.workspaceRoot}
          onClose={() => dispatch({ type: 'bottom/toggle' })}
          onCaptureOutput={(text) => setTerminalOutput(text)}
        />
      )}

      {/* Floating terminal window — launched from ChatLauncher / Ctrl+T */}
      {terminalFloatOpen && (
        <TerminalFloat
          cwd={state.workspaceRoot}
          onClose={() => setTerminalFloatOpen(false)}
          onCaptureOutput={(text) => setTerminalOutput(text)}
        />
      )}

      {/* Info panel — floating overview card */}
      {infoPanelOpen && (
        <InfoPanel
          state={state}
          onOpenGitPanel={() => setMainView('git')}
          onOpenTerminal={() => { dispatch({ type: 'bottom/toggle' }); }}
        />
      )}
    </div>
  );
}
