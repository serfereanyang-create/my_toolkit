import type { AgentEvent, AppState, ChatItem, ContextStats, DesktopSettings, PendingDiff, PreviewTab, SupervisorSnapshot, ToolChatItem, TreeNode, TurnFileChange, WorkLogEntry, TaskBoard } from '../types';

export type AppAction =
  | { type: 'settings/loaded'; settings: DesktopSettings }
  | { type: 'workspace/opened'; root: string }
  | { type: 'tree/loaded'; tree: TreeNode[] }
  | { type: 'view/set'; view: AppState['activeView'] }
  | { type: 'chat/user'; text: string }
  | { type: 'chat/clear' }
  | { type: 'chat/load'; sessionId: string; chat: ChatItem[] }
  | { type: 'agent/status'; status: AppState['agentStatus'] }
  | { type: 'agent/event'; event: AgentEvent }
  | { type: 'approval/decided'; requestId: string; decision: 'allow_once' | 'allow_session' | 'deny' }
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
  preview: { open: false, width: DEFAULT_PREVIEW_WIDTH, tabs: [], activeTabId: null },
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
};

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'settings/loaded':
      return { ...state, settings: action.settings };
    case 'workspace/opened':
      return { ...state, workspaceRoot: action.root, tree: [], agentStatus: 'offline', contextStats: null, pendingDiffs: [] };
    case 'tree/loaded':
      return { ...state, tree: action.tree };
    case 'view/set':
      return { ...state, activeView: action.view };
    case 'chat/user':
      return { 
        ...state, 
        // Bug-10 fix: use crypto.randomUUID() instead of Date.now() to avoid
        // millisecond-level key collisions when messages are dispatched rapidly.
        chat: [...state.chat, { id: `user-${crypto.randomUUID()}`, kind: 'user', text: action.text, ts: Date.now() }],
        taskSummary: { title: extractTaskTitle(action.text), expanded: false }
      };
    case 'chat/clear':
      // Detach from any live bridge so the next prompt starts a fresh session.
      // pendingDiffs belong to the old session's approvals — drop them too.
      return { ...state, chat: [], activeSessionId: null, agentStatus: 'offline', contextStats: null, taskSummary: null, pendingDiffs: [] };
    case 'chat/load':
      // Go offline so the next prompt re-starts the bridge with --resume for
      // the loaded session, keeping desktop chat and CLI session in sync.
      return { ...state, chat: action.chat, activeSessionId: action.sessionId, agentStatus: 'offline', contextStats: null, taskSummary: null, pendingDiffs: [] };
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

