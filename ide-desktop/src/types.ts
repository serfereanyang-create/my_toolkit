export type ProviderType = 'mock' | 'openai' | 'anthropic' | 'custom';
export type ApprovalMode = 'ask' | 'auto' | 'plan' | 'deny';
export type ReasoningEffort = 'auto' | 'off' | 'low' | 'medium' | 'high' | 'max';
export type ToolScope = 'auto' | 'compact' | 'standard' | 'full';
/**
 * How readily the agent hands work to a sub-agent. Mirrors the CLI's
 * DelegationLevel; the strings must match or the CLI's arg parser rejects them.
 */
export type DelegationLevel = 'off' | 'balanced' | 'eager';
export type ActivityView = 'files' | 'search' | 'sessions' | 'settings';

export type AutomationTrigger =
  | { type: 'cron'; expression: string }
  | { type: 'file_watch'; patterns: string[]; events: Array<'create' | 'modify' | 'delete'>; debounceMs: number }
  | { type: 'git_event'; events: Array<'commit' | 'push' | 'pull'>; branches: string[]; pollIntervalMs: number }
  | { type: 'manual' };

export type AutomationTask = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  action: { type: 'task_board'; goal: string; confirmPlan: true };
  lastRunAt?: string;
  lastRunStatus?: 'success' | 'failed' | 'blocked';
  lastRunError?: string;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
};

export type AutomationRun = {
  taskId: string;
  status: 'success' | 'failed' | 'blocked';
  reason?: string;
  startedAt: string;
  finishedAt: string;
  trigger: Record<string, unknown>;
};

// Wire protocol used by a provider endpoint. Legacy openai/anthropic values
// remain valid and are normalized to openai-chat/anthropic-messages at runtime.
export type ApiFormat = 'openai' | 'anthropic' | 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-generative';

export type ProviderVendor = 'openai' | 'anthropic' | 'google' | 'xai' | 'zhipu' | 'moonshot' | 'deepseek' | 'custom';

// One model entry within a provider. contextWindow is display-only metadata
// (the "660K" badge in the model list). Price fields use $/1M tokens (the
// standard unit in API pricing); omitted or 0 means "not configured".
// callMode indicates the supported invocation pattern (default: streaming).
export type CustomModel = {
  id: string;
  contextWindow?: number;
  inputPricePerM?: number;
  outputPricePerM?: number;
  cacheReadPricePerM?: number;
  cacheWritePricePerM?: number;
  callMode?: 'streaming' | 'non-streaming' | 'sync';
};

export type ProviderConfig = {
  id: string;
  type: ProviderType;
  label: string;
  model: string;
  baseUrl: string;
  keyHint?: string;
  // Custom-provider fields (type === 'custom'). apiFormat picks the wire
  // format; models is the selectable catalog shown in the model menu.
  apiFormat?: ApiFormat;
  vendor?: ProviderVendor;
  models?: CustomModel[];
};

export type ThemeMode = 'system' | 'light' | 'dark';

// Free-form UI preferences persisted alongside the core settings. Kept as an
// open record so the mock settings pages can persist without a schema change
// per field; typed keys below document the ones with real effect today.
export type DesktopPreferences = {
  theme?: ThemeMode;
  reasoningEffort?: ReasoningEffort;
  reasoningEffortByModel?: Record<string, ReasoningEffort>;
  toolScope?: ToolScope;
  /**
   * Global default for tiered dispatch (省钱分级): the expensive/cheap model
   * pair. A session can still override it via /省钱分级; this is what new
   * sessions start from. Model names only — credentials come from the
   * provider config at dispatch time.
   */
  dispatchDefault?: {
    expensive?: string;
    cheap?: string;
  };
  taskExecutionMode?: 'auto' | 'plan';
  /**
   * Auto-review risky actions with a second model call instead of prompting the
   * user. Reaches the CLI as --auto-review.
   */
  autoReview?: boolean;
  /**
   * Sub-agent delegation eagerness. Reaches the CLI as --delegation.
   * Absent means the CLI's default (eager).
   */
  delegation?: DelegationLevel;
  // Git workflow prefs (GitSettings). Injected into .aicode/persona.md so the
  // agent follows branch/PR/commit guidance. Flat keys match savePref patches.
  gitBranchPrefix?: string;
  gitMergeMethod?: 'merge' | 'squash' | 'rebase';
  gitForcePush?: boolean;
  gitDraftPr?: boolean;
  gitReviewMode?: 'inline' | 'separate';
  gitCommitGuide?: string;
  gitPrGuide?: string;
  // Computer control prefs (ComputerSettings).
  computerAnyApp?: boolean;
  computerExcel?: boolean;
  computerAllowedApps?: string[];   // list of exe/app names allowed without ask
  // Editor prefs (AppearanceSettings → Monaco). All have real consumers.
  uiFontSize?: number;
  uiChineseFont?: string;
  uiEnglishFont?: string;
  codeFontSize?: number;
  editorTabSize?: number;
  editorMinimap?: boolean;
  editorWordWrap?: boolean;
  // Appearance → background image. `backgroundImage` is the toggle and
  // `backgroundDim` / `backgroundBlur` are the readability controls; the image
  // itself lives in userData/backgrounds (see appearance.* IPC), never here.
  backgroundImage?: boolean;
  backgroundDim?: number;
  backgroundBlur?: number;
  backgroundScope?: 'app' | 'chat';
  /** Bumped on every image change so App.tsx re-reads the stored file. */
  backgroundVersion?: number;
  [key: string]: unknown;
};

