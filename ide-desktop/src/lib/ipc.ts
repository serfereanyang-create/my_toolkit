import type { AgentEvent, AutomationRun, AutomationTask, DesktopSettings, TreeNode, SessionMeta, SessionRecord, ReasoningEffort, ToolScope } from '../types';

export type LanguageRange = { line: number; column: number; endLine: number; endColumn: number };

export type LanguageHoverResult = {
  ok: boolean;
  result?: { type: string; documentation: string; path: string; range: LanguageRange } | null;
  error?: string;
};

export type LanguageDefinitionResult = {
  ok: boolean;
  result?: Array<{ path: string; range: LanguageRange }>;
  error?: string;
};

export type LanguageReference = {
  path: string;
  range: LanguageRange;
  isDefinition: boolean;
  lineText: string;
};

export type LanguageReferencesResult = {
  ok: boolean;
  result?: LanguageReference[];
  error?: string;
};

export type LanguageCompletionsResult = {
  ok: boolean;
  result?: Array<{ label: string; kind: string; detail?: string; insertText: string }>;
  error?: string;
};

export type AttachedFile = {
  path: string;
  name: string;
  size: number;
  mediaType?: string;
};

type ZCodeDesktopApi = {
  workspace: {
    open(): Promise<{ canceled: boolean; root?: string }>;
    setRoot(root: string): Promise<{ root: string }>;
    restore(): Promise<{ root: string; restored: boolean }>;
    getTree(relativePath?: string): Promise<TreeNode[]>;
  };
  fs: {
    read(relativePath: string): Promise<string>;
    write(relativePath: string, content: string): Promise<{ ok: boolean; path: string }>;
    saveTempImage(filename: string, base64Data: string): Promise<string>;
  };
  editor: {
    readFile(absolutePath: string): Promise<{ ok: boolean; content?: string; error?: string }>;
    saveFile(absolutePath: string, content: string): Promise<{ ok: boolean; error?: string }>;
    watchFile(absolutePath: string): Promise<{ ok: boolean; alreadyWatching?: boolean; error?: string }>;
    unwatchFile(absolutePath: string): Promise<{ ok: boolean }>;
    stat(absolutePath: string): Promise<{ ok: boolean; mtimeMs?: number; size?: number; error?: string }>;
    onFileChanged(handler: (payload: { path: string }) => void): () => void;
  };
  settings: {
    get(): Promise<DesktopSettings>;
    set(next: Partial<DesktopSettings>): Promise<DesktopSettings>;
  };
  secrets: {
    setApiKey(providerId: string, apiKey: string): Promise<{ configured: boolean; hint: string }>;
    hasApiKey(providerId: string): Promise<{ configured: boolean; hint: string }>;
  };
  connectivity: {
    test(providerId: string): Promise<ConnectivityResult>;
  };
  usage: {
    summary(days: 7 | 30 | 90): Promise<UsageSummary>;
    hourly(hours: 24 | 36 | 48): Promise<UsageHourlySummary>;
    cachePrediction(model?: string): Promise<CachePrediction>;
    records(hours: 24 | 36 | 48, offset: number, limit: number): Promise<UsageRecordsResult>;
  };
  sessions: {
    list(): Promise<SessionMeta[]>;
    listArchived(): Promise<SessionMeta[]>;
    load(id: string): Promise<SessionRecord>;
    delete(id: string): Promise<{ ok: boolean; id: string }>;
    rename(id: string, title: string): Promise<{ ok: boolean; id: string; title: string }>;
    pin(id: string, pinned: boolean): Promise<{ ok: boolean; id: string; pinned: boolean }>;
    archive(id: string, archived: boolean): Promise<{ ok: boolean; id: string; archived: boolean }>;
    reveal(id: string): Promise<{ ok: boolean }>;
  };
  automation: {
    list(): Promise<AutomationTask[]>;
    get(taskId: string): Promise<AutomationTask | null>;
    create(input: Omit<AutomationTask, 'id' | 'enabled' | 'lastRunAt' | 'lastRunStatus' | 'lastRunError' | 'consecutiveFailures' | 'createdAt' | 'updatedAt'>): Promise<AutomationTask>;
    update(taskId: string, updates: Partial<Pick<AutomationTask, 'name' | 'description' | 'trigger' | 'action'>>): Promise<AutomationTask>;
    delete(taskId: string): Promise<boolean>;
    start(taskId: string): Promise<AutomationTask>;
    stop(taskId: string): Promise<AutomationTask>;
    run(taskId: string): Promise<{ ok: boolean; status: string; taskId: string }>;
    history(taskId: string, limit?: number): Promise<AutomationRun[]>;
    active(): Promise<Array<{ id: string; type: AutomationTask['trigger']['type'] }>>;
    onChanged(handler: () => void): () => void;
  };
  agent: {
    start(resumeSessionId?: string): Promise<{ ok: boolean }>;
    prompt(text: string, files?: AttachedFile[], toolScope?: ToolScope): Promise<{ ok: boolean }>;
    taskBoardAction(action: 'confirm' | 'pause' | 'continue' | 'skip' | 'reopen', taskId?: string): Promise<{ ok: boolean }>;
    setEffort(reasoningEffort: ReasoningEffort): Promise<{ ok: boolean; reasoningEffort: ReasoningEffort }>;
    setToolScope(toolScope: ToolScope): Promise<{ ok: boolean; toolScope: ToolScope }>;
    cancel(): Promise<{ ok: boolean }>;
    restart(): Promise<{ ok: boolean }>;
    approve(requestId: string, decision: 'allow_once' | 'allow_session' | 'deny'): Promise<{ ok: boolean }>;
    undo(checkpointIds: string[]): Promise<{ ok: boolean }>;
    onEvent(handler: (event: AgentEvent) => void): () => void;
  };
  ai: {
    complete(request: CompletionRequest): Promise<CompletionResponse>;
    edit(selection: string, instruction: string, context: any): Promise<string | null>;
  };
  window: {
    minimize(): Promise<{ ok: boolean }>;
    toggleMaximize(): Promise<{ ok: boolean; maximized: boolean }>;
    close(): Promise<{ ok: boolean }>;
  };
  clipboard: {
    write(text: string): Promise<{ ok: boolean }>;
  };
  computer: {
    detectBrowserExtension(): Promise<{ installed: boolean; extensions: Array<{ browser: string; extensionId: string; name: string }> }>;
  };
  terminal: {
    create(options?: { cwd?: string }): Promise<{ id: string; cwd: string; shell: string }>;
    write(id: string, data: string): Promise<{ ok: boolean }>;
    resize(id: string, cols: number, rows: number): Promise<{ ok: boolean }>;
    kill(id: string): Promise<{ ok: boolean }>;
    onEvent(handler: (event: TerminalEvent) => void): () => void;
  };
  preview: {
    describe(relativePath: string): Promise<import('../types').PreviewFileDescriptor>;
    inspectProject(relativePath: string): Promise<import('../types').ProjectDescriptor | null>;
    startStatic(relativePath: string, token: string): Promise<{ ok: boolean; port?: number; error?: string }>;
    startDevServer(relativePath: string, script: string, pkgManager: string, token: string): Promise<{ ok: boolean; port?: number; error?: string }>;
    stopPreview(token: string): Promise<{ ok: boolean }>;
    installDeps(relativePath: string, pkgManager: string): Promise<{ ok: boolean; canceled?: boolean; exitCode?: number }>;
    setBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<{ ok: boolean }>;
    show(url: string, allowedPort?: number): Promise<{ ok: boolean }>;
    hide(): Promise<{ ok: boolean }>;
    back(): Promise<{ ok: boolean }>;
    forward(): Promise<{ ok: boolean }>;
    reload(): Promise<{ ok: boolean }>;
    canNavigate(): Promise<{ canGoBack: boolean; canGoForward: boolean }>;
    openExternal(url: string): Promise<{ ok: boolean }>;
    readDocx(relativePath: string, token: string): Promise<{ ok: boolean; buffer?: ArrayBuffer; byteOffset?: number; byteLength?: number; error?: string }>;
    onState(handler: (state: PreviewGuestState) => void): () => void;
    onLog(handler: (payload: { token: string; line: string }) => void): () => void;
  };
  nav: {
    symbols(pattern: string): Promise<NavSymbolHit[]>;
    fileSearch(pattern: string): Promise<NavFileHit[]>;
    readSymbolContext(filePath: string, line: number): Promise<NavSymbolContext>;
  };
  fim: {
    complete(req: { prefix: string; suffix: string; language?: string; filepath?: string; maxTokens?: number }): Promise<{ ok: boolean; insert?: string; latencyMs?: number; truncated?: boolean; error?: string }>;
    configure(opts: { provider?: string; apiKey?: string; baseUrl?: string; model?: string; maxTokens?: number }): Promise<{ ok: boolean; error?: string }>;
  };
  language: {
    hover(req: { workspaceRoot: string; path: string; line: number; column: number }): Promise<LanguageHoverResult>;
    definition(req: { workspaceRoot: string; path: string; line: number; column: number }): Promise<LanguageDefinitionResult>;
    references(req: { workspaceRoot: string; path: string; line: number; column: number }): Promise<LanguageReferencesResult>;
    completions(req: { workspaceRoot: string; path: string; line: number; column: number }): Promise<LanguageCompletionsResult>;
  };
  git: {
    status(): Promise<GitStatus>;
    branches(): Promise<GitBranchList>;
    log(n?: number): Promise<GitLogResult>;
    diff(staged?: boolean): Promise<{ ok: boolean; diff?: string; error?: string }>;
    fileChangeRanges(filePath: string): Promise<{ ok: boolean; file?: string; hunks?: Array<{ start: number; end: number; type: string }>; error?: string }>;
    stage(paths: string[]): Promise<{ ok: boolean; staged?: string[]; error?: string }>;
    unstage(paths: string[]): Promise<{ ok: boolean; unstaged?: string[]; error?: string }>;
    discard(paths: string[]): Promise<{ ok: boolean; discarded?: string[]; error?: string }>;
    commit(message: string): Promise<{ ok: boolean; shortHash?: string; message?: string; output?: string; error?: string }>;
    push(remote?: string, branch?: string, force?: boolean): Promise<{ ok: boolean; output?: string; error?: string }>;
    pull(remote?: string, branch?: string): Promise<{ ok: boolean; output?: string; error?: string }>;
    checkout(branch: string): Promise<{ ok: boolean; branch?: string; error?: string }>;
    createBranch(name: string): Promise<{ ok: boolean; branch?: string; error?: string }>;
    deleteBranch(name: string, force?: boolean): Promise<{ ok: boolean; branch?: string; error?: string }>;
    createPr(opts: { title: string; body?: string; draft?: boolean; base?: string }): Promise<{ ok: boolean; url?: string; number?: number | null; title?: string; output?: string; error?: string }>;
  };
};

