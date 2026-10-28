import type { AgentEvent, AppState, ChatItem, ContextStats, DesktopSettings, GuardConfirmation, PendingDiff, PreviewLayout, PreviewTab, QueuedMessage, ReviewFinding, SupervisorSnapshot, ToolChatItem, TreeNode, TurnFileChange, WorkLogEntry, TaskBoard } from '../types';

export type AppAction =
  | { type: 'settings/loaded'; settings: DesktopSettings }
  | { type: 'workspace/opened'; root: string }
  | { type: 'tree/loaded'; tree: TreeNode[] }
  | { type: 'view/set'; view: AppState['activeView'] }
  | { type: 'chat/user'; text: string; sessionId?: string }
  | { type: 'chat/clear' }
  | { type: 'agent/bind'; sessionId: string }
  | { type: 'guard/decided'; requestId: string }
  | { type: 'chat/load'; sessionId: string; chat: ChatItem[] }
  | { type: 'agent/status'; status: AppState['agentStatus'] }
  | { type: 'agent/event'; event: AgentEvent }
  | { type: 'approval/decided'; requestId: string; decision: 'allow_once' | 'allow_session' | 'deny' }
  // Message queue: submissions made while the agent was busy.
  | { type: 'queue/add'; message: QueuedMessage }
  | { type: 'queue/restore'; messages: QueuedMessage[] }
  | { type: 'queue/hydrate'; messages: QueuedMessage[]; pausedSessions: string[] }
  | { type: 'queue/pause'; sessionId: string }
  | { type: 'queue/resume'; sessionId: string }
  | { type: 'queue/remove'; id: string }
  | { type: 'queue/update'; id: string; text: string }
  | { type: 'queue/promote'; id: string }
  | { type: 'queue/adopt'; id: string; sessionId: string }
  | { type: 'queue/clear'; sessionId?: string }
  | { type: 'turn/undo-state'; turnId: string; undo: 'idle' | 'undoing' | 'undone' | 'failed' }
  | { type: 'bottom/toggle' }
  | { type: 'task/set'; title: string }
  | { type: 'task/toggle' }
  | { type: 'task/clear' }
  | { type: 'context/compaction'; tier: 'passthrough' | 'soft' | 'hard'; budgetChars: number; usedChars: number; messagesDropped: number; summaryGenerated: boolean }
  // Preview sidebar actions
  | { type: 'preview/open'; tab: PreviewTab }
  | { type: 'preview/activate'; id: string }
  | { type: 'preview/close'; id: string }
  | { type: 'preview/update'; id: string; patch: Partial<PreviewTab> }
  | { type: 'preview/toggle' }
  | { type: 'preview/setWidth'; width: number }
  | { type: 'preview/setLayout'; layout: PreviewLayout }
  /** A file the open panes show changed on disk; re-render whichever tab owns it. */
  | { type: 'preview/changed'; absolutePath: string }
  // Diff review actions
  | { type: 'diff/queue'; diff: PendingDiff }
  | { type: 'diff/decide'; id: string; decision: 'accepted' | 'rejected' }
  | { type: 'diff/clearAll' }
  // Side chat actions
  | { type: 'sidechat/toggle' }
  | { type: 'sidechat/setWidth'; width: number }
  // Browser actions
  | { type: 'browser/toggle' }
  | { type: 'browser/setWidth'; width: number }
  | { type: 'browser/open'; url?: string }
  | { type: 'work/toggle' };

const DEFAULT_PREVIEW_WIDTH = 420;