function reduceAgentEvent(state: AppState, event: AgentEvent): AppState {
  const now = Date.now();
  const addLog = (entry: Omit<WorkLogEntry, 'id' | 'ts'>, phase: AppState['workPhase'] = state.workPhase, base: AppState = state): AppState => ({
    ...base,
    workLog: [...base.workLog, { ...entry, id: `work-${crypto.randomUUID()}`, ts: now }].slice(-200),
    workPhase: phase,
  });
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
    return { ...addLog({ type: 'task', phase: 'info', title: '任务计划已更新', detail: String(event.title ?? '') , data: event.tasks }, state.workPhase), taskBoard: { ...board, id: boardId, startedAt } };
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
      ...(sessionId ? { activeSessionId: sessionId } : {}),
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
  if (event.type === 'turn_start') {
    // The CLI emits turn_start both from the bridge wrapper and from inside
    // runAgentTurn. A duplicate for an already-open turn must not wipe the
    // workLog the first one started filling.
    if (openTurnIndex(state) !== -1) return startTurn(state);
    return { ...startTurn(state), workLog: [], workPhase: 'thinking' };
  }
  if (event.type === 'turn_done') {
    // A failed turn used to close silently. The CLI sends the failure reason on
    // turn_done, but nothing rendered it: the transcript kept only whatever had
    // streamed before the failure (often nothing) and the toast said just
    // "执行失败". Record the reason as the same kind:'error' item the bridge
    // errors use, so it stays readable after the toast is gone.
    const reason = event.status === 'error' && typeof event.reason === 'string' ? event.reason.trim() : '';
    const closed = endTurn(state);
    const next = reason
      ? appendChat(closed, { id: `turn-error-${crypto.randomUUID()}`, kind: 'error', text: reason })
      : closed;
    return { ...next, agentStatus: 'ready', workPhase: 'done' };
  }
  if (event.type === 'agent_offline') {
    // Close any open turn that never received a turn_done (e.g. process crash).
    // Without this, subsequent tool_start events get appended to the zombie turn.
    const closed = endTurn(state);
    // Pending approvals belonged to the dead bridge: the CLI broker is gone, so
    // clicking them would hit "Unknown approval request". Per the desktop spec,
    // dismissed approvals are DENIED — mark their cards and diffs accordingly.
    const chat = closed.chat.map((item) =>
      item.kind === 'approval' && !item.decided
        ? { ...item, decided: 'deny' as const, diff: item.diff ? { ...item.diff, status: 'rejected' as const } : undefined }
        : item,
    );
    return { ...closed, chat, pendingDiffs: [], agentStatus: 'offline' };
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
          ctxTokens: contextStats.inputTokens,
          cacheRate: contextStats.providerCacheReported && contextStats.inputTokens > 0
            ? Math.min(100, Math.round((contextStats.cacheReadTokens / contextStats.inputTokens) * 100))
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
    const next = appendChat(state, { id: requestId, kind: 'approval', requestId, tool: String(event.tool || 'tool'), message: String(event.message || 'Approval required'), input: event.input, risk: (event.risk as 'read' | 'write' | 'shell' | 'network' | undefined), decided: autoDecision, autoReason, diff: diff && typeof diff.path === 'string' ? { id: requestId, path: diff.path, originalContent: diff.originalContent, modifiedContent: diff.modifiedContent, status: 'pending' } : undefined });
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
    const next = appendChat(state, { id: `error-${crypto.randomUUID()}`, kind: 'error', text: String(event.message || 'Agent error') });
    const closed = endTurn(state);
    // Do NOT force agentStatus here: a mid-turn provider error leaves the turn
    // running, and a dead bridge emits agent_offline right after. Forcing
    // 'ready' used to let the UI prompt a bridge that was already gone.
    return { ...addLog({ type: 'error', phase: 'failed', title: '执行失败', detail: String(event.message || 'Agent error') }, 'failed'), chat: [...closed.chat, ...next.chat.filter((item) => !closed.chat.some((existing) => existing.id === item.id))] };
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

function startTurn(state: AppState): AppState {
  const running = { ...state, agentStatus: 'running' as const };
  // Guard against a duplicate turn_start without a matching turn_done.
  if (openTurnIndex(running) !== -1) return running;
  return appendChat(running, { id: `turn-${Date.now()}`, kind: 'turn', startedAt: Date.now(), steps: [], files: [], added: 0, removed: 0, undo: 'idle' });
}

function endTurn(state: AppState): AppState {
  const index = openTurnIndex(state);
  if (index === -1) return state;
  const turn = state.chat[index];
  if (turn.kind !== 'turn') return state;
  // A pure-chat reply with no tool steps needs no "worked/changes" summary.
  if (turn.steps.length === 0) return { ...state, chat: state.chat.filter((_, i) => i !== index) };
  return replaceChat(state, index, { ...turn, endedAt: Date.now() });
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
    return appendChat(state, { id: `tool-${Date.now()}`, kind: 'tool', status: ok ? 'done' : 'failed', tool, output, ok, added: added || undefined, removed: removed || undefined, screenshot });
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
      steps[i] = { ...steps[i], status: ok ? 'done' : 'failed', output, ok, added: added || undefined, removed: removed || undefined, durationMs, screenshot };
      matched = true;
      break;
    }
  }
  if (!matched) {
    steps.push({ id: `tool-${Date.now()}`, kind: 'tool', status: ok ? 'done' : 'failed', tool, output, ok, added: added || undefined, removed: removed || undefined, screenshot });
  }
  // Track distinct changed files for the "N 个文件已更改" summary. A file
  // written twice in one turn merges its line counts and keeps every
  // checkpoint id so undo reverts all of them.
  const files = mergeTurnFile(turn.files, ok ? filePath : undefined, added, removed, checkpointId);
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
  messages?: { role: string; content: string; name?: string; createdAt?: string }[];
}): ChatItem[] {
  const messages = Array.isArray(record?.messages) ? record.messages : [];
  const items: ChatItem[] = [];
  let index = 0;

  // Consecutive tool messages belong to one agent working round. Buffer them
  // and flush as a `turn` card when the round is terminated by an assistant
  // reply (or the next user prompt), so restored sessions render the same
  // expandable step-by-step view the live stream produces.
  let toolBuffer: ToolChatItem[] = [];
  let toolBufferStartedAt: number | undefined;
  const flushTurn = (endedAt?: number) => {
    if (toolBuffer.length === 0) return;
    items.push({
      id: `load-turn-${index++}`,
      kind: 'turn',
      startedAt: toolBufferStartedAt ?? endedAt ?? Date.now(),
      endedAt: endedAt ?? toolBufferStartedAt ?? Date.now(),
      steps: toolBuffer,
      files: [],
      added: 0,
      removed: 0,
    });
    toolBuffer = [];
    toolBufferStartedAt = undefined;
  };

  for (const message of messages) {
    if (!message || typeof message.content !== 'string') continue;
    const ts = message.createdAt ? Date.parse(message.createdAt) || undefined : undefined;
    if (message.role === 'tool') {
      if (toolBuffer.length === 0) toolBufferStartedAt = ts;
      toolBuffer.push({ id: `load-tool-${index++}`, kind: 'tool', status: 'done', tool: message.name || 'tool', output: message.content, ok: true });
      continue;
    }
    // A user or assistant message terminates the tool round above it.
    flushTurn(ts);
    if (message.role === 'user') {
      items.push({ id: `load-user-${index++}`, kind: 'user', text: message.content, ts });
    } else if (message.role === 'assistant') {
      items.push({ id: `load-assistant-${index++}`, kind: 'assistant', text: message.content });
    }
    // 'system' messages are internal; skip them.
  }
  // A session may end mid-round (tool calls with no final reply).
  flushTurn();
  return items;
}