export type DesktopSettings = {
  activeProviderId: string;
  approval: ApprovalMode;
  providers: ProviderConfig[];
  recentWorkspaces: string[];
  preferences?: DesktopPreferences;
};

export type SessionMeta = {
  id: string;
  title: string;
  pinned: boolean;
  archived?: boolean;
  updatedAt: string;
  messageCount: number;
};

export type SessionMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  createdAt?: string;
};

export type SessionRecord = {
  id: string;
  createdAt: string;
  updatedAt: string;
  provider: string;
  model: string;
  workspaceRoot: string;
  messages: SessionMessage[];
  toolCalls?: unknown[];
  finalAnswers?: string[];
};

export type TreeNode = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: TreeNode[];
};

export type ContextCategoryTokens = {
  messages: number;
  systemTools: number;
  mcpTools: number;
  skills: number;
  systemPrompt: number;
  other: number;
};

export type LocalCacheBucket = {
  name: string;
  hits: number;
  misses: number;
  entries?: number;
  filesCached?: number;
  filesParsed?: number;
};

export type ContextStats = {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  providerCacheReported: boolean;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  predictedPromptCacheRate: number | null;
  categories: ContextCategoryTokens;
  localCache: {
    totalHits: number;
    totalMisses: number;
    totalLookups: number;
    hitRate: number | null;
    buckets: LocalCacheBucket[];
  };
};

export type AgentEvent = {
  type: string;
  [key: string]: unknown;
};

export type ToolChatItem = {
  id: string;
  kind: 'tool';
  status: 'running' | 'done' | 'failed';
  tool: string;
  input?: unknown;
  output?: string;
  ok?: boolean;
  added?: number;
  removed?: number;
  /** Wall-clock timestamp when the tool started (ms since epoch) */
  startedAt?: number;
  /** How long the tool took to complete in milliseconds */
  durationMs?: number;
  /** computer_screenshot: PNG as a data URL, rendered inline on the tool card. */
  screenshot?: string;
};

export type ChatItem =
  | { id: string; kind: 'user'; text: string; ts?: number }
  | { id: string; kind: 'assistant'; text: string }
  // UX-3 fix: dedicated 'error' kind so system errors (API key missing, bridge
  // crash, etc.) render with a distinct error style rather than as AI replies.
  | { id: string; kind: 'error'; text: string }
  // Context compaction divider (Codex "正在压缩上下文" → "上下文已自动压缩").
  // 'running' rows flip to 'done'/'failed' when the follow-up event arrives.
  | { id: string; kind: 'compaction'; phase: 'running' | 'done' | 'failed'; auto: boolean; before?: number; after?: number; reason?: string }
  // A finished code review (CLI /review). The report is ALSO written into the
  // CLI's session history, so it survives a reload; this row is what renders it
  // as findings with click-to-jump while the session is live.
  | { id: string; kind: 'review'; label: string; ok: boolean; error?: string; unparsed?: boolean; findings: ReviewFinding[]; outcome?: 'correct' | 'incorrect' | 'unknown'; explanation?: string; subSessionId?: string; durationMs?: number }
  | ToolChatItem
  | { id: string; kind: 'approval'; requestId: string; tool: string; message: string; input?: unknown; risk?: 'read' | 'write' | 'shell' | 'network'; diff?: PendingDiff; decided?: 'allow_once' | 'allow_session' | 'deny'; autoReason?: string }
  // A single agent working round: the tool steps it ran, the distinct files it
  // changed (with real per-file diff counts and checkpoint ids for undo), plus
  // genuine elapsed time and added/removed totals summed from tool results.
  | {
      id: string;
      kind: 'turn';
      startedAt: number;
      endedAt?: number;
      steps: ToolChatItem[];
      files: TurnFileChange[];
      added: number;
      removed: number;
      undo?: 'idle' | 'undoing' | 'undone' | 'failed';
      /** Codex-style per-turn footer: real context/cache numbers stamped from
       *  the latest context_stats snapshot while this turn was running. */
      ctxTokens?: number;
      cacheRate?: number | null;
    };