export const initialState: AppState = {
  workspaceRoot: '',
  activeView: 'files',
  settings: null,
  tree: [],
  chat: [],
  agentStatus: 'offline',
  bottomOpen: false,
  activeSessionId: null,
  contextStats: null,
  taskSummary: null,
  contextCompaction: null,
  preview: { open: false, width: DEFAULT_PREVIEW_WIDTH, tabs: [], activeTabId: null, layout: 'single' },
  pendingDiffs: [],
  sideChatOpen: false,
  sideChatWidth: 400,
  browserOpen: false,
  browserWidth: 600,
  workLog: [],
  workPanelOpen: false,
  workPhase: 'idle',
  taskBoard: null,
  taskExecutionMode: 'plan',
  supervisor: null,
  runningSessions: [],
  sessionApprovals: {},
  messageQueue: [],
  queuePausedSessions: [],
  readySessions: [],
  guardRequests: [],
};

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'settings/loaded':
      return { ...state, settings: action.settings };
    case 'workspace/opened':
      return {
        ...initialState,
        settings: state.settings,
        activeView: state.activeView,
        workspaceRoot: action.root,
        preview: { ...initialState.preview, width: state.preview.width },
        sideChatWidth: state.sideChatWidth,
        browserWidth: state.browserWidth,
      };
    case 'tree/loaded':
      return { ...state, tree: action.tree };
    case 'view/set':
      return { ...state, activeView: action.view };
    case 'chat/user':
      if (action.sessionId && action.sessionId !== state.activeSessionId) return state;
      return {
        ...state, 
        // Bug-10 fix: use crypto.randomUUID() instead of Date.now() to avoid
        // millisecond-level key collisions when messages are dispatched rapidly.
        chat: [...state.chat, { id: `user-${crypto.randomUUID()}`, kind: 'user', text: action.text, ts: Date.now() }],
        taskSummary: { title: extractTaskTitle(action.text), expanded: false }
      };
    case 'chat/clear':
      return { ...state, chat: [], activeSessionId: null, agentStatus: 'offline', contextStats: null, taskSummary: null, pendingDiffs: [], contextCompaction: null, taskBoard: null, supervisor: null, workLog: [], workPhase: 'idle' };
    case 'chat/load':
      return { ...state, chat: action.chat, activeSessionId: action.sessionId, agentStatus: 'offline', contextStats: null, taskSummary: null, pendingDiffs: [], contextCompaction: null, taskBoard: null, supervisor: null, workLog: [], workPhase: 'idle' };
    case 'agent/bind':
      return {
        ...state,
        activeSessionId: action.sessionId,
        readySessions: [...new Set([...state.readySessions, action.sessionId])],
        agentStatus: state.runningSessions.includes(action.sessionId) ? 'running' : 'ready',
        messageQueue: state.messageQueue.map((message) => message.sessionId ? message : { ...message, sessionId: action.sessionId }),
        queuePausedSessions: [...new Set((state.queuePausedSessions ?? []).map(sessionId => sessionId || action.sessionId))],
      };
    case 'guard/decided':
      return { ...state, guardRequests: state.guardRequests.filter((request) => request.requestId !== action.requestId) };
    case 'agent/status':
      return { ...state, agentStatus: action.status };
    case 'agent/event':
      return reduceAgentEvent(state, action.event);
    case 'turn/undo-state':
      // Reflect the undo lifecycle on the matching turn card (undoing → undone
      // / failed) so its button can show progress and disable when reverted.
      return {
        ...state,
        chat: state.chat.map((item) =>
          item.kind === 'turn' && item.id === action.turnId
            ? { ...item, undo: action.undo }
            : item,
        ),
      };
    case 'approval/decided':
      // Mark the approval card and its matching diff as decided together.
      return {
        ...state,
        chat: state.chat.map((item) =>
          item.kind === 'approval' && item.requestId === action.requestId
            ? { ...item, decided: action.decision, diff: item.diff ? { ...item.diff, status: action.decision === 'deny' ? 'rejected' : 'accepted' } : undefined }
            : item,
        ),
        pendingDiffs: state.pendingDiffs.map((diff) => diff.id === action.requestId
          ? { ...diff, status: action.decision === 'deny' ? 'rejected' : 'accepted' }
          : diff),
      };
    case 'queue/add':
      return { ...state, messageQueue: [...state.messageQueue, action.message] };
    case 'queue/restore': {
      const known = new Set(state.messageQueue.map(message => message.id));
      const returned = action.messages.filter(message => !known.has(message.id));
      return { ...state, messageQueue: [...returned, ...state.messageQueue] };
    }
    case 'queue/hydrate': {
      const adopt = (message: QueuedMessage) => !message.sessionId && state.activeSessionId ? { ...message, sessionId: state.activeSessionId } : message;
      const current = new Map(state.messageQueue.map(message => [message.id, message]));
      const messages = action.messages.map(message => adopt(current.get(message.id) ?? message));
      const restored = new Set(messages.map(message => message.id));
      return { ...state, messageQueue: [...messages, ...state.messageQueue.filter(message => !restored.has(message.id)).map(adopt)], queuePausedSessions: [...new Set([...(state.queuePausedSessions ?? []), ...action.pausedSessions].map(sessionId => sessionId || state.activeSessionId || ''))] };
    }
    case 'queue/pause':
      return { ...state, queuePausedSessions: [...new Set([...(state.queuePausedSessions ?? []), action.sessionId || state.activeSessionId || ''])] };
    case 'queue/resume':
      return { ...state, queuePausedSessions: (state.queuePausedSessions ?? []).filter(sessionId => sessionId !== (action.sessionId || state.activeSessionId || '') && !(sessionId === '' && action.sessionId === state.activeSessionId)) };
    case 'queue/remove':
      return { ...state, messageQueue: state.messageQueue.filter((item) => item.id !== action.id) };
    case 'queue/update':
      return {
        ...state,
        messageQueue: state.messageQueue.map((item) => item.id === action.id ? { ...item, text: action.text } : item),
      };
    case 'queue/promote': {
      // Move one entry to the front of its own session's queue. Other sessions'
      // entries keep their order — their sequencing is unrelated.
      const target = state.messageQueue.find((item) => item.id === action.id);
      if (!target) return state;
      const withoutTarget = state.messageQueue.filter((item) => item.id !== action.id);
      const firstPeer = withoutTarget.findIndex((item) => item.sessionId === target.sessionId);
      // No peers left in this session: it is already the only entry.
      if (firstPeer === -1) return state;
      return {
        ...state,
        messageQueue: [
          ...withoutTarget.slice(0, firstPeer),
          target,
          ...withoutTarget.slice(firstPeer),
        ],
      };
    }
    case 'queue/adopt':
      // Give an orphaned entry (queued before the session id was known) a real
      // owner, so it stops counting as belonging to every conversation.
      return {
        ...state,
        messageQueue: state.messageQueue.map((item) =>
          item.id === action.id && !item.sessionId ? { ...item, sessionId: action.sessionId } : item),
      };
    case 'queue/clear':
      // No sessionId clears everything (used when a workspace changes); with one,
      // only that conversation's entries — the others may still be waiting.
      return {
        ...state,
        messageQueue: action.sessionId
          ? state.messageQueue.filter((item) => item.sessionId !== action.sessionId)
          : [],
      };
    case 'bottom/toggle':
      return { ...state, bottomOpen: !state.bottomOpen };
    case 'task/set':
      return { ...state, taskSummary: { title: action.title, expanded: false } };
    case 'task/toggle':
      return state.taskSummary 
        ? { ...state, taskSummary: { ...state.taskSummary, expanded: !state.taskSummary.expanded } }
        : state;
    case 'task/clear':
      return { ...state, taskSummary: null };
    case 'context/compaction':
      return {
        ...state,
        contextCompaction: {
          tier: action.tier,
          budgetChars: action.budgetChars,
          usedChars: action.usedChars,
          messagesDropped: action.messagesDropped,
          summaryGenerated: action.summaryGenerated,
        },
      };
    // ── Preview sidebar ───────────────────────────────────────────────────────
    case 'preview/open': {
      const existing = state.preview.tabs.find((t) => t.id === action.tab.id);
      const tabs = existing
        ? state.preview.tabs.map((t) => (t.id === action.tab.id ? action.tab : t))
        : [...state.preview.tabs, action.tab];
      return { ...state, preview: { ...state.preview, open: true, tabs, activeTabId: action.tab.id } };
    }
    case 'preview/activate':
      return { ...state, preview: { ...state.preview, activeTabId: action.id, open: true } };
    case 'preview/close': {
      const tabs = state.preview.tabs.filter((t) => t.id !== action.id);
      const activeTabId = state.preview.activeTabId === action.id
        ? (tabs.at(-1)?.id ?? null)
        : state.preview.activeTabId;
      return { ...state, preview: { ...state.preview, tabs, activeTabId, open: tabs.length > 0 } };
    }
    case 'preview/update':
      return {
        ...state,
        preview: {
          ...state.preview,
          tabs: state.preview.tabs.map((t) => t.id === action.id ? { ...t, ...action.patch } : t),
        },
      };
    case 'preview/toggle':
      return { ...state, preview: { ...state.preview, open: !state.preview.open } };
    case 'preview/setWidth':
      return { ...state, preview: { ...state.preview, width: Math.max(300, Math.min(720, action.width)) } };
    case 'preview/setLayout':
      return { ...state, preview: { ...state.preview, layout: action.layout } };
    case 'preview/changed': {
      // A pane shows one file, and the file it shows is named by the descriptor
      // — matched on the absolute path because that is what the watcher reports
      // and what the descriptor carries verbatim.
      //
      // The revision bump is the whole point: the panes are plain React
      // components keyed on `revision`, so without it the component instance is
      // reused, its effects never re-run, and the pane keeps showing the bytes
      // the agent just replaced. Only the matching tab is touched, so one file's
      // change cannot blank the other panes.
      //
      // `web` panes are deliberately skipped: a dev server's own reload owns
      // them, and forcing a native view reload on every workspace file write
      // would fight it.
      let touched = false;
      const tabs = state.preview.tabs.map((tab) => {
        if (tab.kind === 'web' || tab.kind === 'text') return tab;
        const absolutePath = (tab.descriptor as { absolutePath?: unknown })?.absolutePath;
        if (typeof absolutePath !== 'string' || !sameFile(absolutePath, action.absolutePath)) return tab;
        touched = true;
        return { ...tab, revision: (tab.revision ?? 0) + 1 };
      });
      return touched ? { ...state, preview: { ...state.preview, tabs } } : state;
    }
    // ── Diff review ──────────────────────────────────────────────────────────
    case 'diff/queue':
      return { ...state, pendingDiffs: [...state.pendingDiffs.filter((d) => d.id !== action.diff.id), action.diff] };
    case 'diff/decide':
      return { ...state, pendingDiffs: state.pendingDiffs.map((d) => d.id === action.id ? { ...d, status: action.decision } : d) };
    case 'diff/clearAll':
      return { ...state, pendingDiffs: [] };
    
    case 'sidechat/toggle':
      return { ...state, sideChatOpen: !state.sideChatOpen };
    case 'sidechat/setWidth':
      return { ...state, sideChatWidth: action.width };
    
    case 'browser/toggle':
      return { ...state, browserOpen: !state.browserOpen };
    case 'browser/setWidth':
      return { ...state, browserWidth: action.width };
    case 'browser/open':
      return { ...state, browserOpen: true };
    case 'work/toggle':
      return { ...state, workPanelOpen: !state.workPanelOpen };
    
    default:
      return state;
  }
}