export type ConnectivityResult = {
  ok: boolean;
  status?: number;
  latencyMs?: number;
  message: string;
  sample?: string;
};

// ── Git types (mirrored from electron/git.cjs return shapes) ─────────────────

export type GitFileStatus = { path: string; index: string; working: string };

export type GitStatus = {
  ok: boolean;
  branch?: string;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  staged?: GitFileStatus[];
  unstaged?: GitFileStatus[];
  untracked?: string[];
  hasConflicts?: boolean;
  error?: string;
};

export type GitBranchList = {
  ok: boolean;
  current?: string;
  local?: string[];
  remote?: string[];
  error?: string;
};

export type GitCommit = {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  message: string;
};

export type GitLogResult = {
  ok: boolean;
  commits?: GitCommit[];
  error?: string;
};

export type UsageModelStats = {
  model: string;
  total: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  rounds: number;
  lastUsed?: number;
};

export type UsageTotals = {
  tokens: number;
  rounds: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
};

export type UsageRecord = {
  id: string;
  timestamp: number;
  model: string;
  provider: string;
  baseUrl?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
  reasoningEffort?: string;
};

export type UsageRecordsResult = {
  records: UsageRecord[];
  total: number;
};

export type UsageDay = {
  date: string; // YYYY-MM-DD (local)
  total: number;
  rounds: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  byModel: Record<string, number>;
};

