import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { matchAction, resolveBindings, serializeChord } from './lib/keybindings';
import { applyBackground, normalizeBlur, normalizeDim, normalizeScope, readBackground } from './lib/background';
import { FolderOpen, MessageSquare, Files as FilesIcon, Settings as SettingsIcon, CalendarClock, GitBranch, FileCode, Gauge, Search, Braces, BookmarkCheck, History, BarChart3, StickyNote, Monitor, BrainCircuit, LayoutGrid } from 'lucide-react';
import { AutomationPanel } from './components/AutomationPanel';
import { GuiControlPanel } from './components/GuiControlPanel';
import { MemoryPanel } from './components/MemoryPanel';
import { CodeReviewPanel } from './components/CodeReviewPanel';
import { Composer } from './components/Composer';
import { ConversationStream } from './components/ConversationStream';
import { CoveragePanel } from './components/CoveragePanel';
import { DiffReview } from './components/DiffReview/DiffReview';
import { EditorView, type OpenFile } from './components/Editor/EditorView';
import { FileTree } from './components/FileTree';
import { GitPanel } from './components/GitPanel';
import { GitCapsule } from './components/GitCapsule';
import { InspectorSidebar } from './components/InspectorSidebar';
import type { InspectorLevel } from './lib/inspectorNav';
import { HelpOverlay, type HelpOverlayTab } from './components/HelpOverlay';
import { InfoPanel } from './components/InfoPanel';
import { PerformancePanel } from './components/PerformancePanel';
import { PreviewSidebar } from './components/Preview/PreviewSidebar';
import { QualityDashboard } from './components/QualityDashboard';
import { RefactorPanel } from './components/RefactorPanel';
import { SideChatPanel } from './components/SideChatPanel';
import { BrowserPanel } from './components/BrowserPanel';
import { WorkDetailsPanel } from './components/WorkDetailsPanel';
import { WorkspaceToolsPanel } from './components/WorkspaceToolsPanel';
import { Rail } from './components/Rail';
import { NewTabPage } from './components/NewTabPage';
import { ARTIFACT_FILTERS, artifactTiles, toWorkspaceRelative, type ArtifactPluginId, type ArtifactTile, type NewTabAction } from './lib/newTab';
import { buildContextPanel, sessionOutputs } from './lib/contextSidebar';
import { CommandPalette, buildCommands, type CommandEntry } from './components/CommandPalette';
import { QuickOpen } from './components/QuickOpen';
import { SearchPanel } from './components/SearchPanel';
import { SnippetsPanel } from './components/SnippetsPanel';
import { BookmarksPanel } from './components/BookmarksPanel';
import { FileHistoryPanel } from './components/FileHistoryPanel';
import { CodeStatsPanel } from './components/CodeStatsPanel';
import { SessionNotesDrawer, NOTES_DRAFT_KEY, NOTES_WIDTH } from './components/SessionNotesDrawer';
import { SettingsView, type SettingsNavId } from './components/Settings/SettingsView';
import { TaskCard } from './components/TaskCard';
import { Terminal } from './components/Terminal';
import { TerminalFloat } from './components/TerminalFloat';
import { ToastLayer, appNotice } from './components/ToastLayer';
import { ApprovalModal } from './components/ApprovalModal';
import { GuardConfirmationModal } from './components/GuardConfirmationModal';
import { ConfirmDialog } from './components/ConfirmDialog';
import { SaveConflictDialog } from './components/SaveConflictDialog';
import { useEditorSave } from './lib/useEditorSave';
import { cueForEvent, playCue, soundVolume } from './lib/notifySounds';
import { Welcome } from './components/Welcome';
import { desktop } from './lib/ipc';
import { settingsPatch, type SettingsPatch } from './lib/settingsPatch';
import { appReducer, initialState, languageForPath, sessionChangeTotals, activeTurnProgress, sessionToChat } from './lib/state';
import { queueForSession } from './lib/messageQueueSelect';
import { returnedQueueMessages } from './lib/cancelledQueue';
import { decideQueuePump, pumpSessionId } from './lib/queuePump';
import { setLanguageWorkspaceRoot } from './lib/languageProviders';
import { transcriptFileName, transcriptToMarkdown } from './lib/transcriptExport';
import { loadRecent, rankRecent, touchRecent, type RecentFile } from './lib/recentFiles';
import type { MentionItem } from './components/MentionPicker';
import type { ApprovalMode, ChatItem, PreviewFileDescriptor, ProjectDescriptor, ReasoningEffort, SessionMeta, ThemeMode, ToolScope } from './types';