/**
 * Whether an event from `eventSession` belongs to the conversation on screen.
 *
 * With a session on screen the answer is exact: the ids match or they do not.
 * With none — a fresh chat, or the window before `agent/bind` lands — the id
 * cannot decide on its own, so an event is adopted only when its session is not
 * already known to be working elsewhere. That keeps a conversation the user left
 * running behind from streaming into the new, empty chat, which is the case a
 * plain `activeSessionId === null` check cannot tell apart from our own startup.
 */
/**
 * Whether two paths name the same file.
 *
 * Windows paths are case-insensitive and can be spelled with either separator,
 * and the two sides come from different places (the watcher's `path.relative`
 * output vs. the descriptor's resolved path), so neither `===` nor a plain
 * `startsWith` is reliable here.
 */
function sameFile(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return normalize(left) === normalize(right);
}

function belongsToVisibleChat(state: AppState, event: AgentEvent, eventSession: string | null): boolean {
  if (event.background === true) return false;
  if (eventSession === null) return true;
  if (state.activeSessionId !== null) return eventSession === state.activeSessionId;
  return !state.runningSessions.includes(eventSession);
}

function reduceAgentEvent(state: AppState, event: AgentEvent): AppState {
  const eventRoot = typeof event.workspaceRoot === 'string' ? event.workspaceRoot : null;
  const normalizeRoot = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (eventRoot && normalizeRoot(eventRoot) !== normalizeRoot(state.workspaceRoot)) return state;
  const now = Date.now();
  const addLog = (entry: Omit<WorkLogEntry, 'id' | 'ts'>, phase: AppState['workPhase'] = state.workPhase, base: AppState = state): AppState => ({
    ...base,
    workLog: [...base.workLog, { ...entry, id: `work-${crypto.randomUUID()}`, ts: now }].slice(-200),
    workPhase: phase,
  });

  // ── Background conversations ───────────────────────────────────────────────
  // Every bridge stamps its events with a session id. An event from a session
  // that is not the one on screen must NOT be folded into the visible chat —
  // that would interleave two conversations into one transcript. It still
  // updates the cross-session facts the UI needs: which sessions are working,
  // and which have an approval waiting.
  const eventSession = typeof event.sessionId === 'string' && event.sessionId ? event.sessionId : null;
  if (eventSession && event.type === 'bridge_ready') {
    state = { ...state, readySessions: [...new Set([...state.readySessions, eventSession])] };
  } else if (eventSession && event.type === 'agent_offline') {
    state = {
      ...state,
      readySessions: state.readySessions.filter((id) => id !== eventSession),
      guardRequests: state.guardRequests.filter((request) => request.sessionId !== eventSession),
    };
  }
  if (event.type === 'guard_confirmation_needed' && eventSession && typeof event.requestId === 'string') {
    const options = Array.isArray(event.options) ? event.options.flatMap((option) => {
      if (!option || typeof option !== 'object' || typeof (option as { label?: unknown }).label !== 'string') return [];
      const entry = option as { label: string; description?: string };
      return [{ label: entry.label, description: entry.description }];
    }) : [];
    const request: GuardConfirmation = {
      requestId: event.requestId,
      sessionId: eventSession,
      title: String(event.title ?? '需求确认'),
      question: String(event.question ?? ''),
      options,
    };
    return { ...state, guardRequests: [...state.guardRequests.filter((item) => item.requestId !== request.requestId), request] };
  }
  if (event.type === 'guard_confirmation_resolved' && typeof event.requestId === 'string') {
    return { ...state, guardRequests: state.guardRequests.filter((request) => request.requestId !== event.requestId) };
  }
  if (eventSession && !belongsToVisibleChat(state, event, eventSession)) {
    const running = new Set(state.runningSessions);
    if (event.type === 'turn_start') running.add(eventSession);
    else if (event.type === 'turn_done' || event.type === 'agent_offline') running.delete(eventSession);

    let approvals = state.sessionApprovals;
    if (event.type === 'approval_needed') {
      approvals = { ...approvals, [eventSession]: (approvals[eventSession] ?? 0) + 1 };
    } else if (event.type === 'approval_resolved' || event.type === 'turn_done' || event.type === 'agent_offline') {
      // A finished or offline session cannot still be waiting on an answer.
      if (approvals[eventSession]) {
        const { [eventSession]: _cleared, ...rest } = approvals;
        approvals = rest;
      }
    }

    if (running.size === state.runningSessions.length
      && [...running].every((id) => state.runningSessions.includes(id))
      && approvals === state.sessionApprovals) {
      return state;
    }
    return { ...state, runningSessions: [...running], sessionApprovals: approvals };
  }

  if (event.type === 'task_board_updated') {
    const board = event as unknown as TaskBoard;
    // The bridge sends the board id as both `id` and `boardId`. Reading only one
    // of them is how `board.id` ended up undefined and the startedAt
    // preservation below never matched — the timer reset on every update.
    const boardId = String(board.id ?? (event as { boardId?: unknown }).boardId ?? '');
    // Keep the first-seen timestamp across updates of the same board so the
    // goal elapsed timer doesn't reset on every task change.
    const startedAt = boardId && state.taskBoard && state.taskBoard.id === boardId && state.taskBoard.startedAt
      ? state.taskBoard.startedAt
      : now;
    const taskBoard = { ...board, id: boardId, startedAt };
    const detail = board.runtimeMode === 'paused' ? '任务已暂停，可从当前任务继续执行' : String(event.title ?? '');
    return { ...addLog({ type: 'task', phase: 'info', title: board.runtimeMode === 'paused' ? '任务已暂停' : '任务计划已更新', detail, data: event.tasks }, state.workPhase), taskBoard };
  }
  if (event.type === 'supervisor_updated') {
    // The whole snapshot arrives each time, so this is a replace, not a merge —
    // a unit that finished must disappear from the running list.
    const units = Array.isArray((event as { units?: unknown }).units)
      ? (event as unknown as SupervisorSnapshot).units
      : [];
    return { ...state, supervisor: { ...(event as unknown as SupervisorSnapshot), units } };
  }
  if (event.type === 'bridge_ready') {
    const sessionId = typeof event.sessionId === 'string' && event.sessionId ? event.sessionId : null;
    return {
      ...addLog({ type: 'info', phase: 'info', title: '智能体已连接', detail: `${String(event.provider ?? '')} / ${String(event.model ?? '')}` }, 'idle'),
      agentStatus: 'ready',
      // A ready bridge is the one this chat has been waiting for: adopt its
      // session so events that follow are attributed to the visible chat even
      // if `agent/bind` has not landed yet. Only reachable for a session the
      // background gate above did not send away.
      ...(sessionId ? { activeSessionId: state.activeSessionId ?? sessionId, readySessions: [...new Set([...state.readySessions, sessionId])] } : {}),
    };
  }
  if (event.type === 'model_start') return addLog({ type: 'model', phase: 'running', title: '思考中', detail: '模型正在分析当前任务' }, 'thinking');
  if (event.type === 'model_end') return addLog({ type: 'model', phase: 'done', title: '思考完成', detail: '模型已返回下一步行动' }, state.workPhase);
  if (event.type === 'thinking_start') {
    // Surface thinking in the conversation stream itself (not just WorkDetails):
    // a running `think` step inside the open turn, expandable like tool steps.
    const withStep = addTurnStep(state, { id: `think-${crypto.randomUUID()}`, kind: 'tool', status: 'running', tool: 'think', startedAt: Date.now() });
    return addLog({ type: 'thinking', phase: 'running', title: '思考过程', detail: String(event.text || '') }, 'thinking', withStep);
  }
  if (event.type === 'thinking_delta') {
    const stepped = appendThinkingText(state, String(event.text || ''));
    const previous = [...stepped.workLog].reverse().find((entry) => entry.type === 'thinking' && entry.phase === 'running');
    if (!previous) return addLog({ type: 'thinking', phase: 'running', title: '思考过程', detail: String(event.text || '') }, 'thinking', stepped);
    return { ...stepped, workLog: stepped.workLog.map((entry) => entry.id === previous.id ? { ...entry, detail: `${entry.detail ?? ''}${String(event.text || '')}` } : entry) };
  }
  if (event.type === 'thinking_end') {
    const stepped = finishThinkingStep(state, typeof event.durationMs === 'number' ? event.durationMs : undefined);
    const previous = [...stepped.workLog].reverse().find((entry) => entry.type === 'thinking' && entry.phase === 'running');
    return previous ? { ...stepped, workLog: stepped.workLog.map((entry) => entry.id === previous.id ? { ...entry, phase: 'done', durationMs: typeof event.durationMs === 'number' ? event.durationMs : entry.durationMs } : entry) } : stepped;
  }
  if (event.type === 'info') return addLog({ type: 'info', phase: 'info', title: '过程提示', detail: String(event.content ?? event.message ?? '') }, state.workPhase);
  if (event.type === 'context_compaction') {
    // Codex-style divider row: "正在压缩上下文" while the summarization model
    // call runs, then it flips to "上下文已自动压缩" (auto) / "上下文已压缩"
    // (manual /compact) with the real message counts.
    const auto = event.auto !== false;
    const phase = event.phase === 'completed' ? 'done' : event.phase === 'failed' ? 'failed' : 'running';
    const before = typeof event.before === 'number' ? event.before : undefined;
    const after = typeof event.after === 'number' ? event.after : undefined;
    const reason = typeof event.reason === 'string' ? event.reason : undefined;
    if (phase === 'running') {
      const next = appendChat(state, { id: `compaction-${crypto.randomUUID()}`, kind: 'compaction', phase, auto, before });
      return addLog({ type: 'info', phase: 'running', title: auto ? '正在压缩上下文' : '正在压缩上下文（手动）', detail: before ? `会话共 ${before} 条消息` : '' }, state.workPhase, next);
    }
    // Flip the newest still-running divider; if none exists (e.g. the started
    // event was lost), append a finished one so the outcome is never silent.
    let flipped = false;
    const chat = [...state.chat];
    for (let i = chat.length - 1; i >= 0; i -= 1) {
      const item = chat[i];
      if (item.kind === 'compaction' && item.phase === 'running') {
        chat[i] = { ...item, phase, before: item.before ?? before, after, reason };
        flipped = true;
        break;
      }
    }
    if (!flipped) chat.push({ id: `compaction-${crypto.randomUUID()}`, kind: 'compaction', phase, auto, before, after, reason });
    const detail = phase === 'failed'
      ? `压缩失败：${reason || '未知原因'}，已保留完整历史`
      : before !== undefined && after !== undefined ? `${before} → ${after} 条消息` : '';
    return addLog(
      { type: 'info', phase: phase === 'failed' ? 'failed' : 'done', title: phase === 'failed' ? '上下文压缩失败' : auto ? '上下文已自动压缩' : '上下文已压缩', detail },
      state.workPhase,
      { ...state, chat },
    );
  }
  if (event.type === 'review_report') {
    // A finished /review, as structured findings. Recorded as a chat row so the
    // transcript shows it inline; the 审查 tab reads the newest one from here
    // rather than subscribing separately.
    const findings: ReviewFinding[] = Array.isArray(event.findings)
      ? (event.findings as unknown[]).flatMap((raw) => {
          if (!raw || typeof raw !== 'object') return [];
          const record = raw as Record<string, unknown>;
          const title = typeof record.title === 'string' ? record.title : '';
          if (!title) return [];
          return [{
            title,
            body: typeof record.body === 'string' ? record.body : '',
            ...(typeof record.priority === 'number' ? { priority: record.priority } : {}),
            ...(typeof record.confidenceScore === 'number' ? { confidenceScore: record.confidenceScore } : {}),
            ...(typeof record.filePath === 'string' ? { filePath: record.filePath } : {}),
            ...(typeof record.lineStart === 'number' ? { lineStart: record.lineStart } : {}),
            ...(typeof record.lineEnd === 'number' ? { lineEnd: record.lineEnd } : {}),
          }];
        })
      : [];
    const outcome = event.outcome === 'correct' || event.outcome === 'incorrect' ? event.outcome : 'unknown';
    const item: ChatItem = {
      id: `review-${crypto.randomUUID()}`,
      kind: 'review',
      label: typeof event.label === 'string' ? event.label : '代码审查',
      ok: event.ok !== false,
      findings,
      outcome,
      ...(typeof event.error === 'string' && event.error ? { error: event.error } : {}),
      ...(event.unparsed === true ? { unparsed: true } : {}),
      ...(typeof event.explanation === 'string' && event.explanation ? { explanation: event.explanation } : {}),
      ...(typeof event.subSessionId === 'string' && event.subSessionId ? { subSessionId: event.subSessionId } : {}),
      ...(typeof event.durationMs === 'number' ? { durationMs: event.durationMs } : {}),
    };
    // A failed review is an error the user must see the reason for — the same
    // rule as every other failure. An unparsed review is NOT a failure (it ran
    // and returned something unreadable), so it stays an info-level row.
    if (!item.ok) {
      return addLog(
        { type: 'error', phase: 'failed', title: '代码审查失败', detail: item.error ?? '没有返回原因。' },
        state.workPhase,
        appendChat(state, item),
      );
    }
    const counts = findings.reduce<Record<string, number>>((acc, finding) => {
      const key = finding.priority === undefined ? '未分级' : `P${finding.priority}`;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    const detail = item.unparsed
      ? '审查返回的内容不是结构化结果'
      : findings.length === 0
        ? '未发现问题'
        : Object.keys(counts).sort().map((key) => `${key} ${counts[key]}`).join('，');
    return addLog(
      { type: 'info', phase: 'done', title: `代码审查完成：${item.label}`, detail },
      state.workPhase,
      appendChat(state, item),
    );
  }
  if (event.type === 'turn_start') {
    // The CLI emits turn_start both from the bridge wrapper and from inside
    // runAgentTurn. A duplicate for an already-open turn must not wipe the
    // workLog the first one started filling.
    const started = openTurnIndex(state) !== -1 ? startTurn(state) : { ...startTurn(state), workLog: [], workPhase: 'thinking' as const };
    return markSessionRunning(started, state.activeSessionId, true);
  }
  if (event.type === 'turn_done') {
    // A failed turn used to close silently. The CLI sends the failure reason on
    // turn_done, but nothing rendered it: the transcript kept only whatever had
    // streamed before the failure (often nothing) and the toast said just
    // "执行失败". Record the reason as the same kind:'error' item the bridge
    // errors use, so it stays readable after the toast is gone.
    const reason = event.status === 'error' ? String(event.reason ?? '').trim() : '';
    const closed = endTurn(state, event.status === 'cancelled');
    if (event.status === 'cancelled') {
      const last = closed.chat.at(-1);
      const text = typeof event.cancelledReply === 'string' && event.cancelledReply ? event.cancelledReply : last?.kind === 'assistant' && last.id === 'assistant-live' ? `${last.text}\n\n（本轮已停止。）` : '本轮已停止，已完成的操作和输出仍保留。';
      return { ...markSessionRunning(finalizeAssistant(closed, text), state.activeSessionId, false), agentStatus: state.readySessions.includes(state.activeSessionId ?? '') ? 'ready' : 'offline', workPhase: 'done' };
    }
    // A failed turn must always say something. Previously an empty reason left
    // the turn to close silently, so the user saw a failure with no explanation
    // at all — worse than a vague one, because there was nothing to act on.
    const text = reason || (event.status === 'error' ? '本轮执行失败，但 CLI 没有返回原因。' : '');
    const next = text
      ? appendChat(closed, { id: `turn-error-${crypto.randomUUID()}`, kind: 'error', text })
      : closed;
    return { ...markSessionRunning(next, state.activeSessionId, false), agentStatus: 'ready', workPhase: 'done' };
  }
  if (event.type === 'agent_offline') {
    // Close any open turn that never received a turn_done (e.g. process crash).
    // Without this, subsequent tool_start events get appended to the zombie turn.
    const closed = endTurn(state, event.expected === true);
    // Pending approvals belonged to the dead bridge: the CLI broker is gone, so
    // clicking them would hit "Unknown approval request". Per the desktop spec,
    // dismissed approvals are DENIED — mark their cards and diffs accordingly.
    const chat = closed.chat.map((item) =>
      item.kind === 'approval' && !item.decided
        ? { ...item, decided: 'deny' as const, diff: item.diff ? { ...item.diff, status: 'rejected' as const } : undefined }
        : item,
    );
    return { ...markSessionRunning({ ...closed, chat, pendingDiffs: [], agentStatus: 'offline' }, state.activeSessionId, false) };
  }
  if (event.type === 'undo_done') {
    // Authoritative undo result from the CLI (the IPC reply only says the
    // command was sent). Match the requesting turn card via undoId.
    const turnId = String(event.undoId ?? '');
    if (!turnId) return state;
    const ok = event.ok !== false;
    return {
      ...state,
      chat: state.chat.map((item) =>
        item.kind === 'turn' && item.id === turnId ? { ...item, undo: ok ? 'undone' as const : 'failed' as const } : item,
      ),
    };
  }
  if (event.type === 'context_stats') {
    const contextStats = contextStatsFromEvent(event);
    if (!contextStats) return state;
    // Codex-style per-turn footer: stamp the latest real snapshot onto the
    // running turn card so every round keeps its own ctx/cache numbers.
    const chat = [...state.chat];
    for (let index = chat.length - 1; index >= 0; index -= 1) {
      const item = chat[index];
      if (item.kind === 'turn' && item.endedAt === undefined) {
        chat[index] = {
          ...item,
          // The context window holds the whole prompt: net input plus the part
          // served from cache.
          ctxTokens: contextStats.inputTokens + contextStats.cacheReadTokens,
          cacheRate: contextStats.providerCacheReported && contextStats.inputTokens + contextStats.cacheReadTokens > 0
            ? Math.min(100, Math.round((contextStats.cacheReadTokens / (contextStats.inputTokens + contextStats.cacheReadTokens)) * 100))
            : null,
        };
        break;
      }
    }
    return { ...state, contextStats, chat };
  }
  if (event.type === 'assistant_delta') return appendAssistantDelta(state, String(event.text || ''));
  if (event.type === 'assistant_message') return finalizeAssistant(state, String(event.text || ''));
  // Bug-10 fix: use crypto.randomUUID() to avoid millisecond ID collisions.
  if (event.type === 'tool_start') {
    const tool = String(event.tool || 'tool');
    const detail = event.input && typeof event.input === 'object' ? JSON.stringify(event.input) : undefined;
    const next = addTurnStep(state, { id: `tool-${crypto.randomUUID()}`, kind: 'tool', status: 'running', tool, input: event.input, startedAt: Date.now() });
    return { ...addLog({ type: 'tool', phase: 'running', title: tool, tool, detail }, tool.includes('read') || tool.includes('search') ? 'exploring' : 'executing'), chat: next.chat };
  }
  if (event.type === 'tool_result') {
    const next = finishTurnStep(state, event);
    return addLog({ type: 'tool', phase: event.ok === false ? 'failed' : 'done', title: String(event.tool || 'tool'), tool: String(event.tool || 'tool'), detail: String(event.output || ''), durationMs: typeof event.durationMs === 'number' ? event.durationMs : undefined, data: event.data }, next.workPhase, next);
  }
  if (event.type === 'approval_needed') {
    const requestId = String(event.requestId || `approval-${crypto.randomUUID()}`);
    const diff = event.diff as { path: string; originalContent: string; modifiedContent: string } | undefined;
    // Sandbox interception: when the main process already answered the CLI
    // broker, the event arrives annotated with autoDecision/autoReason. The
    // card is born decided (with its cause) and never shows live buttons.
    const autoDecision = event.autoDecision === 'allow_once' || event.autoDecision === 'deny'
      ? event.autoDecision
      : undefined;
    const autoReason = typeof event.autoReason === 'string' ? event.autoReason : undefined;
    const next = appendChat(state, { id: requestId, kind: 'approval', requestId, tool: String(event.tool || 'tool'), message: String(event.message || '需要审批'), input: event.input, risk: (event.risk as 'read' | 'write' | 'shell' | 'network' | undefined), decided: autoDecision, autoReason, diff: diff && typeof diff.path === 'string' ? { id: requestId, path: diff.path, originalContent: diff.originalContent, modifiedContent: diff.modifiedContent, status: 'pending' } : undefined });
    const withDiff = diff && typeof diff.path === 'string'
      ? { ...next, pendingDiffs: [...next.pendingDiffs.filter((d) => d.id !== requestId), { id: requestId, path: diff.path, originalContent: diff.originalContent, modifiedContent: diff.modifiedContent, status: 'pending' as const }] }
      : next;
    if (autoDecision) {
      // Fold the diff state exactly like a user decision would, and log the
      // sandbox verdict instead of "waiting for approval".
      const folded = {
        ...withDiff,
        chat: withDiff.chat.map((item) =>
          item.kind === 'approval' && item.requestId === requestId && item.diff
            ? { ...item, diff: { ...item.diff, status: autoDecision === 'deny' ? 'rejected' as const : 'accepted' as const } }
            : item,
        ),
        pendingDiffs: withDiff.pendingDiffs.map((d) => d.id === requestId
          ? { ...d, status: autoDecision === 'deny' ? 'rejected' as const : 'accepted' as const }
          : d),
      };
      return addLog({ type: 'approval', phase: autoDecision === 'deny' ? 'failed' : 'done', title: '沙箱自动处理', detail: `${autoReason || ''}（${autoDecision === 'deny' ? '已拒绝' : '已允许'}）` }, 'executing', folded);
    }
    return { ...addLog({ type: 'approval', phase: 'running', title: '等待审批', detail: String(event.message || event.tool || '') }, 'executing'), chat: withDiff.chat, pendingDiffs: withDiff.pendingDiffs };
  }
  // UX-3 fix: errors from the bridge (API key missing, IPC failure, etc.) are
  // now stored as kind:'error' items so ConversationStream can style them
  // distinctly from genuine AI replies.  Previously they were injected as
  // kind:'assistant' which made error messages visually indistinguishable.
  if (event.type === 'error') {
    // Fall back to a message that says the cause is unknown, not one that
    // pretends to be the cause. "Agent error" reads like an explanation and
    // tells the user nothing.
    const text = String(event.message || '').trim() || '智能体报错，但没有提供原因。';
    const next = appendChat(state, { id: `error-${crypto.randomUUID()}`, kind: 'error', text });
    const closed = endTurn(state);
    // Do NOT force agentStatus here: a mid-turn provider error leaves the turn
    // running, and a dead bridge emits agent_offline right after. Forcing
    // 'ready' used to let the UI prompt a bridge that was already gone.
    return { ...addLog({ type: 'error', phase: 'failed', title: '执行失败', detail: text }, 'failed'), chat: [...closed.chat, ...next.chat.filter((item) => !closed.chat.some((existing) => existing.id === item.id))] };
  }
  return state;
}

/** Index of the current open working turn (kind 'turn', not yet ended), or -1. */
function openTurnIndex(state: AppState): number {
  for (let i = state.chat.length - 1; i >= 0; i -= 1) {
    const item = state.chat[i];
    if (item.kind === 'turn') return item.endedAt === undefined ? i : -1;
  }
  return -1;
}

function replaceChat(state: AppState, index: number, item: ChatItem): AppState {
  return { ...state, chat: state.chat.map((existing, i) => (i === index ? item : existing)) };
}

/** Add or remove a session from the running set. */
function markSessionRunning(state: AppState, sessionId: string | null, running: boolean): AppState {
  if (!sessionId) return state;
  const has = state.runningSessions.includes(sessionId);
  if (running === has) return state;
  return {
    ...state,
    runningSessions: running
      ? [...state.runningSessions, sessionId]
      : state.runningSessions.filter((id) => id !== sessionId),
  };
}

function startTurn(state: AppState): AppState {
  const running = { ...state, agentStatus: 'running' as const };
  // Guard against a duplicate turn_start without a matching turn_done.
  if (openTurnIndex(running) !== -1) return running;
  return appendChat(running, { id: `turn-${Date.now()}`, kind: 'turn', startedAt: Date.now(), steps: [], files: [], added: 0, removed: 0, undo: 'idle' });
}

function endTurn(state: AppState, cancelled = false): AppState {
  const index = openTurnIndex(state);
  if (index === -1) return state;
  const turn = state.chat[index];
  if (turn.kind !== 'turn') return state;
  // A pure-chat reply with no tool steps needs no "worked/changes" summary.
  if (turn.steps.length === 0) return { ...state, chat: state.chat.filter((_, i) => i !== index) };
  return replaceChat(state, index, { ...turn, endedAt: Date.now(), ...(cancelled ? { cancelled: true, steps: turn.steps.map(step => step.status === 'running' ? { ...step, status: 'done' as const, cancelled: true, output: step.output || '操作已停止' } : step) } : {}) });
}

function addTurnStep(state: AppState, step: ToolChatItem): AppState {
  const index = openTurnIndex(state);
  if (index === -1) return appendChat(state, step); // no active turn: fall back to a loose card
  const turn = state.chat[index];
  if (turn.kind !== 'turn') return appendChat(state, step);
  return replaceChat(state, index, { ...turn, steps: [...turn.steps, step] });
}

/** Append streamed thinking text onto the open turn's running `think` step. */
function appendThinkingText(state: AppState, text: string): AppState {
  if (!text) return state;
  return updateRunningThinkStep(state, (step) => ({ ...step, output: `${step.output ?? ''}${text}` }));
}

/** Mark the open turn's running `think` step as done with its duration. */
function finishThinkingStep(state: AppState, durationMs?: number): AppState {
  return updateRunningThinkStep(state, (step) => ({ ...step, status: 'done', ok: true, durationMs: durationMs ?? step.durationMs }));
}

function updateRunningThinkStep(state: AppState, mutate: (step: ToolChatItem) => ToolChatItem): AppState {
  const index = openTurnIndex(state);
  if (index === -1) return state;
  const turn = state.chat[index];
  if (turn.kind !== 'turn') return state;
  const steps = [...turn.steps];
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (step.kind === 'tool' && step.tool === 'think' && step.status === 'running') {
      steps[i] = mutate(step);
      return replaceChat(state, index, { ...turn, steps });
    }
  }
  return state;
}

function finishTurnStep(state: AppState, event: AgentEvent): AppState {
  const tool = String(event.tool || 'tool');
  const ok = event.ok !== false;
  const output = String(event.output || '');
  const data = isRecord(event.data) ? event.data : undefined;
  const cancelled = data?.cancelled === true;
  const added = data && typeof data.added === 'number' ? data.added : 0;
  const removed = data && typeof data.removed === 'number' ? data.removed : 0;
  const filePath = data && typeof data.path === 'string' ? data.path : undefined;
  const checkpointId = data && typeof data.checkpointId === 'string' ? data.checkpointId : undefined;
  // computer_screenshot ships the PNG base64 in data.computerImage; surface it
  // as a data URL so the tool card can render the actual screen the agent saw.
  const computerImage = data && isRecord(data.computerImage) ? data.computerImage : undefined;
  const screenshot = computerImage && typeof computerImage.data === 'string' && computerImage.data
    ? `data:${String(computerImage.mediaType || 'image/png')};base64,${computerImage.data}`
    : undefined;
  const index = openTurnIndex(state);
  if (index === -1) {
    // No active turn: emit a standalone done card as before.
    return appendChat(state, { id: `tool-${Date.now()}`, kind: 'tool', status: ok || cancelled ? 'done' : 'failed', cancelled, tool, output, ok, added: added || undefined, removed: removed || undefined, screenshot });
  }
  const turn = state.chat[index];
  if (turn.kind !== 'turn') return state;
  // Update the most recent running step of this tool; otherwise append one.
  let matched = false;
  const steps = turn.steps.slice();
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i].status === 'running' && steps[i].tool === tool) {
      const startedAt = steps[i].startedAt;
      const durationMs = startedAt ? Date.now() - startedAt : undefined;
      steps[i] = { ...steps[i], status: ok || cancelled ? 'done' : 'failed', cancelled, output, ok, added: added || undefined, removed: removed || undefined, durationMs, screenshot };
      matched = true;
      break;
    }
  }
  if (!matched) {
    steps.push({ id: `tool-${Date.now()}`, kind: 'tool', status: ok || cancelled ? 'done' : 'failed', cancelled, tool, output, ok, added: added || undefined, removed: removed || undefined, screenshot });
  }
  // Track distinct changed files for the "N 个文件已更改" summary. A file
  // written twice in one turn merges its line counts and keeps every
  // checkpoint id so undo reverts all of them.
  //
  // `data.path` alone does not mean the file changed: read_file, grep, stat
  // and a dozen other read-only tools all report the path they looked at.
  // Counting those made a pure read turn claim "1 个文件已更改" and offer an
  // Undo button that did nothing (files with no checkpoint are not undoable).
  // A real write either moved lines or produced a checkpoint.
  const touched = ok && Boolean(checkpointId || added || removed);
  const files = mergeTurnFile(turn.files, touched ? filePath : undefined, added, removed, checkpointId);
  return replaceChat(state, index, { ...turn, steps, files, added: turn.added + added, removed: turn.removed + removed });
}