export type UsageSummary = {
  days: number;
  daily: UsageDay[];
  models: UsageModelStats[];
  totals: UsageTotals;
};

export type UsageHourlyPoint = {
  startTs: number;
  label: string;   // "8月18日 11:00"
  total: number;
  rounds: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  byModel: Record<string, number>;
};

export type UsageHourlySummary = {
  hours: number;
  hourly: UsageHourlyPoint[];
  models: UsageModelStats[];
  totals: UsageTotals;
  records: UsageRecord[];
};

// Real historical prompt-cache-hit-rate prediction. `predicted` is null when
// there are too few real cache-reporting samples (UI shows "暂无预测样本").
export type CachePrediction = {
  predicted: number | null;
  samples: number;
  model: string | null;
  windowDays: number;
  source?: 'local-estimate' | 'provider-reported';
};

export type TerminalEvent =
  | { id: string; type: 'data'; data: string }
  | { id: string; type: 'exit'; code: number; error?: string };

export type PreviewGuestState = {
  loading?: boolean;
  url?: string;
  title?: string;
  error?: string;
  externalLinkRequest?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
};

export type NavSymbolHit = {
  name: string;
  kind: string;
  path: string;
  line: number;
};

export type NavFileHit = {
  name: string;
  path: string;
  type: 'file' | 'directory';
};

export type NavSymbolContext = {
  path: string;
  line: number;
  context: string;
  startLine: number;
} | null;

// ── AI API types ──────────────────────────────────────────────────────────────

export type CompletionRequest = {
  filePath: string;
  language: string;
  prefix: string;
  suffix: string;
  cursorLine: number;
  cursorColumn: number;
  triggerKind: 'automatic' | 'manual' | 'comment';
};

export type CompletionResponse = {
  id: string;
  text: string;
  range: { start: { line: number; column: number }; end: { line: number; column: number } };
  confidence: number;
} | null;

declare global {
  interface Window {
    zcodeDesktop: ZCodeDesktopApi;
  }
}

export const desktop = window.zcodeDesktop;
