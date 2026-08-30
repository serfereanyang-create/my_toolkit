import type { AgentEvent, AppState, ChatItem, ContextStats, DesktopSettings, PendingDiff, PreviewTab, ToolChatItem, TreeNode, TurnFileChange, WorkLogEntry, TaskBoard } from '../types';

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
};

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'settings/loaded':
      return { ...state, settings: action.settings };
    case 'workspace/opened':
      return { ...state, workspaceRoot: action.root, tree: [], agentStatus: 'offline', contextStats: null };
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
      return { ...state, chat: [], activeSessionId: null, agentStatus: 'offline', contextStats: null, taskSummary: null };
    case 'chat/load':
      // Go offline so the next prompt re-starts the bridge with --resume for
      // the loaded session, keeping desktop chat and CLI session in sync.
      return { ...state, chat: action.chat, activeSessionId: action.sessionId, agentStatus: 'offline', contextStats: null, taskSummary: null };
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
      // Mark the approval card as decided so its buttons disable and it shows
      // the chosen outcome, giving immediate feedback while the CLI proceeds.
      return {
        ...state,
        chat: state.chat.map((item) =>
          item.kind === 'approval' && item.requestId === action.requestId
            ? { ...item, decided: action.decision }
            : item,
        ),
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
      return { ...state, pendingDiffs: [...state.pendingDiffs.filter((d) => d.path !== action.diff.path), action.diff] };
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
  const addLog = (entry: Omit<WorkLogEntry, 'id' | 'ts'>, phase: AppState['workPhase'] = state.workPhase): AppState => ({
    ...state,
    workLog: [...state.workLog, { ...entry, id: `work-${crypto.randomUUID()}`, ts: now }].slice(-200),
    workPhase: phase,
  });
  if (event.type === 'task_board_updated') {
    return { ...addLog({ type: 'task', phase: 'info', title: '任务计划已更新', detail: String(event.title ?? '') , data: event.tasks }, state.workPhase), taskBoard: event as unknown as TaskBoard };
  }
  if (event.type === 'bridge_ready') return addLog({ type: 'info', phase: 'info', title: '智能体已连接', detail: `${String(event.provider ?? '')} / ${String(event.model ?? '')}` }, 'idle');
  if (event.type === 'model_start') return addLog({ type: 'model', phase: 'running', title: '思考中', detail: '模型正在分析当前任务' }, 'thinking');
  if (event.type === 'model_end') return addLog({ type: 'model', phase: 'done', title: '思考完成', detail: '模型已返回下一步行动' }, state.workPhase);
  if (event.type === 'thinking_start') return addLog({ type: 'thinking', phase: 'running', title: '思考过程', detail: String(event.text || '') }, 'thinking');
  if (event.type === 'thinking_delta') {
    const previous = [...state.workLog].reverse().find((entry) => entry.type === 'thinking' && entry.phase === 'running');
    if (!previous) return addLog({ type: 'thinking', phase: 'running', title: '思考过程', detail: String(event.text || '') }, 'thinking');
    return { ...state, workLog: state.workLog.map((entry) => entry.id === previous.id ? { ...entry, detail: `${entry.detail ?? ''}${String(event.text || '')}` } : entry) };
  }
  if (event.type === 'thinking_end') {
    const previous = [...state.workLog].reverse().find((entry) => entry.type === 'thinking' && entry.phase === 'running');
    return previous ? { ...state, workLog: state.workLog.map((entry) => entry.id === previous.id ? { ...entry, phase: 'done', durationMs: typeof event.durationMs === 'number' ? event.durationMs : entry.durationMs } : entry) } : state;
  }
  if (event.type === 'info') return addLog({ type: 'info', phase: 'info', title: '过程提示', detail: String(event.content ?? event.message ?? '') }, state.workPhase);
  if (event.type === 'bridge_ready') return { ...state, agentStatus: 'ready' };
  if (event.type === 'turn_start') return { ...startTurn(state), workLog: [], workPhase: 'thinking' };
  if (event.type === 'turn_done') return { ...endTurn(state), agentStatus: 'ready', workPhase: 'done' };
  if (event.type === 'agent_offline') {
    // Close any open turn that never received a turn_done (e.g. process crash).
    // Without this, subsequent tool_start events get appended to the zombie turn.
    return { ...endTurn(state), agentStatus: 'offline' };
  }
  if (event.type === 'context_stats') {
    const contextStats = contextStatsFromEvent(event);
    return contextStats ? { ...state, contextStats } : state;
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
    return addLog({ type: 'tool', phase: event.ok === false ? 'failed' : 'done', title: String(event.tool || 'tool'), tool: String(event.tool || 'tool'), detail: String(event.output || ''), durationMs: typeof event.durationMs === 'number' ? event.durationMs : undefined, data: event.data }, state.workPhase);
  }
  if (event.type === 'approval_needed') {
    const next = appendChat(state, { id: String(event.requestId || `approval-${crypto.randomUUID()}`), kind: 'approval', requestId: String(event.requestId || ''), tool: String(event.tool || 'tool'), message: String(event.message || 'Approval required'), input: event.input, risk: (event.risk as 'read' | 'write' | 'shell' | 'network' | undefined) });
    return { ...addLog({ type: 'approval', phase: 'running', title: '等待审批', detail: String(event.message || event.tool || '') }, 'executing'), chat: next.chat };
  }
  // UX-3 fix: errors from the bridge (API key missing, IPC failure, etc.) are
  // now stored as kind:'error' items so ConversationStream can style them
  // distinctly from genuine AI replies.  Previously they were injected as
  // kind:'assistant' which made error messages visually indistinguishable.
  if (event.type === 'error') {
    const next = appendChat(state, { id: `error-${crypto.randomUUID()}`, kind: 'error', text: String(event.message || 'Agent error') });
    const closed = endTurn(state);
    return { ...addLog({ type: 'error', phase: 'failed', title: '执行失败', detail: String(event.message || 'Agent error') }, 'failed'), chat: [...closed.chat, ...next.chat.filter((item) => !closed.chat.some((existing) => existing.id === item.id))], agentStatus: 'ready' };
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

function finishTurnStep(state: AppState, event: AgentEvent): AppState {
  const tool = String(event.tool || 'tool');
  const ok = event.ok !== false;
  const output = String(event.output || '');
  const data = isRecord(event.data) ? event.data : undefined;
  const added = data && typeof data.added === 'number' ? data.added : 0;
  const removed = data && typeof data.removed === 'number' ? data.removed : 0;
  const filePath = data && typeof data.path === 'string' ? data.path : undefined;
  const checkpointId = data && typeof data.checkpointId === 'string' ? data.checkpointId : undefined;
  const index = openTurnIndex(state);
  if (index === -1) {
    // No active turn: emit a standalone done card as before.
    return appendChat(state, { id: `tool-${Date.now()}`, kind: 'tool', status: ok ? 'done' : 'failed', tool, output, ok, added: added || undefined, removed: removed || undefined });
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
      steps[i] = { ...steps[i], status: ok ? 'done' : 'failed', output, ok, added: added || undefined, removed: removed || undefined, durationMs };
      matched = true;
      break;
    }
  }
  if (!matched) {
    steps.push({ id: `tool-${Date.now()}`, kind: 'tool', status: ok ? 'done' : 'failed', tool, output, ok, added: added || undefined, removed: removed || undefined });
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
  for (const message of messages) {
    if (!message || typeof message.content !== 'string') continue;
    const ts = message.createdAt ? Date.parse(message.createdAt) || undefined : undefined;
    if (message.role === 'user') {
      items.push({ id: `load-user-${index++}`, kind: 'user', text: message.content, ts });
    } else if (message.role === 'assistant') {
      items.push({ id: `load-assistant-${index++}`, kind: 'assistant', text: message.content });
    } else if (message.role === 'tool') {
      items.push({ id: `load-tool-${index++}`, kind: 'tool', status: 'done', tool: message.name || 'tool', output: message.content, ok: true });
    }
    // 'system' messages are internal; skip them.
  }
  return items;
}