// One distinct file changed during a turn. `checkpointIds` are the CLI backup
// ids to revert (a file written twice in one turn has multiple).
export type TurnFileChange = { path: string; added: number; removed: number; checkpointIds: string[] };

/**
 * One finding from an AI code review, as the CLI parsed it out of the
 * reviewer's rubric-shaped reply.
 *
 * `priority` is deliberately optional: the reviewer may not state one, and
 * showing "未分级" is honest where defaulting to P2 would invent a severity.
 * Likewise `unparsed` on the review row distinguishes "the reviewer found
 * nothing" from "the reviewer's reply could not be read" — the two look
 * identical if you only count findings.
 */
export type ReviewFinding = {
  title: string;
  body: string;
  /** 0-3 (P0-P3), absent when the reviewer did not state one. */
  priority?: number;
  confidenceScore?: number;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
};

export type TaskSummary = {
  title: string;
  expanded: boolean;
};

export type ContextCompactionState = {
  tier: 'passthrough' | 'soft' | 'hard';
  budgetChars: number;
  usedChars: number;
  messagesDropped: number;
  summaryGenerated: boolean;
};

export type TaskBoardStatus = 'draft' | 'active' | 'completed' | 'blocked' | 'cancelled';
export type TaskItemStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'cancelled' | 'skipped';
export type TaskBoard = {
  id: string;
  title: string;
  goal: string;
  status: TaskBoardStatus;
  runtimeMode: 'idle' | 'planning' | 'awaiting_confirm' | 'executing' | 'paused';
  activeTaskId?: string;
  /**
   * The plan document the model wrote, in Markdown. Only present when the model
   * genuinely planned the task; boards built from the CLI's step template have
   * no prose body and the card skips the plan section entirely.
   */
  planMarkdown?: string;
  /** Wall-clock ms when this board was first received; drives the goal elapsed timer. */
  startedAt?: number;
  tasks: Array<{
    id: string;
    title: string;
    status: TaskItemStatus;
    dependsOn: string[];
    /**
     * A single acceptance sentence. The CLI declares `acceptance?: string`
     * (cli/src/tasks/types.ts), so this is NOT a list — rendering it as one used
     * to throw inside the card and take the whole app down with it, because the
     * ErrorBoundary wraps the app root.
     */
    acceptance?: string;
    detail?: string;
    /** How the CLI names a finished task's summary. */
    resultSummary?: string;
    error?: string;
    startedAt?: string;
    finishedAt?: string;
  }>;
};

/**
 * One unit of work as the CLI's supervisor reports it. The CLI aggregates
 * subagents, board tasks, and turns into a single stream so the UI can answer
 * "what is running and is any of it stuck" without joining three event types.
 */
export type SupervisedUnit = {
  id: string;
  kind: 'subagent' | 'task' | 'turn';
  label: string;
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';
  parentId?: string;
  /** Segment index when a sub-agent rolled over into a new session (1 = first). */
  segment?: number;
  steps: number;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  error?: string;
  sessionId?: string;
  expert?: string;
};

export type SupervisorSnapshot = {
  units: SupervisedUnit[];
  running: number;
  done: number;
  failed: number;
  steps: number;
  longestRunningMs?: number;
  /** Sub-agent runs this session has produced, and which experts they used. */
  delegated?: number;
  delegatedExperts?: string[];
};

/**
 * A message the user submitted while the agent was busy.
 *
 * Held instead of rejected: a running turn used to make a new submission fail
 * outright ("Agent turn already running"), which lost whatever the user typed.
 * Queueing keeps their place in line and sends it when the turn ends.
 *
 * `files` mirrors `AttachedFile` structurally rather than importing it —
 * lib/ipc.ts reads `window.zcodeDesktop` at module scope, so types.ts must not
 * depend on it.
 */