function mergeTurnFile(
  files: TurnFileChange[],
  path: string | undefined,
  added: number,
  removed: number,
  checkpointId: string | undefined,
): TurnFileChange[] {
  if (!path) return files;
  const next = files.slice();
  const existing = next.findIndex((f) => f.path === path);
  if (existing === -1) {
    next.push({ path, added, removed, checkpointIds: checkpointId ? [checkpointId] : [] });
  } else {
    const current = next[existing];
    next[existing] = {
      path,
      added: current.added + added,
      removed: current.removed + removed,
      checkpointIds: checkpointId ? [...current.checkpointIds, checkpointId] : current.checkpointIds,
    };
  }
  return next;
}

function appendAssistantDelta(state: AppState, text: string): AppState {
  const last = state.chat[state.chat.length - 1];
  if (last?.kind === 'assistant' && last.id === 'assistant-live') {
    return { ...state, chat: [...state.chat.slice(0, -1), { ...last, text: `${last.text}${text}` }] };
  }
  return appendChat(state, { id: 'assistant-live', kind: 'assistant', text });
}

/**
 * Finalize the assistant reply. The CLI streams deltas into an `assistant-live`
 * bubble and then emits one complete `assistant_message`. If that final text
 * matches what we already streamed, promote the live bubble in place (give it a
 * stable id) instead of appending a duplicate. When nothing was streamed (e.g.
 * a non-streaming provider or a fallback message), append it fresh.
 */