type MainView = 'newtab' | 'chat' | 'files' | 'search' | 'snippets' | 'bookmarks' | 'history' | 'stats' | 'git' | 'automation' | 'settings' | 'editor' | 'quality' | 'computer' | 'memory';
type QualityOverlay = 'review' | 'coverage' | 'performance' | 'refactor' | null;

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
  // 新标签页的工件格来自插件注册表（不是写死的四张图）：插件被禁用或宿主缺
  // 依赖时，这一页必须跟着变灰，所以每次进入这一页都重新读一次。
  const [newTabArtifacts, setNewTabArtifacts] = useState<ArtifactTile[]>([]);
  useEffect(() => {
    if (mainView !== 'newtab') return;
    let cancelled = false;
    Promise.all([desktop.plugins.catalog(), desktop.plugins.status()])
      .then(([defs, status]) => { if (!cancelled) setNewTabArtifacts(artifactTiles(defs, status)); })
      .catch(() => { if (!cancelled) setNewTabArtifacts([]); });
    return () => { cancelled = true; };
  }, [mainView]);
  // Quality workspace: sub-panels open as overlays above the dashboard view.
  const [qualityOverlay, setQualityOverlay] = useState<QualityOverlay>(null);
  // Line-reveal request from quality panels into the Monaco editor.
  const [pendingReveal, setPendingReveal] = useState<{ path: string; line: number } | null>(null);
  // Versioned Help / What's New overlay (Rail help menu).
  const [helpOverlay, setHelpOverlay] = useState<HelpOverlayTab | null>(null);
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const [booting, setBooting] = useState(true);
  const [settingsPage, setSettingsPage] = useState<SettingsNavId | undefined>(undefined);
  // Terminal output ring-buffer for @terminal mention
  const [terminalOutput, setTerminalOutput] = useState<string>('');
  // Floating terminal window (command palette → "Toggle Floating Terminal").
  const [terminalFloatOpen, setTerminalFloatOpen] = useState(false);
  // Info panel visibility
  const [infoPanelOpen, setInfoPanelOpen] = useState(false);
  const [workspaceToolsOpen, setWorkspaceToolsOpen] = useState(false);
  const [workspaceToolsWidth, setWorkspaceToolsWidth] = useState(420);
  // Per-session inspector: the right column opened from the conversation's Git
  // capsule. Its navigation stack lives in the component (lib/inspectorNav).
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorWidth, setInspectorWidth] = useState(400);
  // Which level the capsule asked for; consumed when the inspector opens.
  const [inspectorLevel, setInspectorLevel] = useState<InspectorLevel | undefined>(undefined);
  const [inspectorNonce, setInspectorNonce] = useState(0);
  // Ctrl+O: Codex-style global expand/collapse of every tool step detail.
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  // Iteration 2: fuzzy command palette (Ctrl+Shift+P).
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Iteration 10: session notes drawer.
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesDraft, setNotesDraft] = useState(false);
  const [workspaceConfirm, setWorkspaceConfirm] = useState<'dirty' | 'running' | null>(null);
  // The drawer only mounts while open, so it cannot report its draft while
  // closed. Seed the flag from the same localStorage key it writes, and read it
  // again whenever the drawer closes, so the dot outlives a close/reopen.
  useEffect(() => {
    if (notesOpen) return;
    setNotesDraft(Boolean(localStorage.getItem(NOTES_DRAFT_KEY)?.trim()));
  }, [notesOpen]);
  // Iteration 13: recently-opened files (per workspace, localStorage-backed).
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  // Iteration 17: Ctrl+P quick-open file palette.
  const [quickOpen, setQuickOpen] = useState(false);
  // Iteration 18: workspace session tags (sessionId -> tags[]).
  const [sessionTags, setSessionTags] = useState<Record<string, string[]>>({});
  // 子智能体目录: number of subagents currently running, for the tab badge.
  const [runningSubagentCount, setRunningSubagentCount] = useState(0);

  // Track running subagents from the agent stream. The directory panel polls
  // the store for its own list; this counter exists so the badge is right even
  // while the panel is closed.
  useEffect(() => {
    const off = desktop.agent.onEvent((event) => {
      if (event.type === 'subagent_started') setRunningSubagentCount((n) => n + 1);
      else if (event.type === 'subagent_done') setRunningSubagentCount((n) => Math.max(0, n - 1));
      // A dead bridge can never send the matching done events, so clear the
      // counter instead of leaving a badge stuck on a finished run.
      else if (event.type === 'agent_offline') setRunningSubagentCount(0);
    });
    return off;
  }, []);

  // Reload tags when the workspace changes; they live in a workspace sidecar.
  useEffect(() => {
    if (!state.workspaceRoot) { setSessionTags({}); return; }
    let cancelled = false;
    desktop.tags.listAll().then((map) => { if (!cancelled) setSessionTags(map); }).catch(() => { /* sidecar unreadable: no tags */ });
    return () => { cancelled = true; };
  }, [state.workspaceRoot, sessions]);

  async function handleSetTags(sessionId: string, tags: string[]) {
    try {
      const out = await desktop.tags.set(sessionId, tags);
      if (!out.ok) {
        dispatch({ type: 'agent/event', event: { type: 'error', message: `保存标签失败：${out.error ?? '未知错误'}` } });
        return;
      }
      setSessionTags((prev) => {
        const next = { ...prev };
        if (tags.length === 0) delete next[sessionId];
        else next[sessionId] = tags;
        return next;
      });
    } catch (error) {
      dispatch({ type: 'agent/event', event: { type: 'error', message: `保存标签失败：${cleanIpcError(error)}` } });
    }
  }

  // Reload the recent list whenever the workspace changes (iteration 13).
  useEffect(() => {
    setRecentFiles(state.workspaceRoot ? rankRecent(loadRecent(state.workspaceRoot)) : []);
  }, [state.workspaceRoot]);
  // Editor state
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const openFilesRef = useRef(openFiles);
  openFilesRef.current = openFiles;
  // Last-known on-disk mtime per open file, for external-change conflict checks.
  const diskMtimes = useRef<Map<string, number>>(new Map());
  // Deferred bridge restart: set when the user switches model mid-turn.
  const pendingRestartRef = useRef(new Set<string>());
  const switchingSessionRef = useRef(false);
  const switchSequenceRef = useRef(0);
  const approvingRequests = useRef(new Set<string>());
  // Closes the window between writing a prompt to the bridge and the CLI's
  // turn_start arriving. The pump effect re-fires on the queue change the send
  // itself causes, so without this a second message would be pushed immediately.
  const sendInFlightRef = useRef(new Set<string>());
  const pendingSubmissionRef = useRef<{ cancelled: boolean; sequence: number; root: string } | null>(null);
  const queueLoadedRootRef = useRef('');
  const [activeFile, setActiveFile] = useState<string | null>(null);

  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    const root = state.workspaceRoot;
    queueLoadedRootRef.current = '';
    if (!root || !desktop.messageQueue) return;
    let stale = false;
    void desktop.messageQueue.load(root).then(snapshot => {
      if (stale || root !== stateRef.current.workspaceRoot) return;
      queueLoadedRootRef.current = root;
      dispatch({ type: 'queue/hydrate', messages: snapshot.messages, pausedSessions: snapshot.pausedSessions });
    }).catch(error => { if (!stale) appNotice('读取暂存消息失败，原文件已保留', cleanIpcError(error)); });
    return () => { stale = true; };
  }, [state.workspaceRoot]);

  useLayoutEffect(() => {
    const root = state.workspaceRoot;
    if (!root || queueLoadedRootRef.current !== root || !desktop.messageQueue) return;
    void desktop.messageQueue.save(root, { messages: state.messageQueue, pausedSessions: state.queuePausedSessions ?? [] }).catch(error => appNotice('暂存消息保存失败', cleanIpcError(error)));
  }, [state.workspaceRoot, state.messageQueue, state.queuePausedSessions]);
  const editorSave = useEditorSave({
    workspaceRoot: state.workspaceRoot,
    getFiles: () => openFilesRef.current,
    setFiles: setOpenFiles,
    mtimes: diskMtimes.current,
    editor: desktop.editor,
    onError: (message) => appNotice('文件操作已中止', cleanIpcError(message)),
  });
  const handleSaveFile = editorSave.saveFile;

  useEffect(() => {
    desktop.settings.get().then((settings) => {
      dispatch({ type: 'settings/loaded', settings });
      applyTheme(settings.preferences?.theme);
    });
    // Auto-restore the last *project* workspace. Main never roots at the home
    // directory anymore: when there is nothing usable it returns root:null and
    // we pop the folder picker once, because a home-dir workspace silently
    // breaks every git_*/workspace_* tool (fatal: not a git repository).
    desktop.workspace.restore().then(async ({ root }) => {
      if (!root) {
        const result = await desktop.workspace.open();
        if (result.canceled || !result.root) return;
        setLanguageWorkspaceRoot(result.root);
        dispatch({ type: 'workspace/opened', root: result.root });
        try {
          const tree = await desktop.workspace.getTree('.');
          dispatch({ type: 'tree/loaded', tree });
        } catch {
          // Unreadable folder shouldn't block startup.
        }
        return;
      }
      setLanguageWorkspaceRoot(root);
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
      const root = typeof event.workspaceRoot === 'string' ? event.workspaceRoot : null;
      if (root && root.replace(/\\/g, '/').toLowerCase() !== stateRef.current.workspaceRoot.replace(/\\/g, '/').toLowerCase()) return;
      if (event.type === 'cancel_ack') {
        const sessionId = typeof event.sessionId === 'string' ? event.sessionId : stateRef.current.activeSessionId ?? '';
        pauseQueue(sessionId);
        dispatch({ type: 'queue/restore', messages: returnedQueueMessages(event, sessionId) });
      }
      dispatch({ type: 'agent/event', event });
      // System notification cues (WebAudio): confirmation needed / task done
      // / error. Volume 0 (sounds off) short-circuits; auto-decided approvals
      // are silent by design. Never throws.
      const cue = cueForEvent(event as { type?: unknown; autoDecision?: unknown });
      if (cue) playCue(cue, soundVolume(stateRef.current.settings?.preferences));
      // A finished turn frees the conversation, so the next queued message may
      // go out. Keyed by the event's session so a background conversation drains
      // its own line rather than the one on screen. (The on-screen conversation
      // is also covered by the idle effect below; this call is what lets a
      // background conversation advance.)
      if (event.type === 'turn_done') {
        // justFinished: the dispatch above has not committed yet, so the state
        // still says this session is running. Without the flag the pump would
        // decide 'wait' and a background conversation's queue would stall — the
        // idle effect below only ever serves the conversation on screen.
        void pumpQueue(pumpSessionId(event.sessionId, stateRef.current.activeSessionId), { justFinished: true });
      }
      const finishedSession = typeof event.sessionId === 'string' ? event.sessionId : null;
      if (event.type === 'turn_done' && finishedSession && pendingRestartRef.current.has(finishedSession)) {
        pendingRestartRef.current.delete(finishedSession);
        try {
          const result = await desktop.agent.restart(finishedSession);
          if (stateRef.current.activeSessionId === finishedSession) dispatch({ type: 'agent/bind', sessionId: result.sessionId });
        } catch (error) {
          dispatch({ type: 'agent/event', event: { type: 'error', sessionId: finishedSession, message: `切换模型失败：${cleanIpcError(error)}` } });
        }
      }
      if (event.type === 'undo_done' && event.ok !== false && stateRef.current.workspaceRoot) {
        // The reducer already flips the requesting turn to `undone`; now refresh
        // the tree only after the CLI confirms the checkpoint restoration.
        try {
          const tree = await desktop.workspace.getTree('.');
          dispatch({ type: 'tree/loaded', tree });
        } catch {
          // Undo state remains authoritative even when a best-effort tree reload fails.
        }
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

  /*
   * Serve the queue whenever the answer to "can we send?" could have changed.
   *
   * Declarative on purpose. The original code triggered the drain from exactly
   * one place (`turn_done`), which is why a message queued while the agent was
   * idle or starting never went out: there was no turn to end, so nothing fired
   * and it hung above the composer forever. Enumerating more call sites would
   * reproduce that bug the next time a state transition is added; keying off the
   * state itself cannot.
   *
   * `messageQueue` is in the deps because the head of the line changing is
   * itself a reason to look again (a send finishing, or the user removing the
   * front entry). pumpQueue is a no-op when it decides 'wait' or 'idle', so the
   * effect is cheap to run often.
   */
  useEffect(() => {
    void pumpQueue(state.activeSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pumpQueue reads
    // live state through stateRef and is intentionally not a dependency: making
    // it one would re-create it every render and re-fire this effect forever.
  }, [state.activeSessionId, state.agentStatus, state.readySessions, state.runningSessions, state.messageQueue, state.queuePausedSessions]);

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
  //
  // --fs-base is the single knob for the whole interface scale: every type step
  // in styles.css is one of ten `calc(var(--fs-base) ± Npx)` tokens, so writing
  // this one variable moves the entire interface. It deliberately does NOT touch
  // the root font-size, which would scale icons and spacing along with the text.
  const uiFontSize = Number(state.settings?.preferences?.uiFontSize) || undefined;
  const codeFontSize = Number(state.settings?.preferences?.codeFontSize) || undefined;
  const chineseFont = String(state.settings?.preferences?.uiChineseFont || 'Microsoft YaHei UI, Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif');
  const englishFont = String(state.settings?.preferences?.uiEnglishFont || 'Inter, Segoe UI, system-ui, -apple-system, BlinkMacSystemFont, sans-serif');
  const interfaceLanguage = String(state.settings?.preferences?.['gen.language'] || 'auto');
  useEffect(() => {
    const root = document.documentElement;
    if (uiFontSize) root.style.setProperty('--fs-base', `${uiFontSize}px`);
    else root.style.removeProperty('--fs-base');
  }, [uiFontSize]);
  // --fs-code feeds the transcript's code surfaces (fenced blocks, inline code,
  // diffs, logs) and the Terminal; the Monaco editor takes the number directly.
  // Its stylesheet default is base-relative, so 界面字号 still moves code until
  // the user sets a code size of their own — see the token's comment.
  useEffect(() => {
    const root = document.documentElement;
    if (codeFontSize) root.style.setProperty('--fs-code', `${codeFontSize}px`);
    else root.style.removeProperty('--fs-code');
  }, [codeFontSize]);

  // Apply the selected language-specific UI font stack immediately.
  useEffect(() => {
    const root = document.documentElement;
    const systemIsChinese = /^zh/i.test(navigator.language);
    const useChinese = interfaceLanguage === 'zh' || (interfaceLanguage === 'auto' && systemIsChinese);
    root.style.setProperty('--font-ui-zh', chineseFont);
    root.style.setProperty('--font-ui-en', englishFont);
    root.style.setProperty('--font-ui', useChinese ? chineseFont : englishFont);
    root.lang = useChinese ? 'zh-CN' : 'en';
  }, [chineseFont, englishFont, interfaceLanguage]);

  // 外观页 pointerCursor / reduceMotion 偏好 → <html data-*> 属性，驱动 CSS。
  const pointerCursor = state.settings?.preferences?.['appearance.pointerCursor'] === true;
  const reduceMotion = state.settings?.preferences?.['appearance.reduceMotion'];
  useEffect(() => {
    const root = document.documentElement;
    if (pointerCursor) root.setAttribute('data-pointer-cursor', 'true');
    else root.removeAttribute('data-pointer-cursor');
    // 'on' 强制减动效；'system'/'off' 交给 OS prefers-reduced-motion。
    if (reduceMotion === 'on') root.setAttribute('data-reduce-motion', 'on');
    else root.removeAttribute('data-reduce-motion');
  }, [pointerCursor, reduceMotion]);

  // 外观页「背景」：启用后从主进程读取图片（data URL）并注入 CSS 变量。
  // backgroundVersion 变化时重新读取，因此换图后无需重启应用。
  const backgroundEnabled = state.settings?.preferences?.backgroundImage === true;
  const backgroundDim = normalizeDim(state.settings?.preferences?.backgroundDim);
  const backgroundBlur = normalizeBlur(state.settings?.preferences?.backgroundBlur);
  const backgroundScope = normalizeScope(state.settings?.preferences?.backgroundScope);
  const backgroundVersion = Number(state.settings?.preferences?.backgroundVersion) || 0;
  const [backgroundImage, setBackgroundImage] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!backgroundEnabled) {
      setBackgroundImage(null);
      return;
    }
    void readBackground().then((dataUrl) => {
      if (!cancelled) setBackgroundImage(dataUrl);
    });
    return () => { cancelled = true; };
  }, [backgroundEnabled, backgroundVersion]);
  useEffect(() => {
    applyBackground({
      dataUrl: backgroundEnabled ? backgroundImage : null,
      dim: backgroundDim,
      blur: backgroundBlur,
      scope: backgroundScope,
    });
  }, [backgroundEnabled, backgroundImage, backgroundDim, backgroundBlur, backgroundScope]);

  // Global keyboard shortcuts advertised by the launcher and shortcuts page.
  const workspaceToolsRef = useRef({ open: false, browserOpen: false, sideChatOpen: false, notesOpen: false, inspectorOpen: false });
  workspaceToolsRef.current = { open: workspaceToolsOpen, browserOpen: state.browserOpen, sideChatOpen: state.sideChatOpen, notesOpen, inspectorOpen };

  // The right column holds one surface at a time. Everything that opens one has
  // to close the others, or two components land in grid track 3 and the later
  // one paints over the earlier — which is how the notes drawer came to cover
  // the browser panel and its close button.
  const closeOtherPanels = useCallback((keep: 'notes' | 'tools' | 'inspector' | null) => {
    const snapshot = workspaceToolsRef.current;
    if (keep !== 'notes' && snapshot.notesOpen) setNotesOpen(false);
    if (keep !== 'tools' && snapshot.open) setWorkspaceToolsOpen(false);
    if (keep !== 'inspector' && snapshot.inspectorOpen) setInspectorOpen(false);
    if (snapshot.browserOpen) dispatch({ type: 'browser/toggle' });
    if (snapshot.sideChatOpen) dispatch({ type: 'sidechat/toggle' });
  }, [dispatch]);

  // Settings is an early-return branch of the app (it renders its own tree,
  // with no side panels and no conversation). A command that opens a panel from
  // there therefore did nothing visible: the palette closed, the flag flipped,
  // and the user stayed on the settings page. Commands that put something in
  // the right column or the conversation now also leave settings.
  const ensureChatVisible = useCallback(() => {
    setMainView((current) => (current === 'settings' ? 'chat' : current));
  }, []);

  // Browser and side chat live in the same track. Both have several entry
  // points (palette, shortcut, plugin list, panel close), and only some of them
  // consulted the exclusion rules, so the browser could open on top of the
  // notes drawer. These two helpers are now the only writers that open them.
  const toggleBrowserPanel = useCallback(() => {
    closeOtherPanels(null);
    dispatch({ type: 'browser/toggle' });
    ensureChatVisible();
  }, [closeOtherPanels, dispatch, ensureChatVisible]);

  const toggleSideChatPanel = useCallback(() => {
    closeOtherPanels(null);
    dispatch({ type: 'sidechat/toggle' });
    ensureChatVisible();
  }, [closeOtherPanels, dispatch, ensureChatVisible]);

  /**
   * 新标签页上方五个入口。每一项都落到 App 已经有的那份能力上，不新造一套
   * 状态机：文件走文件视图、浏览器和辅助对话走那两个面板的唯一开合入口、
   * 终端走底部面板、审查走源代码管理（差异就在那里看）。
   */
  const handleNewTabShortcut = useCallback((action: NewTabAction) => {
    switch (action) {
      case 'files': setMainView('files'); return;
      case 'browser': toggleBrowserPanel(); return;
      case 'terminal': dispatch({ type: 'bottom/toggle' }); return;
      case 'review': setMainView('git'); return;
      case 'sidechat': toggleSideChatPanel(); return;
    }
  }, [dispatch, toggleBrowserPanel, toggleSideChatPanel]);

  /**
   * 工件格「打开」：系统选择框按类型过滤，选中后交给同一条 openFile 流水线。
   *
   * 预览/读文件那几个 IPC 都只收工作区相对路径，所以这里必须把绝对路径换成
   * 相对的，越界的就地拒绝并说清原因——让主进程的围栏去拦，用户只会看到一句
   * 莫名其妙的失败。
   */
  const openArtifactFile = useCallback(async (id: ArtifactPluginId) => {
    const spec = ARTIFACT_FILTERS[id];
    if (!spec) return;
    const root = stateRef.current.workspaceRoot;
    if (!root) {
      appNotice('还没有工作区', '先打开一个项目文件夹，文档才能在预览面板里打开');
      return;
    }
    try {
      const picked = await desktop.files.pick({
        title: `打开${spec.label}`,
        filters: [{ name: spec.label, extensions: spec.extensions }],
      });
      if (!picked.ok) {
        if (!picked.canceled) appNotice('无法打开文件', picked.error ?? '未知错误');
        return;
      }
      if (!picked.path) return;
      const relative = toWorkspaceRelative(root, picked.path);
      if (relative === null) {
        appNotice('只能打开工作区内的文件', `${picked.path} 不在 ${root} 下`);
        return;
      }
      if (!relative) return;
      const opened = await handleOpenFile(relative);
      if (!opened) appNotice('无法预览该文件', `${relative} 打不开（格式不受支持或读取失败）`);
    } catch (error) {
      appNotice('无法打开文件', cleanIpcError(error));
    }
  }, [handleOpenFile]);

  const toggleNotesPanel = useCallback(() => {
    if (workspaceToolsRef.current.notesOpen) {
      setNotesOpen(false);
      return;
    }
    closeOtherPanels('notes');
    setNotesOpen(true);
    ensureChatVisible();
  }, [closeOtherPanels, ensureChatVisible]);
  const openWorkspaceTools = useCallback(() => {
    const snapshot = workspaceToolsRef.current;
    if (!snapshot.open) {
      if (snapshot.browserOpen) dispatch({ type: 'browser/toggle' });
      if (snapshot.sideChatOpen) dispatch({ type: 'sidechat/toggle' });
      setNotesOpen(false);
      setWorkspaceToolsOpen(true);
    }
  }, [dispatch]);

  // Open the right-hand inspector at a requested level. The right column holds
  // one panel at a time (browser / side chat / workspace tools / inspector), so
  // opening the inspector closes whichever of those was showing. The nonce
  // makes a repeat click on the same capsule segment re-seed the stack instead
  // of being swallowed by an unchanged prop.
  const openInspector = useCallback((level: InspectorLevel) => {
    const snapshot = workspaceToolsRef.current;
    if (snapshot.browserOpen) dispatch({ type: 'browser/toggle' });
    if (snapshot.sideChatOpen) dispatch({ type: 'sidechat/toggle' });
    setWorkspaceToolsOpen(false);
    setNotesOpen(false);
    setInspectorLevel(level);
    setInspectorNonce((n) => n + 1);
    setInspectorOpen(true);
  }, [dispatch]);
  // ── Global shortcuts (iteration 19: user-rebindable) ───────────────────
  // Overrides load once at boot and refresh when the settings page writes
  // new ones (zcode:keybindings-changed). matchAction resolves the owner
  // action id; each case below mirrors what the old hardcoded chain did.
  const [keybindOverrides, setKeybindOverrides] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    desktop.keybindings.get().then((map) => { if (alive) setKeybindOverrides(map); }).catch(() => { /* defaults stand */ });
    function onChanged() {
      desktop.keybindings.get().then((map) => setKeybindOverrides(map)).catch(() => undefined);
    }
    window.addEventListener('zcode:keybindings-changed', onChanged);
    return () => { alive = false; window.removeEventListener('zcode:keybindings-changed', onChanged); };
  }, []);
  const keyBindings = useMemo(() => resolveBindings(keybindOverrides), [keybindOverrides]);
  const keyBindingsRef = useRef(keyBindings);
  keyBindingsRef.current = keyBindings;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!event.ctrlKey && !event.metaKey && !event.altKey) return;
      const action = matchAction(event, keyBindingsRef.current);
      if (!action) return;
      // Ctrl+Alt+W keeps the old "not while typing" guard — it would eat
      // AltGr dead-keys in editors otherwise.
      if (action === 'workspace-tools') {
        const target = event.target as HTMLElement | null;
        const inEditable = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
        if (inEditable) return;
      }
      event.preventDefault();
      switch (action) {
        case 'palette': setPaletteOpen((v) => !v); return;
        case 'quick-open':
          // Iteration 17: quick-open when a workspace is loaded; with none
          // open it falls back to the explorer view.
          if (stateRef.current.workspaceRoot) setQuickOpen(true);
          else setMainView('files');
          return;
        case 'search-workspace': setMainView('search'); return;
        case 'bookmarks-view': setMainView('bookmarks'); return;
        case 'settings': setMainView('settings'); return;
        case 'toggle-terminal': dispatch({ type: 'bottom/toggle' }); return;
        case 'new-chat': dispatch({ type: 'chat/clear' }); setMainView('chat'); return;
        case 'toggle-details': setDetailsExpanded((v) => !v); return;
        case 'side-chat': toggleSideChatPanel(); return;
        case 'browser': toggleBrowserPanel(); return;
        case 'workspace-tools': {
          const snapshot = workspaceToolsRef.current;
          if (snapshot.open) setWorkspaceToolsOpen(false);
          else openWorkspaceTools();
          return;
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openWorkspaceTools, toggleBrowserPanel, toggleSideChatPanel]);

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
    // Unsaved edits die with the old workspace's tabs. Ask BEFORE the native
    // dialog so declining never leaves main/renderer root state inconsistent.
    const dirtyCount = openFilesRef.current.filter((file) => file.dirty).length;
    if (dirtyCount > 0) {
      setWorkspaceConfirm('dirty');
      return;
    }
    if (stateRef.current.runningSessions.length > 0 || stateRef.current.agentStatus === 'starting') {
      setWorkspaceConfirm('running');
      return;
    }
    await performOpenWorkspace();
  }

  /** 换工作区之后要清掉的一切：编辑器标签、待发消息、会话列表、语言服务根。 */
  async function applyWorkspaceSwitch(root: string, sequence: number) {
    resetEditorTabs();
    pendingRestartRef.current.clear();
    sendInFlightRef.current.clear();
    setSessions([]);
    setRunningSubagentCount(0);
    setLanguageWorkspaceRoot(root);
    dispatch({ type: 'workspace/opened', root });
    const tree = await desktop.workspace.getTree('.');
    if (sequence === switchSequenceRef.current) dispatch({ type: 'tree/loaded', tree });
  }

  async function performOpenWorkspace() {
    const sequence = ++switchSequenceRef.current;
    switchingSessionRef.current = true;
    try {
      const result = await desktop.workspace.open();
      if (sequence !== switchSequenceRef.current || result.canceled || !result.root) return;
      await applyWorkspaceSwitch(result.root, sequence);
    } catch (error) {
      dispatch({ type: 'agent/event', event: { type: 'error', message: `切换工作区失败：${cleanIpcError(error)}` } });
    } finally {
      if (sequence === switchSequenceRef.current) switchingSessionRef.current = false;
    }
  }

  /**
   * 切到「最近工作区」里的某一个（常驻侧栏的环境区）。
   *
   * 和打开文件夹走同一套收尾（清标签、停待发消息、重建树），只是路径由用户从
   * 列表里点选，不再弹系统对话框。脏文件/运行中这两道门禁一样适用——那正是
   * `workspaceConfirm` 存在的理由。
   */
  async function switchToWorkspace(root: string) {
    if (root === stateRef.current.workspaceRoot) return;
    const dirtyCount = openFilesRef.current.filter((file) => file.dirty).length;
    if (dirtyCount > 0) {
      setWorkspaceConfirm('dirty');
      return;
    }
    if (stateRef.current.runningSessions.length > 0 || stateRef.current.agentStatus === 'starting') {
      setWorkspaceConfirm('running');
      return;
    }
    const sequence = ++switchSequenceRef.current;
    switchingSessionRef.current = true;
    try {
      const result = await desktop.workspace.setRoot(root);
      if (sequence !== switchSequenceRef.current || !result.root) return;
      await applyWorkspaceSwitch(result.root, sequence);
    } catch (error) {
      dispatch({ type: 'agent/event', event: { type: 'error', message: `切换工作区失败：${cleanIpcError(error)}` } });
    } finally {
      if (sequence === switchSequenceRef.current) switchingSessionRef.current = false;
    }
  }

  async function openPreviewFile(path: string): Promise<boolean> {
    const desc = await desktop.preview.describe(path);
    if (desc.kind === 'text') return false;
    dispatch({
      type: 'preview/open',
      tab: {
        id: `preview-${desc.relativePath}`,
        title: desc.name,
        kind: desc.kind,
        descriptor: desc,
        status: desc.kind === 'pdf' || desc.kind === 'html' ? 'loading' : 'ready',
        zoom: 1,
        fitWidth: true,
      },
    });
    return true;
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
    const file = activeFile ? openFilesRef.current.find((candidate) => candidate.path === activeFile) : undefined;
    if (file) await handleSaveFile(file.path, file.content);
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

  async function handleOpenFile(path: string, options?: { asText?: boolean }): Promise<boolean> {
    const root = stateRef.current.workspaceRoot;
    try {
      if (!options?.asText && await openPreviewFile(path)) return true;
    } catch (error) {
      appNotice('无法打开文件', cleanIpcError(error));
      return false;
    }
    if (stateRef.current.workspaceRoot !== root) return false;
    // Check if already open
    if (openFiles.find(f => f.path === path)) {
      setActiveFile(path);
      setMainView('editor');
      return true;
    }

    // Read file content
    const result = await desktop.editor.readFile(path);
    if (!result.ok) {
      appNotice('无法打开文件', result.error || '未知错误');
      return false;
    }
    const fileContent = result.content ?? '';
    if (stateRef.current.workspaceRoot !== root) return false;
    // Record on-disk mtime and start watching for external (agent) writes.
    const stat = await desktop.editor.stat(path);
    if (stateRef.current.workspaceRoot !== root) return false;
    if (stat.ok && stat.mtimeMs !== undefined) diskMtimes.current.set(path, stat.mtimeMs);
    void desktop.editor.watchFile(path);

    const newFile = {
      path,
      content: fileContent,
      dirty: false,
      language: detectLanguage(path),
    };

    // Iteration 13: remember the file per workspace for the rail quick list.
    setRecentFiles(rankRecent(touchRecent(stateRef.current.workspaceRoot, path, fileContent.length)));

    setOpenFiles(prev => prev.some((file) => file.path === path) ? prev : [...prev, newFile]);
    setActiveFile(path);
    setMainView('editor');
    return true;
  }

  /** Open a file from a quality panel and reveal a 1-based line in Monaco. */
  async function handleOpenFileAtLine(path: string, line?: number) {
    const root = stateRef.current.workspaceRoot;
    const revealLine = line !== undefined && Number.isFinite(line) && line >= 1 ? Math.floor(line) : null;
    const opened = await handleOpenFile(path, { asText: revealLine !== null });
    if (opened && stateRef.current.workspaceRoot === root && revealLine !== null) {
      setPendingReveal({ path, line: revealLine });
    }
  }

  /**
   * Start `/review` in the active conversation.
   *
   * Sent as a normal user message rather than through a dedicated IPC channel:
   * the CLI intercepts `/review` inside runPromptMode, so it travels the same
   * path as anything the user types — one implementation, and the queued-message
   * handling applies for free. The findings come back as a `review_report`
   * event, not as this call's return value.
   */
  async function ensureSession(): Promise<string> {
    const root = stateRef.current.workspaceRoot;
    const sequence = switchSequenceRef.current;
    const requested = stateRef.current.activeSessionId;
    const result = await desktop.agent.start(requested ?? undefined);
    if (sequence !== switchSequenceRef.current || root !== stateRef.current.workspaceRoot) throw new Error('会话或工作区已切换，未发送此消息');
    dispatch({ type: 'agent/bind', sessionId: result.sessionId });
    if (result.running) dispatch({ type: 'agent/event', event: { type: 'turn_start', sessionId: result.sessionId } });
    if (result.taskBoard) dispatch({ type: 'agent/event', event: { ...result.taskBoard, type: 'task_board_updated', sessionId: result.sessionId } });
    return result.sessionId;
  }

  async function runReview() {
    if (stateRef.current.agentStatus === 'running') {
      dispatch({ type: 'agent/event', event: { type: 'info', message: '当前回合进行中，请等它结束后再审查。' } });
      return;
    }
    dispatch({ type: 'chat/user', text: '/review' });
    try {
      const sessionId = await ensureSession();
      const toolScope = (stateRef.current.settings?.preferences?.toolScope as ToolScope | undefined) ?? 'auto';
      await desktop.agent.prompt('/review', [], toolScope, sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatch({ type: 'agent/event', event: { type: 'error', message: `无法启动审查：${cleanIpcError(message)}` } });
    }
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

  // External file changes (agent writes, git checkout): reload clean tabs, but
  // preserve dirty local content and keep the latest disk snapshot as stale
  // metadata so a later save can make an explicit overwrite decision.
  //
  // Preview panes are refreshed from the same event. They watch their own files
  // (see the effect below) and this is what makes an agent's edit to an open
  // .docx/.xlsx/.pptx actually redraw the pane: the reducer bumps that one tab's
  // `revision`, the pane is keyed on it, and the component remounts and re-reads.
  // Without this the pane keeps showing the bytes the agent just replaced.
  useEffect(() => {
    const unsub = desktop.editor.onFileChanged(async ({ path }) => {
      dispatch({ type: 'preview/changed', absolutePath: path });

      const tab = openFilesRef.current.find((f) => f.path === path);
      if (!tab) return;
      const fresh = await desktop.editor.readFile(path);
      if (!fresh.ok || fresh.content === undefined) return;
      const stat = await desktop.editor.stat(path);
      const mtimeMs = stat.ok ? stat.mtimeMs : undefined;
      if (mtimeMs !== undefined) diskMtimes.current.set(path, mtimeMs);
      const newContent = fresh.content;
      setOpenFiles((prev) => prev.map((f) => {
        if (f.path !== path) return f;
        if (!f.dirty) {
          return { ...f, content: newContent, external: undefined, stale: false };
        }
        // Do not replace the Monaco value while the user has local edits.
        return {
          ...f,
          external: { content: newContent, mtimeMs },
          stale: f.content !== newContent,
        };
      }));
    });
    return unsub;
  }, []);

  function handleContentChange(path: string, content: string) {
    setOpenFiles(prev => prev.map(f =>
      f.path === path ? { ...f, content, dirty: true, stale: f.stale } : f
    ));
  }

  // Watch the files the preview panes are showing, so an agent's write to an
  // open document reaches the pane. Watching is refcounted per path in the main
  // process, so a file open in both an editor tab and a preview pane keeps
  // working when either one closes.
  //
  // Only DOM-rendered documents are watched. A `web` pane is a running dev
  // server, which reloads itself, and forcing a re-read on every workspace write
  // would fight it.
  const previewWatchRef = useRef(new Set<string>());
  useEffect(() => {
    const watched = previewWatchRef.current;
    const wanted = new Set(
      state.preview.tabs
        .filter((tab) => tab.kind === 'docx' || tab.kind === 'xlsx' || tab.kind === 'pptx' || tab.kind === 'pdf' || tab.kind === 'image' || tab.kind === 'html')
        .map((tab) => (tab.descriptor as { absolutePath?: string }).absolutePath)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    );

    for (const path of wanted) {
      if (watched.has(path)) continue;
      watched.add(path);
      void desktop.editor.watchFile(path);
    }
    for (const path of [...watched]) {
      if (wanted.has(path)) continue;
      watched.delete(path);
      void desktop.editor.unwatchFile(path);
    }
  }, [state.preview.tabs]);

  // Stop watching everything when the workspace changes; the paths belong to the
  // old root and the panes are gone.
  useEffect(() => {
    return () => {
      for (const path of previewWatchRef.current) void desktop.editor.unwatchFile(path);
      previewWatchRef.current.clear();
    };
  }, [state.workspaceRoot]);

  function handleSetActiveFile(path: string) {
    setActiveFile(path);
  }

  async function saveSettings(next: SettingsPatch) {
    const settings = await desktop.settings.set(next);
    const hints = new Map(stateRef.current.settings?.providers.map((provider) => [provider.id, provider.keyHint]));
    dispatch({ type: 'settings/loaded', settings: {
      ...settings,
      providers: settings.providers.map((provider) => ({ ...provider, keyHint: provider.keyHint ?? hints.get(provider.id) })),
    } });
  }

  function saveSettingsSnapshot(next: NonNullable<typeof state.settings>) {
    const before = state.settings;
    if (before) return saveSettings(settingsPatch(before, next));
    return saveSettings(next);
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
    await saveSettings({ approval: next });
  }

  async function setReasoningEffort(reasoningEffort: ReasoningEffort) {
    if (!state.settings) return;
    const provider = state.settings.providers.find((p) => p.id === state.settings?.activeProviderId);
    const modelKey = `${state.settings.activeProviderId}/${provider?.model ?? ''}`;
    const next = {
      preferences: {
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
      await desktop.agent.setEffort(reasoningEffort, stateRef.current.activeSessionId ?? undefined);
    }
  }

  async function setToolScope(toolScope: ToolScope) {
    if (!state.settings) return;
    await saveSettings({ preferences: { toolScope } });
    if (stateRef.current.agentStatus !== 'offline') {
      await desktop.agent.setToolScope(toolScope, stateRef.current.activeSessionId ?? undefined);
    }
  }

  async function submitPrompt(text: string, files?: Array<{ path: string; name: string; size: number; category: string; mediaType?: string; icon: string }>, mentions?: MentionItem[]) {
    if (switchingSessionRef.current) {
      dispatch({ type: 'agent/event', event: { type: 'info', message: '会话正在切换，请稍候再发送消息。' } });
      return;
    }
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

    // While a turn is in flight the CLI rejects a second prompt outright
    // ("Agent turn already running"), which used to lose whatever the user had
    // typed. Queue it instead and send it when the turn ends — submissions then
    // run in the order they were made.
    const sessionId = stateRef.current.activeSessionId;
    if (queueForSession(stateRef.current.messageQueue, sessionId).length === 0 && (stateRef.current.queuePausedSessions ?? []).includes(sessionId ?? '')) resumeQueue(sessionId ?? '');
    const currentSubmission = pendingSubmissionRef.current;
    const busy = stateRef.current.agentStatus === 'running' || stateRef.current.agentStatus === 'starting' || Boolean(currentSubmission && currentSubmission.sequence === switchSequenceRef.current && currentSubmission.root === stateRef.current.workspaceRoot);
    if (busy) {
      dispatch({
        type: 'queue/add',
        message: {
          id: `queued-${crypto.randomUUID()}`,
          sessionId: sessionId ?? '',
          text: expandedText,
          files: files?.map((file) => ({ path: file.path, name: file.name, size: file.size })),
          createdAt: Date.now(),
        },
      });
      // Submitting into a queue that is already being served needs no extra
      // push — the in-flight send will finish and the next trigger picks this
      // up. Only a queue that nothing is watching needs one.
      return;
    }

    // Show the user's message immediately so it never silently disappears,
    // even if starting the agent or sending the prompt fails below.
    dispatch({ type: 'chat/user', text: expandedText });
    const submittedRoot = stateRef.current.workspaceRoot;
    const submission = { cancelled: false, sequence: switchSequenceRef.current, root: submittedRoot };
    pendingSubmissionRef.current = submission;
    let submittedSessionId = sessionId;
    try {
      dispatch({ type: 'agent/status', status: 'starting' });
      const sessionId = await ensureSession();
      submittedSessionId = sessionId;
      if (submission.cancelled) throw new Error('Agent bridge cancelled before sending');
      const toolScope = (stateRef.current.settings?.preferences?.toolScope as ToolScope | undefined) ?? 'auto';
      await desktop.agent.prompt(expandedText, files, toolScope, sessionId);
    } catch (error) {
      if (submittedRoot !== stateRef.current.workspaceRoot || submission.sequence !== switchSequenceRef.current) return;
      // Surface the real reason (e.g. "API key is missing") in the conversation
      // instead of failing silently, and reset so the next prompt can retry.
      const message = error instanceof Error ? error.message : String(error);
      if (submission.cancelled || (/cancelled|canceled|not running/i.test(message) && (stateRef.current.queuePausedSessions ?? []).some(paused => paused === (submittedSessionId ?? '') || paused === ''))) {
        const owner = submittedSessionId ?? stateRef.current.activeSessionId ?? '';
        pauseQueue(owner);
        dispatch({ type: 'queue/restore', messages: [{ id: `cancelled-send-${crypto.randomUUID()}`, sessionId: owner, text: expandedText, files: files?.map(file => ({ path: file.path, name: file.name, size: file.size })), createdAt: Date.now() }] });
        return;
      }
      dispatch({ type: 'agent/event', event: { type: 'error', message: `无法启动对话：${cleanIpcError(message)}` } });
      dispatch({ type: 'agent/status', status: 'offline' });
    } finally { if (pendingSubmissionRef.current === submission) pendingSubmissionRef.current = null; }
  }

  /**
   * Send the next queued message for a conversation, if any.
   *
   * One entry point, called from every moment the answer could have changed —
   * not just `turn_done`. That single trigger was the bug: a message queued
   * while the agent was idle or still starting had no turn to wait for, so
   * nothing ever fired and it hung above the composer indefinitely.
   *
   * Only one message per call: the queue is a line, not a batch, so each runs
   * to completion before the next starts and the transcript stays ordered.
   * `sendInFlightRef` closes the gap between writing to the bridge and the
   * CLI's `turn_start` arriving — the effect re-fires on the queue change the
   * send itself causes, and without the guard it would push the next message
   * immediately, emptying the queue instead of showing what is still waiting.
   */
  async function pumpQueue(sessionId: string | null, options?: { justFinished?: boolean }) {
    if (!sessionId || sendInFlightRef.current.has(sessionId) || switchingSessionRef.current) return;
    const decision = decideQueuePump({
      paused: (stateRef.current.queuePausedSessions ?? []).some(paused => paused === sessionId || paused === ''),
      queue: stateRef.current.messageQueue,
      sessionId,
      // Per conversation, not the global status: several can run at once.
      sessionRunning: stateRef.current.runningSessions.includes(sessionId),
      bridgeReady: stateRef.current.readySessions.includes(sessionId),
      sendInFlight: sendInFlightRef.current.has(sessionId),
      ...(options?.justFinished ? { justFinished: true } : {}),
    });
    if (decision.action !== 'send') return;

    const next = decision.message;
    sendInFlightRef.current.add(sessionId);
    try {
      // Adopt an orphaned entry — queued while the bridge was still starting, so
      // it carries no session id — into the conversation sending it. Until it is
      // adopted it would count as belonging to EVERY conversation.
      if (!next.sessionId) dispatch({ type: 'queue/adopt', id: next.id, sessionId });
      // Drop it before sending: a failure below must not leave it queued forever.
      dispatch({ type: 'queue/remove', id: next.id });
      dispatch({ type: 'chat/user', text: next.text, sessionId });
      const toolScope = (stateRef.current.settings?.preferences?.toolScope as ToolScope | undefined) ?? 'auto';
      await desktop.agent.prompt(next.text, next.files, toolScope, sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatch({ type: 'agent/event', event: { type: 'error', message: `队列消息发送失败：${cleanIpcError(message)}` } });
    } finally {
      sendInFlightRef.current.delete(sessionId);
    }
  }

  async function cancelTurn() {
    const sessionId = stateRef.current.activeSessionId;
    const submission = pendingSubmissionRef.current;
    if (submission && submission.sequence === switchSequenceRef.current && submission.root === stateRef.current.workspaceRoot) submission.cancelled = true;
    pauseQueue(sessionId ?? '');
    if (!sessionId) { dispatch({ type: 'agent/status', status: 'offline' }); return; }
    try { await desktop.agent.cancel(sessionId); }
    catch (error) { appNotice('停止未完成', cleanIpcError(error)); }
  }

  function pauseQueue(sessionId: string) {
    sessionId = sessionId || stateRef.current.activeSessionId || '';
    stateRef.current = { ...stateRef.current, queuePausedSessions: [...new Set([...(stateRef.current.queuePausedSessions ?? []), sessionId])] };
    dispatch({ type: 'queue/pause', sessionId });
  }

  function resumeQueue(sessionId: string) {
    stateRef.current = { ...stateRef.current, queuePausedSessions: (stateRef.current.queuePausedSessions ?? []).filter(paused => paused !== sessionId && !(paused === '' && sessionId === stateRef.current.activeSessionId)) };
    dispatch({ type: 'queue/resume', sessionId });
    void pumpQueue(sessionId || stateRef.current.activeSessionId);
  }

  // ── Command palette (iteration 2) ────────────────────────────────────────
  // Iteration 14: transcript export now flows through the shared Markdown
  // serializer (lib/transcriptExport) instead of an ad-hoc loop. "Copy" sends
  // the document to the clipboard; "Save" also writes it into the workspace
  // under .aicode/exports/ so it survives the session.
  async function exportChatMarkdown(saveToFile: boolean) {
    try {
      const title = stateRef.current.taskSummary?.title;
      const markdown = transcriptToMarkdown(stateRef.current.chat, {
        title,
        workspaceRoot: stateRef.current.workspaceRoot,
      });
      if (!saveToFile) {
        await desktop.clipboard.write(markdown);
        return;
      }
      const name = transcriptFileName(title).replace(/[^A-Za-z0-9._-]/g, '');
      await desktop.fs.write(`.aicode/exports/${name}`, markdown);
      dispatch({ type: 'agent/event', event: { type: 'assistant_message', text: `会话已导出到 \`.aicode/exports/${name}\`。` } });
    } catch (error) {
      dispatch({ type: 'agent/event', event: { type: 'error', message: `导出失败：${cleanIpcError(error)}` } });
    }
  }

  function setThemeMode(mode: 'light' | 'dark' | 'system') {
    const current = stateRef.current.settings;
    if (!current) return;
    void saveSettings({ preferences: { theme: mode } });
    applyTheme(mode);
  }

  const paletteCommands: CommandEntry[] = buildCommands({
    state,
    go: (view) => setMainView(view as MainView),
    newChat: () => { dispatch({ type: 'chat/clear' }); setMainView('chat'); },
    toggleTerminal: () => dispatch({ type: 'bottom/toggle' }),
    toggleTerminalFloat,
    toggleDetails: () => setDetailsExpanded((v) => !v),
    toggleSideChat: toggleSideChatPanel,
    toggleBrowser: toggleBrowserPanel,
    toggleWorkDetails: () => { dispatch({ type: 'work/toggle' }); ensureChatVisible(); },
    togglePreview: () => { dispatch({ type: 'preview/toggle' }); ensureChatVisible(); },
    toggleNotes: toggleNotesPanel,
    toggleWorkspaceTools: () => {
      // Reuse the helper so the panel exclusion rules stay in one place.
      if (workspaceToolsRef.current.open) setWorkspaceToolsOpen(false);
      else { openWorkspaceTools(); ensureChatVisible(); }
    },
    openSettings: (page) => { setSettingsPage(page as SettingsNavId | undefined); setMainView('settings'); },
    openWorkspace: () => { void openWorkspace(); },
    openQuickOpen: () => setQuickOpen(true),
    openHelp: () => setHelpOverlay('help'),
    cancelTurn: () => { void cancelTurn(); },
    setTheme: setThemeMode,
    exportChat: () => { void exportChatMarkdown(false); },
    saveChatFile: () => { void exportChatMarkdown(true); },
  });

  async function approve(requestId: string, decision: 'allow_once' | 'allow_session' | 'deny') {
    const approval = stateRef.current.chat.find((item) => item.kind === 'approval' && item.requestId === requestId);
    if ((approval?.kind === 'approval' && approval.decided) || approvingRequests.current.has(requestId)) return;
    approvingRequests.current.add(requestId);
    try {
      await desktop.agent.approve(requestId, decision, stateRef.current.activeSessionId ?? undefined);
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
      // IPC 成功仅表示命令已送入 CLI。保留 undoing，等待 CLI 的
      // `undo_done` 事件按同一个 turnId 写入真实的 undone/failed 结果。
      await desktop.agent.undo(checkpointIds, turnId, stateRef.current.activeSessionId ?? undefined);
    } catch {
      dispatch({ type: 'turn/undo-state', turnId, undo: 'failed' });
    }
  }

  async function newChat() {
    if (switchingSessionRef.current) return;
    const seq = ++switchSequenceRef.current;
    switchingSessionRef.current = true;
    try {
      // A new conversation starts its own CLI child. Any conversation still
      // running keeps running in the background — this no longer interrupts it,
      // so there is nothing to warn about. The session being left is dropped
      // from view only; its work continues and is on disk.
      if (seq !== switchSequenceRef.current) return;
      dispatch({ type: 'chat/clear' });
      setMainView('chat');
      refreshSessions();
    } finally {
      if (seq === switchSequenceRef.current) switchingSessionRef.current = false;
    }
  }

  async function openSession(id: string) {
    if (switchingSessionRef.current) return;
    const seq = ++switchSequenceRef.current;
    switchingSessionRef.current = true;
    try {
      // No interruption warning any more: each conversation has its own CLI
      // child, so switching views does not touch the session being left behind.
      // The old confirm existed because `agent.restart` killed the running task.
      const record = await desktop.sessions.load(id);
      if (seq !== switchSequenceRef.current) return;
      pendingRestartRef.current.delete(id);
      dispatch({ type: 'chat/load', sessionId: id, chat: sessionToChat(record) });
      setMainView('chat');
      // Ensure a bridge for the target session, but reuse one that is already
      // up — restarting would kill a turn that is still running there.
      try {
        const result = await desktop.agent.start(id);
        if (seq === switchSequenceRef.current) {
          dispatch({ type: 'agent/bind', sessionId: result.sessionId });
          if (result.running) dispatch({ type: 'agent/event', event: { type: 'turn_start', sessionId: result.sessionId } });
          if (result.taskBoard) dispatch({ type: 'agent/event', event: { ...result.taskBoard, type: 'task_board_updated', sessionId: result.sessionId } });
        }
      } catch (error) {
        if (seq === switchSequenceRef.current) {
          dispatch({ type: 'agent/event', event: { type: 'error', message: `会话桥接启动失败：${cleanIpcError(error)}` } });
        }
      }
    } catch {
      if (seq === switchSequenceRef.current) {
        dispatch({ type: 'agent/event', event: { type: 'error', message: `无法加载会话 ${id}` } });
      }
    } finally {
      if (seq === switchSequenceRef.current) switchingSessionRef.current = false;
    }
  }

  async function handleConvoAction(action: string, sessionId: string) {
    const meta = sessions.find((s) => s.id === sessionId);
    switch (action) {
      case 'open-chat':
        await openSession(sessionId);
        return;
      case 'fork-chat': {
        // Branch the conversation: a new session that inherits the whole
        // transcript, leaving the source untouched. Then open the branch, so
        // the user lands in the copy rather than wondering where it went.
        try {
          const forked = await desktop.sessions.fork(sessionId);
          refreshSessions();
          await openSession(forked.id);
        } catch {
          dispatch({ type: 'agent/event', event: { type: 'error', message: '分叉失败：无法读取该会话' } });
        }
        return;
      }
      case 'export-md': {
        // Iteration 14: export any listed session — load its record through
        // the same converter the open flow uses, then share the serializer.
        try {
          const record = await desktop.sessions.load(sessionId);
          const markdown = transcriptToMarkdown(sessionToChat(record), {
            // Not the disambiguated label: a timestamp added to tell two
            // same-named chats apart does not belong in the exported document.
            title: meta?.baseTitle ?? meta?.title,
            workspaceRoot: stateRef.current.workspaceRoot,
          });
          await desktop.clipboard.write(markdown);
        } catch {
          dispatch({ type: 'agent/event', event: { type: 'error', message: '导出失败：无法读取会话记录' } });
        }
        return;
      }
      case 'remove':
        await desktop.sessions.delete(sessionId);
        void desktop.tags.remove(sessionId).catch(() => undefined); // best-effort sidecar cleanup
        if (stateRef.current.activeSessionId === sessionId) dispatch({ type: 'chat/clear' });
        refreshSessions();
        return;
      case 'archive':
        await desktop.sessions.archive(sessionId, true);
        void desktop.tags.remove(sessionId).catch(() => undefined); // archived sessions leave the visible list
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

  /**
   * Floating terminal window (draggable, overlays the conversation).
   *
   * It used to be opened only by the empty-conversation launcher card. That
   * card is gone — it reappeared in every new conversation — so the floating
   * window now has its own command-palette entry rather than no entry at all.
   * Distinct from the bottom terminal panel (Ctrl+T), which is the usual one.
   */
  function toggleTerminalFloat() {
    setTerminalFloatOpen((open) => !open);
  }

  // During the brief startup restore, show a neutral splash instead of the
  // folder picker. Restore always resolves a workspace (last-used or home), so
  // Welcome only appears if restore genuinely failed to set any root.
  // NOTE: every hook must run BEFORE these early returns — a useMemo placed
  // after them changes the hook count between renders and crashes React #310.
  // Oldest live approval request drives the blocking modal; auto-decided
  // (sandbox) approvals carry `decided` on arrival and never surface here.
  const pendingApproval = useMemo(
    () => state.chat.find((item): item is Extract<ChatItem, { kind: 'approval' }> =>
      item.kind === 'approval' && !item.decided) ?? null,
    [state.chat],
  );

  const confirmationDialogs = <>
    <ConfirmDialog
      open={workspaceConfirm !== null}
      title={workspaceConfirm === 'dirty' ? '切换工作区并丢弃未保存修改？' : '切换工作区并停止运行任务？'}
      message={workspaceConfirm === 'dirty'
        ? '当前编辑器有未保存修改，切换后这些修改会被丢弃。'
        : '当前工作区仍有任务运行，已执行的部分会保留，但所有会话和后台任务会停止。'}
      confirmLabel="继续切换" danger
      onConfirm={() => {
        const kind = workspaceConfirm;
        setWorkspaceConfirm(null);
        if (!kind) return;
        if (kind === 'dirty' && (stateRef.current.runningSessions.length > 0 || stateRef.current.agentStatus === 'starting')) setWorkspaceConfirm('running');
        else void performOpenWorkspace();
      }}
      onCancel={() => setWorkspaceConfirm(null)} />
    <SaveConflictDialog conflict={editorSave.conflict} busy={editorSave.busy}
      onKeep={editorSave.cancel} onReload={() => { void editorSave.reload(); }} onOverwrite={() => { void editorSave.overwrite(); }} />
  </>;

  if (booting) return <main className="app-shell" />;
  // 常驻侧栏的两组数据：上下文占用快照（CLI 每回合报的真实数字）与该会话改过
  // 的文件。这里用普通常量而不是 useMemo——这段代码位于若干 early return 之后，
  // 在那里加 hook 会让「这次渲染」和「上次渲染」的 hook 数量不同（React #310）。
  // 两个函数都是对 state 的一次线性遍历，代价可以忽略。
  const contextPanel = buildContextPanel(state.contextStats);
  const contextOutputs = sessionOutputs(state.chat);
  const compacting = state.chat.some((item) => item.kind === 'compaction' && item.phase === 'running');

  if (!state.workspaceRoot) return <main className="app-shell"><Welcome onOpenWorkspace={openWorkspace} />{confirmationDialogs}</main>;

  if (mainView === 'settings' && state.settings) {
    return (
      <>
        {/* Same decorative layer as the main view, so 压暗 / 模糊 have a live
            preview instead of being tuned blind. */}
        {backgroundEnabled && backgroundImage && <div className="app-background" aria-hidden="true" />}
        <SettingsView
          settings={state.settings}
          onBack={() => setMainView('chat')}
          onSave={saveSettingsSnapshot}
          onSaveKey={saveApiKey}
          initialPage={settingsPage}
          sessionId={state.activeSessionId ?? undefined}
        />
        {confirmationDialogs}
        <ToastLayer onFocusChat={() => setMainView('chat')} />
        {paletteOpen && (
          <CommandPalette commands={paletteCommands} onClose={() => setPaletteOpen(false)} />
        )}
        <QuickOpen
          open={quickOpen}
          workspaceRoot={state.workspaceRoot}
          onClose={() => setQuickOpen(false)}
          onPick={(path) => { void handleOpenFileAtLine(path); }}
        />
      </>
    );
  }

  // Other conversations with work in flight, excluding the one on screen (its
  // progress is already visible in the transcript).
  const backgroundRunning = state.runningSessions.filter((id) => id !== state.activeSessionId);
  const backgroundApprovals = Object.entries(state.sessionApprovals)
    .filter(([id]) => id !== state.activeSessionId)
    .reduce((sum, [, count]) => sum + count, 0);
  const backgroundWorkCount = backgroundRunning.length + backgroundApprovals;
  const backgroundWorkLabel = backgroundApprovals > 0
    ? `${backgroundRunning.length} 个会话运行中 · ${backgroundApprovals} 个待审批`
    : `${backgroundRunning.length} 个会话运行中`;

  const titleMap: Record<MainView, { icon: JSX.Element; label: string }> = {
    newtab: { icon: <LayoutGrid size={16} />, label: '新标签页' },
    chat: { icon: <MessageSquare size={16} />, label: '对话' },
    files: { icon: <FilesIcon size={16} />, label: '文件' },
    search: { icon: <Search size={16} />, label: '搜索' },
    snippets: { icon: <Braces size={16} />, label: '片段库' },
    bookmarks: { icon: <BookmarkCheck size={16} />, label: '书签' },
    history: { icon: <History size={16} />, label: '历史' },
    stats: { icon: <BarChart3 size={16} />, label: '代码普查' },
    git: { icon: <GitBranch size={16} />, label: 'Git' },
    automation: { icon: <CalendarClock size={16} />, label: '自动化' },
    settings: { icon: <SettingsIcon size={16} />, label: '设置' },
    editor: { icon: <FileCode size={16} />, label: '编辑器' },
    quality: { icon: <Gauge size={16} />, label: '质量' },
    computer: { icon: <Monitor size={16} />, label: '电脑操控' },
    memory: { icon: <BrainCircuit size={16} />, label: '记忆' },
  };

  return (
    <div
      className="chat-shell"
      style={{
        // Only the third column is dynamic: it carries whichever side panel is
        // open, and its width is state so that dragging the handle resizes it.
        // The first column (the rail) is fixed and comes from --rail-w in CSS —
        // writing the whole grid-template-columns here meant the rail width was
        // declared in this file as well as twice in the stylesheet.
        '--panel-w': (
          state.browserOpen ? `${state.browserWidth}px`
          : state.sideChatOpen ? `${state.sideChatWidth}px`
          : workspaceToolsOpen ? `${workspaceToolsWidth}px`
          : notesOpen ? `${NOTES_WIDTH}px`
          : inspectorOpen ? `${inspectorWidth}px`
          // A length, not `auto`: the grid caps this value with min()/calc(),
          // and `auto` is not a valid operand there — it would invalidate the
          // whole grid-template-columns declaration and drop the shell to its
          // initial `none`.
          : '0px'
        ),
        // The preview sidebar is the fourth track and can be open beside the
        // inspector. It carries its own width because the shell caps it
        // against whatever the panel left over; the component's inline width
        // alone would let the two tracks together exceed the window.
        '--preview-w': state.preview.open ? `${state.preview.width}px` : '0px',
      } as React.CSSProperties}
    >
      <Rail
        state={state}
        sessions={sessions}
        sessionTags={sessionTags}
        recentFiles={recentFiles}
        mainView={mainView}
        shortcuts={{
          newChat: keyBindings['new-chat'] ? serializeChord(keyBindings['new-chat']) : undefined,
          search: keyBindings['search-workspace'] ? serializeChord(keyBindings['search-workspace']) : undefined,
        }}
        runningIds={state.runningSessions}
        approvals={state.sessionApprovals}
        onNewChat={newChat}
        onOpenWorkspace={openWorkspace}
        onSelectView={setMainView}
        onOpenRecent={(p) => { void handleOpenFile(p); }}
        contextPanel={contextPanel}
        outputs={contextOutputs}
        compacting={compacting}
        onCompact={() => { void submitPrompt('/compact'); }}
        onOpenOutput={(path) => { void handleOpenFile(path); }}
        onSwitchWorkspace={(root) => { void switchToWorkspace(root); }}
        onSetTags={(id, tags) => { void handleSetTags(id, tags); }}
        onHelpAction={(action) => {
          // 'extensions' jumps to settings; the rest open the versioned
          // Help / What's New overlay; shortcuts land on the real page.
          if (action === 'extensions') { setMainView('settings'); return; }
          if (action === 'shortcuts') { setSettingsPage('shortcuts'); setMainView('settings'); return; }
          if (action === 'whats-new' || action === 'help') { setHelpOverlay(action); return; }
        }}
        onConvoAction={handleConvoAction}
        onOpenSession={openSession}
      />
      {/* The decorative layer sits on the shell, not inside .main. `.main`
          declares `container-type: inline-size` for the narrow-composer query,
          and a size container becomes the containing block for its fixed
          descendants — so the layer's scale-up (which hides the blur fringe)
          spilled ~52px left over the rail and washed out 自动化 and the kbd
          hints. On the shell it spans the window as inset:0 intends. */}
      {backgroundEnabled && backgroundImage && <div className="app-background" aria-hidden="true" />}
      <div className="main">
        <div className="main-topbar">          {/* ZCode WorkspaceHeader: the chat header shows the workspace (with
              a folder glyph), other views keep their own icon + label. */}
          {mainView === 'chat' ? (
            <div className="main-title">
              <FolderOpen size={16} />
              <span>{(state.workspaceRoot ? state.workspaceRoot.split(/[\\/]/).filter(Boolean).pop() : null) ?? '对话'}</span>
            </div>
          ) : (
            <div className="main-title">{titleMap[mainView].icon}<span>{titleMap[mainView].label}</span></div>
          )}
          {mainView === 'chat' && state.taskSummary && (
            <TaskCard
              summary={state.taskSummary}
              chat={state.chat}
              onToggle={() => dispatch({ type: 'task/toggle' })}
            />
          )}
          <span className="main-topbar-spacer" />
          {/* Notes had no entry of its own: the drawer was reachable only from
              the command palette, so a feature the app advertises in the
              palette looked missing from the window. The dot reports an
              unsaved draft, which is otherwise invisible once the drawer is
              closed. */}
          {mainView === 'chat' && (
            <button
              type="button"
              className={`main-topbar-notes${notesOpen ? ' active' : ''}`}
              aria-pressed={notesOpen}
              title={notesOpen ? '关闭会话笔记' : '会话笔记'}
              onClick={toggleNotesPanel}
            >
              <StickyNote size={15} />
              {notesDraft && <span className="main-topbar-notes-dot" aria-label="有未保存的笔记草稿" />}
            </button>
          )}
          {/* Background conversations are invisible otherwise: with one CLI child
              per session, other conversations keep working while you look at
              this one, and one of them may be blocked on an approval. */}
          {backgroundWorkCount > 0 && (
            <button
              className="main-topbar-background"
              title={backgroundWorkLabel}
              onClick={() => setMainView('chat')}
            >
              {backgroundWorkLabel}
            </button>
          )}
          {mainView === 'chat' && (
            <GitCapsule state={state} active={inspectorOpen} onOpen={openInspector} />
          )}
        </div>

        {mainView === 'chat' && (
          <ConversationStream
            state={state}
            onApprove={approve}
            onEditUser={(text) => setPrefill({ text, nonce: Date.now() })}
            onUndo={undoTurn}
            onOpenFile={handleOpenFile}
            dispatch={dispatch}
            expandAll={detailsExpanded}
            onCancel={cancelTurn}
          />
        )}

        {state.workPanelOpen && mainView === 'chat' && (
          <WorkDetailsPanel state={state} onClose={() => dispatch({ type: 'work/toggle' })} />
        )}

        {state.pendingDiffs.length > 0 && mainView !== 'settings' && (
          <DiffReview diffs={state.pendingDiffs} dispatch={dispatch} onApprove={approve} />
        )}

        {mainView === 'newtab' && (
          <div className="secondary newtab-host">
            <NewTabPage
              artifacts={newTabArtifacts}
              workspaceReady={Boolean(state.workspaceRoot)}
              onShortcut={handleNewTabShortcut}
              onOpenArtifact={(id) => { void openArtifactFile(id); }}
              onOpenAllPlugins={() => { setSettingsPage('plugins'); setMainView('settings'); }}
            />
          </div>
        )}

        {mainView === 'files' && (
          <div className="secondary">
            <FileTree tree={state.tree} workspaceRoot={state.workspaceRoot} onOpenFile={handleOpenFile} />
          </div>
        )}

        {mainView === 'search' && (
          <div className="secondary">
            <SearchPanel workspaceRoot={state.workspaceRoot} onOpenHit={(p, line) => { void handleOpenFileAtLine(p, line); }} onOpenSession={(id) => { void openSession(id); }} />
          </div>
        )}

        {mainView === 'snippets' && (
          <div className="secondary">
            <SnippetsPanel onInsert={(bodyText) => {
              setPrefill({ text: bodyText, nonce: Date.now() });
              setMainView('chat');
            }} />
          </div>
        )}

        {mainView === 'bookmarks' && (
          <div className="secondary">
            <BookmarksPanel onJump={(p, line) => { void handleOpenFileAtLine(p, line); }} />
          </div>
        )}

        {mainView === 'history' && (
          <div className="secondary">
            <FileHistoryPanel onOpenFile={(p) => { void handleOpenFile(p); }} />
          </div>
        )}

        {mainView === 'stats' && (
          <div className="secondary">
            <CodeStatsPanel onOpenFile={(p, line) => { void handleOpenFileAtLine(p, line); }} />
          </div>
        )}

        {mainView === 'git' && (
          <div className="secondary">
            <GitPanel state={state} forcePush={Boolean(state.settings?.preferences?.gitForcePush)} branchPrefix={typeof state.settings?.preferences?.gitBranchPrefix === 'string' ? state.settings.preferences.gitBranchPrefix : 'codex/'} onOpenFile={(path, line) => { void handleOpenFileAtLine(path, line); }} />
          </div>
        )}

        {mainView === 'memory' && (
          <div className="secondary">
            <MemoryPanel onOpenFile={(p) => { void handleOpenFile(p); }} />
          </div>
        )}

        {mainView === 'automation' && <AutomationPanel />}

        {mainView === 'computer' && (
          <GuiControlPanel
            // 交给智能体 drops the window description into the composer rather
            // than sending it: the user still decides what to ask about it.
            onAskAgent={(text) => { setMainView('chat'); setPrefill({ text, nonce: Date.now() }); }}
            desktopMode={state.settings?.preferences?.computerExecutionMode === 'desktop'}
          />
        )}

        {mainView === 'quality' && (
          <div className="quality-view">
            <div className="quality-launcher">
              <button onClick={() => setQualityOverlay('review')}>代码审查</button>
              <button onClick={() => setQualityOverlay('coverage')}>测试覆盖率</button>
              <button onClick={() => setQualityOverlay('performance')}>性能分析</button>
              <button onClick={() => setQualityOverlay('refactor')}>重构</button>
            </div>
            <QualityDashboard
              visible
              onClose={() => setMainView('chat')}
              onOpenFile={handleOpenFileAtLine}
            />
          </div>
        )}

        {/* Quality sub-panels: overlay layers above any main view. */}
        <CodeReviewPanel
          visible={qualityOverlay === 'review'}
          onClose={() => setQualityOverlay(null)}
          file={activeFile ?? undefined}
          code={activeFile ? openFiles.find(f => f.path === activeFile)?.content : undefined}
        />
        <CoveragePanel
          visible={qualityOverlay === 'coverage'}
          onClose={() => setQualityOverlay(null)}
          onOpenFile={handleOpenFileAtLine}
        />
        <PerformancePanel
          visible={qualityOverlay === 'performance'}
          onClose={() => setQualityOverlay(null)}
          file={activeFile ?? undefined}
        />
        <RefactorPanel
          visible={qualityOverlay === 'refactor'}
          onClose={() => setQualityOverlay(null)}
          onApplied={() => {
            // 重构由 CLI 直接写盘。重读所有打开的 tab，让编辑器与磁盘一致；
            // 未打开的文件无需处理（下次打开时自然读到新内容）。
            for (const file of openFilesRef.current) {
              void (async () => {
                try {
                  const result = await desktop.editor.readFile(file.path);
                  if (!result?.ok || typeof result.content !== 'string') return;
                  const content = result.content;
                  setOpenFiles((prev) => prev.map((f) => (f.path === file.path ? { ...f, content, dirty: false, stale: false } : f)));
                  diskMtimes.current.delete(file.path);
                } catch { /* 文件可能被重命名，忽略 */ }
              })();
            }
          }}
        />

        {/* Versioned Help / What's New content (Rail help menu). */}
        {helpOverlay && (
          <HelpOverlay initialTab={helpOverlay} onClose={() => setHelpOverlay(null)} />
        )}

        {/* Command palette (Ctrl+Shift+P, iteration 2). */}
        {paletteOpen && (
          <CommandPalette commands={paletteCommands} onClose={() => setPaletteOpen(false)} />
        )}

        {/* Quick-open file palette (Ctrl+P, iteration 17). */}
        <QuickOpen
          open={quickOpen}
          workspaceRoot={state.workspaceRoot}
          onClose={() => setQuickOpen(false)}
          onPick={(path) => { void handleOpenFileAtLine(path); }}
        />

        {mainView === 'editor' && (
          <EditorView
            openFiles={openFiles}
            activeFile={activeFile}
            onOpenFile={handleOpenFile}
            onSaveFile={handleSaveFile}
            onCloseFile={handleCloseFile}
            onContentChange={handleContentChange}
            onSetActive={handleSetActiveFile}
            editorOptions={{
              fontSize: Number(state.settings?.preferences?.codeFontSize) || 13,
              fontFamily: "'JetBrains Mono', 'Cascadia Code', 'SFMono-Regular', 'Noto Sans Mono CJK SC', Consolas, monospace",
              tabSize: Number(state.settings?.preferences?.editorTabSize) || 2,
              // Off unless the user asked for it: at this column width the
              // 74px minimap is unreadable (it renders CJK comments as noise)
              // and it sits exactly where the eye tracks the end of a line.
              // 设置 → 外观 still turns it on.
              minimap: state.settings?.preferences?.editorMinimap === true,
              wordWrap: state.settings?.preferences?.editorWordWrap === true,
            }}
            pendingReveal={pendingReveal}
            onRevealDone={() => setPendingReveal(null)}
          />
        )}

        {mainView === 'chat' && (
          <Composer
            state={state}
            prefill={prefill}
            onSubmit={submitPrompt}
            onCancel={cancelTurn}
            // Filtered through the same rule the drain uses (lib/messageQueueSelect),
            // so a message can never be visible but unsendable, or sendable but
            // invisible. Entries queued while the bridge was still starting carry
            // an empty session id and belong to the active conversation.
            queue={queueForSession(state.messageQueue, state.activeSessionId)}
            queuePaused={(state.queuePausedSessions ?? []).some(sessionId => sessionId === (state.activeSessionId ?? '') || sessionId === '')}
            onQueueResume={() => resumeQueue(state.activeSessionId ?? '')}
            onQueueSendNow={(id) => {
              // Jump the line: move it to the front of its session's queue. It
              // still waits for the running turn — "立即" means "next", not
              // "interrupt", because cancelling the current turn is a different
              // decision the user has not made.
              dispatch({ type: 'queue/promote', id });
            }}
            onQueueEdit={(id, text) => dispatch({ type: 'queue/update', id, text })}
            onQueueRemove={(id) => dispatch({ type: 'queue/remove', id })}
            onPickApproval={async (mode) => {
              if (!state.settings) return;
              await saveSettings({ approval: mode });
            }}
            terminalOutput={terminalOutput}
            onPickPlugin={(plugin) => {
              // Iteration 20: plugins with a route jump straight to their
              // view; the rest just confirm selection in the transcript.
              switch (plugin.route) {
                case 'browser': if (!stateRef.current.browserOpen) toggleBrowserPanel(); setMainView('chat'); return;
                case 'snippets': setMainView('snippets'); return;
                case 'bookmarks': setMainView('bookmarks'); return;
                case 'history': setMainView('history'); return;
                case 'stats': setMainView('stats'); return;
                case 'search': setMainView('search'); return;
                case 'automation': setMainView('automation'); return;
                case 'git': setMainView('git'); return;
                case 'quality': setMainView('quality'); return;
                case 'notes': if (!workspaceToolsRef.current.notesOpen) toggleNotesPanel(); setMainView('chat'); return;
                case 'terminal': dispatch({ type: 'bottom/toggle' }); return;
                default:
                  dispatch({ type: 'agent/event', event: { type: 'assistant_message', text: `已选择插件：${plugin.name} — ${plugin.desc}` } });
              }
            }}
            onPickModel={async (providerId, model) => {
              if (!state.settings) return;
              await saveSettings({ activeProviderId: providerId, providerUpdates: [{ id: providerId, model }] });
              // A running bridge was created with the old provider/model. If a
              // turn is mid-flight, DON'T kill it — a half-written file is worse
              // than a delayed switch. Defer restart until the turn ends.
              if (stateRef.current.agentStatus === 'running') {
                const sessionId = stateRef.current.activeSessionId;
                if (sessionId) pendingRestartRef.current.add(sessionId);
                dispatch({ type: 'agent/event', event: { type: 'info', message: '当前任务完成后将切换模型。' } });
                return;
              }
              if (stateRef.current.agentStatus !== 'offline') {
                dispatch({ type: 'agent/status', status: 'starting' });
                try {
                  const sessionId = stateRef.current.activeSessionId;
                  if (sessionId) {
                    const result = await desktop.agent.restart(sessionId);
                    if (stateRef.current.activeSessionId === sessionId) dispatch({ type: 'agent/bind', sessionId: result.sessionId });
                  }
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

      {/* Session notes drawer (iteration 10) — chat view only. Mounted on the
          shell rather than inside .main: .main is a size container, which makes
          it the containing block for position:fixed children, so the drawer
          anchored to the conversation column. Opening the browser panel shrank
          that column and the drawer slid into the middle of the chat instead of
          sitting against the window edge. */}
      {notesOpen && mainView === 'chat' && (
        <SessionNotesDrawer
          sessionId={state.activeSessionId}
          onClose={() => setNotesOpen(false)}
          onDraftChange={setNotesDraft}
        />
      )}

      <PreviewSidebar
        open={state.preview.open}
        width={state.preview.width}
        tabs={state.preview.tabs}
        activeTabId={state.preview.activeTabId}
        layout={state.preview.layout}
        dispatch={dispatch}
        workspaceRoot={state.workspaceRoot}
      />

      <SideChatPanel
        open={state.sideChatOpen}
        width={state.sideChatWidth}
        onClose={() => dispatch({ type: 'sidechat/toggle' })}
        onWidthChange={(w) => dispatch({ type: 'sidechat/setWidth', width: w })}
        settings={state.settings}
      />

      <WorkspaceToolsPanel
        open={workspaceToolsOpen}
        width={workspaceToolsWidth}
        workspaceRoot={state.workspaceRoot}
        openFilesCount={openFiles.length}
        previewOpen={state.preview.open}
        previewTabCount={state.preview.tabs.length}
        agentStatus={state.agentStatus}
        pendingDiffCount={state.pendingDiffs.filter((d) => d.status === 'pending').length}
        sessionId={state.activeSessionId ?? undefined}
        runningSubagentCount={runningSubagentCount}
        supervisor={state.supervisor}
        onClose={() => setWorkspaceToolsOpen(false)}
        onWidthChange={setWorkspaceToolsWidth}
        onOpenQuality={() => { setWorkspaceToolsOpen(false); setMainView('quality'); }}
        onOpenGit={() => { setWorkspaceToolsOpen(false); setMainView('git'); }}
        onOpenFile={(path) => { void handleOpenFile(path); }}
        chat={state.chat}
        onRunReview={() => { void runReview(); }}
        reviewRunning={state.agentStatus === 'running'}
        onOpenPreview={() => {
          setWorkspaceToolsOpen(false);
          if (!state.preview.open) dispatch({ type: 'preview/toggle' });
        }}
      />

      <InspectorSidebar
        // `key` on the nonce so re-clicking the same capsule segment restarts
        // the drill-down stack at that level instead of keeping the old one.
        key={`insp-${inspectorNonce}`}
        state={state}
        open={inspectorOpen}
        width={inspectorWidth}
        initialLevel={inspectorLevel}
        onClose={() => setInspectorOpen(false)}
        onWidthChange={setInspectorWidth}
        onOpenFile={(path, line) => { void handleOpenFileAtLine(path, line); }}
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

      {/* Floating terminal window — command palette → "Toggle Floating Terminal" */}
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

      {/* Key task-state reminders (approval needed / done / error / offline) */}
      <ToastLayer onFocusChat={() => setMainView('chat')} />

      {confirmationDialogs}

      {/* Blocking confirmation dialog for the oldest live approval request,
          when enabled (gen.approvalModal). Auto-decided (sandbox) approvals
          never appear here — the reducer marks them decided on arrival. */}
      <GuardConfirmationModal
        key={state.guardRequests.find((request) => request.sessionId === state.activeSessionId)?.requestId ?? 'guard-empty'}
        request={state.guardRequests.find((request) => request.sessionId === state.activeSessionId) ?? null}
        onChoose={async (request, label) => {
          await desktop.agent.guardConfirmation(request.requestId, label, request.sessionId);
          dispatch({ type: 'guard/decided', requestId: request.requestId });
        }}
      />
      {(state.settings?.preferences?.['gen.approvalModal'] !== false) && (
        <ApprovalModal item={pendingApproval} onApprove={approve} />
      )}
    </div>
  );
}