export type QueuedMessage = {
  id: string;
  sessionId: string;
  text: string;
  files?: Array<{ path: string; name: string; size: number }>;
  createdAt: number;
};

export type WorkLogEntry = {
  id: string;
  ts: number;
  type: 'model' | 'thinking' | 'tool' | 'info' | 'approval' | 'task' | 'error';
  phase: 'started' | 'running' | 'done' | 'failed' | 'info';  title: string;
  detail?: string;
  tool?: string;
  durationMs?: number;
  data?: unknown;
};

export type AppState = {
  workspaceRoot: string;
  activeView: ActivityView;
  settings: DesktopSettings | null;
  tree: TreeNode[];
  chat: ChatItem[];
  agentStatus: 'offline' | 'starting' | 'ready' | 'running';
  bottomOpen: boolean;
  activeSessionId: string | null;
  /** Latest genuine context/cache snapshot emitted by the running CLI turn. */
  contextStats: ContextStats | null;
  /** Task summary card shown in the top bar. */
  taskSummary: TaskSummary | null;
  /** Context compaction state for visualization. */
  contextCompaction: ContextCompactionState | null;
  /** Right-side preview sidebar state. */
  preview: PreviewState;
  /** Pending file diffs waiting for user accept/reject */
  pendingDiffs: PendingDiff[];
  /** Side chat panel state */
  sideChatOpen: boolean;
  sideChatWidth: number;
  /** Browser panel state */
  browserOpen: boolean;
  browserWidth: number;
  workLog: WorkLogEntry[];
  workPanelOpen: boolean;
  workPhase: 'idle' | 'thinking' | 'exploring' | 'executing' | 'done' | 'failed';
  taskBoard: TaskBoard | null;
  taskExecutionMode: 'auto' | 'plan';
  /**
   * Aggregate progress across every unit of work in the session, as reported by
   * the CLI supervisor. Null until the first update arrives.
   */
  supervisor: SupervisorSnapshot | null;
  /**
   * Session ids with a turn in flight, including conversations that are not on
   * screen. Each conversation has its own CLI child, so several can work at once.
   */
  runningSessions: string[];
  /**
   * Pending approval count per session id. A background conversation blocked on
   * an approval is invisible otherwise — the user would see a stalled session
   * with no explanation.
   */
  sessionApprovals: Record<string, number>;
  /**
   * Messages waiting for their turn to be sent, in submission order. Each entry
   * names the session it belongs to, so a queue survives switching conversations.
   */
  messageQueue: QueuedMessage[];
};

// ─── Pending diff types ───────────────────────────────────────────────────────

export type PendingDiff = {
  id: string;
  path: string;
  originalContent: string;
  modifiedContent: string;
  status: 'pending' | 'accepted' | 'rejected';
};

// ─── Preview sidebar types ────────────────────────────────────────────────────

export type PreviewKind = 'image' | 'pdf' | 'docx' | 'doc_unsupported' | 'html' | 'text' | 'web';

export type PreviewFileDescriptor = {
  absolutePath: string;
  relativePath: string;
  name: string;
  ext: string;
  kind: PreviewKind;
  size: number;
  token: string;
};

export type ProjectDescriptor = {
  absolutePath: string;
  relativePath: string;
  name: string;
  framework: string;
  pkgManager: string;
  lockfile: string | null;
  hasNodeModules: boolean;
  scripts: Record<string, string>;
  recommendedScript: string | null;
  staticEntry: string | null;
  needsInstall: boolean;
  token: string;
};

export type PreviewTab = {
  id: string;
  title: string;
  kind: PreviewKind;
  descriptor: PreviewFileDescriptor | ProjectDescriptor;
  /** For web/html: the loopback URL being served */
  webUrl?: string;
  /** Allowed port for navigation policy */
  allowedPort?: number;
  status: 'loading' | 'ready' | 'error' | 'installing' | 'starting';
  error?: string;
  zoom: number;
  /** Navigation availability for web previews */
  canGoBack?: boolean;
  canGoForward?: boolean;
  /** Fit-to-width mode for docx/pdf */
  fitWidth: boolean;
};

export type PreviewState = {
  open: boolean;
  width: number;
  tabs: PreviewTab[];
  activeTabId: string | null;
};