function finalizeAssistant(state: AppState, text: string): AppState {
  const last = state.chat[state.chat.length - 1];
  if (last?.kind === 'assistant' && last.id === 'assistant-live') {
    // Prefer the fuller of the two: the final message is authoritative, but if
    // it arrives empty keep the streamed text so we never blank the reply.
    const finalText = text.trim() ? text : last.text;
    return { ...state, chat: [...state.chat.slice(0, -1), { id: `assistant-${Date.now()}`, kind: 'assistant', text: finalText }] };
  }
  return appendChat(state, { id: `assistant-${Date.now()}`, kind: 'assistant', text });
}

function contextStatsFromEvent(event: AgentEvent): ContextStats | null {
  const categories = event.categories;
  const localCache = event.localCache;
  if (!isRecord(categories) || !isRecord(localCache)) return null;
  const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return {
    provider: String(event.provider ?? ''),
    model: String(event.model ?? ''),
    // 缺了就保持 undefined：旧版 CLI 不报这两个字段，界面显示「窗口未知」，
    // 而不是拿一个猜出来的窗口算出看着很精确的百分比。
    contextWindow: typeof event.contextWindow === 'number' && event.contextWindow > 0 ? event.contextWindow : undefined,
    autoCompactLimit: typeof event.autoCompactLimit === 'number' && event.autoCompactLimit > 0 ? event.autoCompactLimit : undefined,
    inputTokens: number(event.inputTokens),
    outputTokens: number(event.outputTokens),
    providerCacheReported: event.providerCacheReported === true,
    cacheReadTokens: number(event.cacheReadTokens),
    cacheCreationTokens: number(event.cacheCreationTokens),
    predictedPromptCacheRate: typeof event.predictedPromptCacheRate === 'number' ? event.predictedPromptCacheRate : null,
    categories: {
      messages: number(categories.messages),
      systemTools: number(categories.systemTools),
      mcpTools: number(categories.mcpTools),
      skills: number(categories.skills),
      systemPrompt: number(categories.systemPrompt),
      other: number(categories.other),
    },
    localCache: {
      totalHits: number(localCache.totalHits),
      totalMisses: number(localCache.totalMisses),
      totalLookups: number(localCache.totalLookups),
      hitRate: typeof localCache.hitRate === 'number' ? localCache.hitRate : null,
      buckets: Array.isArray(localCache.buckets) ? localCache.buckets.map((item) => {
        const bucket = isRecord(item) ? item : {};
        return {
          name: String(bucket.name ?? ''),
          hits: number(bucket.hits),
          misses: number(bucket.misses),
          entries: typeof bucket.entries === 'number' ? bucket.entries : undefined,
          filesCached: typeof bucket.filesCached === 'number' ? bucket.filesCached : undefined,
          filesParsed: typeof bucket.filesParsed === 'number' ? bucket.filesParsed : undefined,
        };
      }) : [],
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function appendChat(state: AppState, item: ChatItem): AppState {
  return { ...state, chat: [...state.chat, item] };
}

/**
 * Sum genuine added/removed line counts across the whole conversation for the
 * always-on "更改 +N −M" topbar badge. Turn items already carry per-turn totals;
 * any standalone tool cards (loose, outside a turn) contribute their own real
 * diff counts too. Returns null when nothing changed, so the badge can hide.
 */
export function sessionChangeTotals(chat: ChatItem[]): { added: number; removed: number } | null {
  let added = 0;
  let removed = 0;
  for (const item of chat) {
    if (item.kind === 'turn') {
      added += item.added;
      removed += item.removed;
    } else if (item.kind === 'tool') {
      added += item.added ?? 0;
      removed += item.removed ?? 0;
    }
  }
  return added > 0 || removed > 0 ? { added, removed } : null;
}

export type SessionChangedFile = { path: string; added: number; removed: number };

/**
 * Per-file change totals for THIS conversation, newest file order preserved.
 *
 * The inspector's change counts used to come from `git diff` alone, which
 * reports the whole working tree: a conversation that changed nothing showed
 * the same +2945 −212 as every other one. This is the conversation's own
 * ledger — the same numbers the turn cards count — grouped by path so the
 * panel can list what this chat actually touched.
 */
export function sessionChangedFiles(chat: ChatItem[]): SessionChangedFile[] {
  const byPath = new Map<string, SessionChangedFile>();
  const add = (path: string | undefined, added: number, removed: number) => {
    if (!path) return;
    const previous = byPath.get(path);
    if (previous) {
      previous.added += added;
      previous.removed += removed;
    } else {
      byPath.set(path, { path, added, removed });
    }
  };
  for (const item of chat) {
    if (item.kind === 'turn') {
      for (const file of item.files ?? []) add(file.path, file.added, file.removed);
      continue;
    }
    if (item.kind !== 'tool') continue;
    // A standalone tool card carries the path on its input, not a diff payload.
    const input = isRecord(item.input) ? item.input : undefined;
    const path = input && typeof input.path === 'string' ? input.path : undefined;
    add(path, item.added ?? 0, item.removed ?? 0);
  }
  return [...byPath.values()].sort((a, b) => b.added + b.removed - (a.added + a.removed));
}

/**
 * Real-time progress data for the currently running turn (if any).
 * Returns null when no turn is active (agent idle/offline).
 * Used by the topbar live timer and the conversation-stream progress bar.
 */
export function activeTurnProgress(state: AppState): {
  elapsedMs: number;
  stepCount: number;
  added: number;
  removed: number;
  lastTool: string | null;
} | null {
  if (state.agentStatus !== 'running') return null;
  for (let i = state.chat.length - 1; i >= 0; i -= 1) {
    const item = state.chat[i];
    if (item.kind === 'turn' && item.endedAt === undefined) {
      const now = Date.now();
      const lastStep = item.steps[item.steps.length - 1];
      return {
        elapsedMs: now - item.startedAt,
        stepCount: item.steps.length,
        added: item.added,
        removed: item.removed,
        lastTool: lastStep?.tool ?? null,
      };
    }
  }
  return null;
}

/**
 * Extract a concise task title from user message text.
 * Uses simple pattern matching for common verbs + keywords.
 */
export function extractTaskTitle(text: string): string {
  const trimmed = text.trim();
  
  // Pattern: verb + object
  const patterns = [
    /^(修复|修改|fix|debug|解决)\s*(.+)/i,
    /^(添加|新增|add|create|实现|增加)\s*(.+)/i,
    /^(重构|优化|refactor|improve|改进)\s*(.+)/i,
    /^(删除|移除|remove|delete|清理)\s*(.+)/i,
    /^(更新|update|升级)\s*(.+)/i,
    /^(测试|test|验证)\s*(.+)/i,
    /^(部署|deploy|发布|上线)\s*(.+)/i,
    /^(查找|搜索|find|search)\s*(.+)/i,
    /^(分析|analyze|检查|review)\s*(.+)/i,
  ];
  
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match) {
      const verb = match[1];
      const object = match[2].slice(0, 15);
      return `${verb} ${object}`;
    }
  }
  
  // Fallback: use first 20 characters
  return trimmed.slice(0, 20) + (trimmed.length > 20 ? '...' : '');
}

export function languageForPath(path: string) {
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
  if (path.endsWith('.js') || path.endsWith('.jsx') || path.endsWith('.cjs') || path.endsWith('.mjs')) return 'javascript';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.md')) return 'markdown';
  if (path.endsWith('.css')) return 'css';
  if (path.endsWith('.html')) return 'html';
  return 'plaintext';
}

// Hydrate a persisted session record into renderable chat items. System
// messages are skipped; tool messages become collapsed "done" tool cards so a
// resumed conversation reads like it did live.
export function sessionToChat(record: {
  messages?: { role: string; content: string; name?: string; createdAt?: string; interrupted?: boolean; displayText?: string }[];
  toolCalls?: unknown[];
}): ChatItem[] {
  const messages = Array.isArray(record?.messages) ? record.messages : [];
  const items: ChatItem[] = [];
  let index = 0;

  // Messages carry the tool name and output but not its input, so a restored
  // step row fell back to the raw tool id ("list_files") instead of the path,
  // query or command the live row showed. toolCalls[] has the missing input —
  // and, being in call order, lines up with the tool messages one-for-one
  // (each call appends exactly one). Only use an entry when its name matches,
  // so a partial or reordered record degrades to the old behaviour rather
  // than labelling a step with another call's arguments.
  const calls = Array.isArray(record?.toolCalls)
    ? record.toolCalls.filter((call): call is { tool: string; input?: unknown; ok?: boolean; data?: unknown } =>
        Boolean(call) && typeof (call as { tool?: unknown }).tool === 'string')
    : [];
  const takeInput = (toolName: string): { input?: unknown; ok?: boolean; data?: unknown } => {
    while (calls.length > 0) {
      const call = calls.shift()!;
      if (call?.tool === toolName) return { input: call.input, ok: call.ok, data: call.data };
    }
    return {};
  };

  // Consecutive tool messages belong to one agent working round. Buffer them
  // and flush as a `turn` card when the round is terminated by an assistant
  // reply (or the next user prompt), so restored sessions render the same
  // expandable step-by-step view the live stream produces.
  let toolBuffer: ToolChatItem[] = [];
  let toolBufferStartedAt: number | undefined;
  // The changed-file summary lives in toolCalls[].data (path/added/removed/
  // checkpointId), so a restored turn can show the same 文件已更改 bar and
  // Undo button the live turn had. A live turn only counts a file when the
  // write produced a checkpoint or moved lines; mirror that test so a pure
  // read tool that merely reports `path` is not counted.
  let fileBuffer: TurnFileChange[] = [];
  const flushTurn = (endedAt?: number, cancelled = false) => {
    if (toolBuffer.length === 0) return;
    items.push({
      id: `load-turn-${index++}`,
      kind: 'turn',
      startedAt: toolBufferStartedAt ?? endedAt ?? Date.now(),
      endedAt: endedAt ?? toolBufferStartedAt ?? Date.now(),
      steps: toolBuffer,
      files: fileBuffer,
      added: fileBuffer.reduce((sum, file) => sum + file.added, 0),
      removed: fileBuffer.reduce((sum, file) => sum + file.removed, 0),
      elapsedUnknown: true,
      ...(cancelled ? { cancelled: true } : {}),
    });
    toolBuffer = [];
    fileBuffer = [];
    toolBufferStartedAt = undefined;
  };

  const changedFileFor = (data: unknown): TurnFileChange | undefined => {
    if (!data || typeof data !== 'object') return undefined;
    const record = data as { path?: unknown; added?: unknown; removed?: unknown; checkpointId?: unknown };
    const path = typeof record.path === 'string' ? record.path : '';
    const added = typeof record.added === 'number' ? record.added : 0;
    const removed = typeof record.removed === 'number' ? record.removed : 0;
    const checkpointId = typeof record.checkpointId === 'string' ? record.checkpointId : '';
    if (!path || !(checkpointId || added || removed)) return undefined;
    return { path, added, removed, checkpointIds: checkpointId ? [checkpointId] : [] };
  };
  const mergeFile = (file: TurnFileChange | undefined) => {
    if (!file) return;
    const existing = fileBuffer.findIndex((f) => f.path === file.path);
    if (existing === -1) { fileBuffer.push(file); return; }
    const current = fileBuffer[existing];
    fileBuffer[existing] = {
      path: file.path,
      added: current.added + file.added,
      removed: current.removed + file.removed,
      checkpointIds: [...current.checkpointIds, ...file.checkpointIds],
    };
  };

  for (const message of messages) {
    if (!message || typeof message.content !== 'string') continue;
    const ts = message.createdAt ? Date.parse(message.createdAt) || undefined : undefined;
    if (message.role === 'tool') {
      if (toolBuffer.length === 0) toolBufferStartedAt = ts;
      const call = takeInput(message.name || 'tool');
      if (call.ok !== false) mergeFile(changedFileFor(call.data));
      toolBuffer.push({
        id: `load-tool-${index++}`, kind: 'tool', status: 'done',
        tool: message.name || 'tool', output: message.content,
        ok: call.ok ?? true, input: call.input,
      });
      continue;
    }
    // A user or assistant message terminates the tool round above it.
    flushTurn(ts, message.role === 'assistant' && message.interrupted === true);
    if (message.role === 'user') {
      items.push({ id: `load-user-${index++}`, kind: 'user', text: typeof message.displayText === 'string' ? message.displayText : message.content, ts });
    } else if (message.role === 'assistant') {
      items.push({ id: `load-assistant-${index++}`, kind: 'assistant', text: message.content });
    }
    // 'system' messages are internal; skip them.
  }
  // A session may end mid-round (tool calls with no final reply).
  flushTurn();
  return items;
}
