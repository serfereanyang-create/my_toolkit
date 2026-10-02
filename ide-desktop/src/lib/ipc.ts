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

/** Immutable workspace snapshot pinned by a hidden git ref (see checkpoints.cjs). */
export type CheckpointMeta = {
  checkpointId: string;
  workspacePath: string;
  repoRoot: string;
  workspaceInRepoPath: string;
  createdAt: number;
  refName: string;
  commitOid: string;
  scope: 'workspace';
};

export type CheckpointConflict = {
  path: string;
  repoRelativePath: string;
  workspaceRelativePath: string;
  reason: 'unexpected-file-in-worktree' | 'missing-in-worktree' | 'type-mismatch' | 'content-mismatch';
};

export type CheckpointFileDiff = {
  path: string;
  repoRelativePath: string;
  workspaceRelativePath: string;
  originalPath: string | null;
  kind: 'added' | 'deleted' | 'modified' | 'renamed';
  added: number;
  removed: number;
};

export type CheckpointDiff = {
  fromCheckpointId: string;
  toCheckpointId: string;
  files: CheckpointFileDiff[];
};

export type CheckpointRestoreResult =
  | { success: true; restoredPaths: string[] }
  | { success: false; conflicts: CheckpointConflict[] };

/** A user-defined slash command backed by a markdown file with frontmatter. */
export type CustomCommand = {
  name: string;
  prompt: string;
  content: string;
  filePath: string;
  description?: string;
  argumentHint?: string;
  source: string;
  scope: 'user' | 'workspace';
};

/** Portable settings bundle — providers carry hasApiKey flags, never keys. */
export type SettingsBundle = {
  bundleVersion: 1;
  exportedAt: string;
  preferences: Record<string, unknown>;
  providers: Array<Record<string, unknown> & { id: string; hasApiKey: boolean }>;
};

/** Diagnostics snapshot for the settings about-panel. */
export type SystemInfoSnapshot = {
  collectedAt: string;
  platform: string;
  osRelease: string;
  osType: string;
  locale: string | null;
  cpuModel: string | null;
  cpuCores: number;
  totalMemBytes: number;
  freeMemBytes: number;
  hostname: string;
  nodeVersion: string;
  electronVersion: string | null;
  gitVersion: string | null;
  driveFreeBytes: number | null;
  uptimeSeconds: number;
};

/** One model round-trip, as written by the CLI's trajectory recorder. */
export type TrajectoryRecord = {
  requestId: string;
  turnId: string;
  step: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  ok: boolean;
  model: string;
  provider: string;
  /** Message count of the full context sent (not just the tail). */
  requestMessageCount: number;
  /** The real prompt tail: last few messages as actually sent. */
  requestTail: Array<{ role: string; content: string }>;
  responseText: string;
  toolNames: string[];
  promptChars: number;
  usage?: { inputTokens?: number; outputTokens?: number };
};

/** One pickable provider/model pair for the 省钱分级 dropdowns. */
export type DispatchOption = {
  /** `providerId/model` — the unambiguous value stored in settings. */
  value: string;
  /** `providerName · model` — what the user reads. */
  label: string;
  providerId: string;
  providerName: string;
  model: string;
  contextWindow?: number;
  hasKey: boolean;
};

/** One resolved dispatch tier, as shown in the settings panel. */
export type DispatchTierInfo = {
  provider: string;
  model: string;
  contextWindow: number | null;
  hasKey: boolean;
};

/** A project-memory entry from the CLI's shared memory store (read-only). */
export type ProjectMemorySummary = {
  id: string;
  label: string;
  updatedAt: number;
  files: Array<{ name: string; path: string; kind: 'index' | 'item'; size: number; updatedAt: number }>;
};

/** Renderer-facing audio/video preview payload (see media-preview.cjs). */
export type MediaPreviewPreparation =
  | { kind: 'local-url'; mediaType: string; path: string; size: number; url: string }
  | { kind: 'inline'; dataBase64: string; mediaType: string; path: string; size: number };

/** Read-only statistics for one sessions directory (empty-session cleanup). */
export type SessionCleanupAnalysis = {
  dir: string;
  total: number;
  empty: number;
  systemOnly: number;
  withContent: number;
  parseFailed: number;
  pinnedEmpty: number;
  candidateBytes: number;
  candidates: Array<{ id: string; file: string; title: string | null; createdAt: number | null; bytes: number; messageCount: number }>;
};

type ZCodeDesktopApi = {
  workspace: {
    open(): Promise<{ canceled: boolean; root?: string }>;
    setRoot(root: string): Promise<{ root: string }>;
    restore(): Promise<{ root: string | null; restored: boolean; reason?: string }>;
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
  appearance: {
    pickBackground(): Promise<{ ok: boolean; canceled?: boolean; version?: number; error?: string }>;
    readBackground(): Promise<{ ok: boolean; dataUrl?: string; version?: number }>;
    clearBackground(): Promise<{ ok: boolean }>;
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
    exportCsv(hours: 24 | 36 | 48): Promise<{ csv: string; count: number }>;
  };
  sessions: {
    list(): Promise<SessionMeta[]>;
    listArchived(): Promise<SessionMeta[]>;
    load(id: string): Promise<SessionRecord>;
    delete(id: string): Promise<{ ok: boolean; id: string }>;
    /**
     * Copy a conversation into a new session that inherits its whole history.
     * The source session is not modified.
     */
    fork(id: string): Promise<{ ok: boolean; id: string; sourceId: string; messageCount: number }>;
    rename(id: string, title: string): Promise<{ ok: boolean; id: string; title: string }>;
    pin(id: string, pinned: boolean): Promise<{ ok: boolean; id: string; pinned: boolean }>;
    archive(id: string, archived: boolean): Promise<{ ok: boolean; id: string; archived: boolean }>;
    reveal(id: string): Promise<{ ok: boolean }>;
    /** Export the transcript as markdown; returns the written file path. */
    export(id: string): Promise<{ ok: boolean; path: string; sha256: string; messageCount: number; unsupportedKinds: string[] }>;
    /** Per-call model trajectory: what each round-trip sent and returned. */
    trajectory(id: string): Promise<{ ok: boolean; records?: TrajectoryRecord[]; error?: string }>;
  };
  checkpoints: {
    create(): Promise<{ ok: boolean; meta: CheckpointMeta }>;
    list(): Promise<{ ok: boolean; metas: CheckpointMeta[] }>;
    diff(fromCheckpointId: string, toCheckpointId: string): Promise<{ ok: boolean; diff: CheckpointDiff }>;
    restore(fromCheckpointId: string, toCheckpointId: string, force?: boolean): Promise<{ ok: boolean; result: CheckpointRestoreResult }>;
    delete(checkpointId: string): Promise<{ ok: boolean }>;
  };
  fileSearch: {
    search(query: string, limit?: number): Promise<{ ok: boolean; files: Array<{ name: string; path: string; relativePath: string; type: 'file' | 'directory' }> }>;
  };
  resources: {
    /** CPU% is whole-machine normalized (100% = all logical cores saturated). */
    sample(): Promise<{ ok: boolean; usage: { pid: number; processCount: number; cpuPercent: number | null; rssKb: number; sampledAt: number } }>;
  };
  commands: {
    list(): Promise<{ ok: boolean; commands: CustomCommand[] }>;
    save(name: string, config: { prompt: string; description?: string; argumentHint?: string }): Promise<{ ok: boolean; name: string; filePath: string }>;
    delete(name: string): Promise<{ ok: boolean }>;
  };
  settingsPortability: {
    exportBundle(): Promise<{ ok: boolean; bundle: SettingsBundle }>;
    importBundle(bundle: unknown): Promise<{ ok: boolean; report: { providersAdded: number; providersUpdated: number; skipped: number } }>;
  };
  system: {
    info(): Promise<{ ok: boolean; info: SystemInfoSnapshot }>;
  };
  sessionCleanup: {
    analyze(dirs?: string[]): Promise<{ ok: boolean; analyses: SessionCleanupAnalysis[] }>;
    deleteFiles(dir: string, ids: string[]): Promise<{ ok: boolean; deleted: string[]; skipped: Array<{ id: string; reason: string }>; freedBytes: number }>;
  };
  gitSuggest: {
    suggestCommitMessage(sessionId?: string): Promise<{ ok: boolean; message: { subject: string; body: string; full: string; type: string; scope: string | null; changedFileCount: number; scopedFileCount: number; sessionFileCount: number } }>;
  };
  dispatch: {
    /** Resolve the session's 贵/便宜 tiers to real providers for the UI. */
    status(sessionId?: string): Promise<{ ok: boolean; configured: boolean; tiers?: { expensive: DispatchTierInfo; cheap: DispatchTierInfo }; error?: string }>;
    /**
     * Every dispatchable provider/model pair, from the CLI's own resolver.
     * The desktop's provider list uses different labels, so the pickers must
     * offer these instead.
     */
    options(): Promise<{ ok: boolean; options: DispatchOption[]; error?: string }>;
  };
  memory: {
    listProjects(): Promise<{ ok: boolean; projects: ProjectMemorySummary[] }>;
    read(workspaceId: string, fileName: string): Promise<{ ok: boolean; content: string; updatedAt: number }>;
  };
  media: {
    prepare(relativePath: string, expectedKind: 'audio' | 'video'): Promise<{ ok: boolean; preparation: MediaPreviewPreparation }>;
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
    /**
     * The trailing sessionId addresses one conversation's CLI child. Several can
     * be running at once, so omitting it may reach the wrong one.
     */
    prompt(text: string, files?: AttachedFile[], toolScope?: ToolScope, sessionId?: string): Promise<{ ok: boolean }>;
    taskBoardAction(action: 'confirm' | 'pause' | 'continue' | 'skip' | 'reopen', taskId?: string, sessionId?: string): Promise<{ ok: boolean }>;
    setEffort(reasoningEffort: ReasoningEffort, sessionId?: string): Promise<{ ok: boolean; reasoningEffort: ReasoningEffort }>;
    setToolScope(toolScope: ToolScope, sessionId?: string): Promise<{ ok: boolean; toolScope: ToolScope }>;
    cancel(sessionId?: string): Promise<{ ok: boolean }>;
    restart(resumeSessionId?: string): Promise<{ ok: boolean }>;
    /** Close one session's CLI child, leaving any others running. */
    stopSession(sessionId: string): Promise<{ ok: boolean }>;
    approve(requestId: string, decision: 'allow_once' | 'allow_session' | 'deny', sessionId?: string): Promise<{ ok: boolean }>;
    /** turnId 由 CLI 在 undo_done 事件中回显，是撤销结果归属的权威标识。 */
    undo(checkpointIds: string[], turnId?: string, sessionId?: string): Promise<{ ok: boolean }>;
    onEvent(handler: (event: AgentEvent) => void): () => void;
  };
  /**
   * Independent side-chat channel: its own bridge child and session, events on
   * a dedicated channel. Writes are auto-denied (read-only assistant).
   */
  sideChat: {
    prompt(text: string): Promise<{ ok: boolean }>;
    cancel(): Promise<{ ok: boolean }>;
    reset(): Promise<{ ok: boolean }>;
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
  /**
   * Typed quality tool gateway: invokes a read-only CLI analysis tool through
   * the main-process allowlist. Write-risk tools are refused on both sides.
   */
  quality: {
    invoke(toolName: string, input?: Record<string, unknown>, revision?: string): Promise<{ ok: boolean; output?: string; data?: unknown; error?: string }>;
    listTools(): Promise<{ ok: boolean; tools: string[] }>;
    /** 最近一次持久化的质量记录（.aicode/quality/<tool>/latest.json）。 */
    latest(toolName: string): Promise<{ schemaVersion: number; tool: string; capturedAt: string; revision?: string; input?: unknown; result?: { ok: boolean; output?: string; data?: unknown } } | null>;
    /** 最近 limit 条历史（新→旧）。 */
    history(toolName: string, limit?: number): Promise<Array<{ schemaVersion: number; tool: string; capturedAt: string; revision?: string; result?: { ok: boolean } }>>;
  };
  app: {
    getVersion(): Promise<{ version: string }>;
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
  search: {
    text(query: string, options?: SearchOptions): Promise<SearchResult>;
    sessions(query: string, options?: SessionSearchOptions): Promise<SessionSearchResult>;
  };
  quickopen: {
    index(force?: boolean): Promise<QuickOpenIndex>;
  };
  tags: {
    listAll(): Promise<Record<string, string[]>>;
    set(sessionId: string, tags: string[]): Promise<{ ok: boolean; sessionId?: string; tags?: string[]; error?: string }>;
    toggle(sessionId: string, tag: string): Promise<{ ok: boolean; sessionId?: string; tags?: string[]; error?: string }>;
    remove(sessionId: string): Promise<{ ok: boolean; removed?: string; error?: string }>;
  };
  subagents: {
    list(sessionId?: string): Promise<{ running: SubagentRun[]; finished: SubagentRun[] }>;
    remove(sessionId: string): Promise<{ ok: boolean; removed?: string; error?: string }>;
  };
  keybindings: {
    get(): Promise<Record<string, string>>;
    set(actionId: string, chord: string | null): Promise<{ ok: boolean; actionId?: string; chord?: string | null; error?: string }>;
  };
  plugins: {
    catalog(): Promise<import('./plugins').PluginDef[]>;
    status(): Promise<import('./plugins').PluginStatus>;
  };
  snippets: {
    list(): Promise<Snippet[]>;
    search(query: string): Promise<Snippet[]>;
    create(input: SnippetInput): Promise<Snippet>;
    update(id: string, patch: Partial<SnippetInput>): Promise<Snippet>;
    remove(id: string): Promise<{ ok: boolean; id: string }>;
    touch(id: string): Promise<{ ok: boolean; id: string; usageCount: number }>;
    export(): Promise<string>;
    import(rawJson: string): Promise<Snippet[]>;
  };
  bookmarks: {
    listAll(): Promise<BookmarkGroup[]>;
    listFor(relPath: string): Promise<Bookmark[]>;
    toggle(relPath: string, line: number, anchor?: string): Promise<{ ok: boolean; path: string; line: number; marked: boolean; count?: number }>;
    annotate(relPath: string, line: number, note: string): Promise<Bookmark>;
    move(relPath: string, fromLine: number, toLine: number): Promise<Bookmark>;
    remove(relPath: string, line: number): Promise<{ ok: boolean }>;
    clearFile(relPath: string): Promise<{ ok: boolean }>;
  };
  history: {
    list(relPath: string): Promise<HistoryEntry[]>;
    read(relPath: string, id: string): Promise<{ ok: boolean; content?: string; error?: string }>;
    restore(relPath: string, id: string): Promise<{ ok: boolean; error?: string }>;
    remove(relPath: string, id: string): Promise<{ ok: boolean; error?: string }>;
    clear(relPath: string): Promise<{ ok: boolean; error?: string }>;
    tracked(): Promise<TrackedFile[]>;
  };
  stats: {
    census(options?: { path?: string }): Promise<CodeCensus>;
  };
  notes: {
    list(sessionId: string): Promise<SessionNote[]>;
    add(sessionId: string, input: { text: string; pinned?: boolean }): Promise<SessionNote>;
    update(sessionId: string, noteId: string, patch: Partial<{ text: string; pinned: boolean }>): Promise<SessionNote>;
    remove(sessionId: string, noteId: string): Promise<{ ok: boolean }>;
    clear(sessionId: string): Promise<{ ok: boolean }>;
    summary(): Promise<NotesSummaryRow[]>;
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
    graph(n?: number): Promise<GitGraphResult>;
    diff(staged?: boolean): Promise<{ ok: boolean; diff?: string; error?: string }>;
    diffStats(): Promise<GitDiffStats>;
    fileStats(): Promise<GitFileStatsResult>;
    fileDiff(filePath: string, staged?: boolean, ref?: string): Promise<GitFileDiffResult>;
    commitDetail(ref: string): Promise<GitCommitDetailResult>;
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

/** Line-level working-tree totals for the Git tools card (+N −M badge). */
export type GitDiffStats = {
  ok: boolean;
  added?: number;
  removed?: number;
  fileCount?: number;
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

/** One file's working-tree delta, for the review list's per-row +N −M. */
export type GitFileStat = {
  path: string;
  added: number;
  removed: number;
  status: 'staged' | 'unstaged' | 'untracked';
};

export type GitFileStatsResult = {
  ok: boolean;
  files?: GitFileStat[];
  error?: string;
};

/** A commit plus its parent hashes — the DAG the graph view lays out. */
export type GitGraphCommit = GitCommit & { parents: string[] };

export type GitGraphResult = {
  ok: boolean;
  commits?: GitGraphCommit[];
  error?: string;
};

/** One file's diff text, for the inspector's file level. */
export type GitFileDiffResult = {
  ok: boolean;
  file?: string;
  diff?: string;
  staged?: boolean;
  /** True when the file is untracked, so the diff is a synthetic listing. */
  untracked?: boolean;
  error?: string;
};

export type GitCommitFile = {
  path: string;
  added: number;
  removed: number;
};

/** One commit's detail, for the inspector's commit level. */
export type GitCommitDetail = {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  message: string;
  body: string;
  files: GitCommitFile[];
};

export type GitCommitDetailResult = {
  ok: boolean;
  commit?: GitCommitDetail;
  error?: string;
};

/**
 * One subagent run, as listed in the 子智能体目录.
 *
 * `interrupted` means the run reported `started` but its parent bridge is gone,
 * so we cannot claim it is still working — the store reconciles that at read
 * time because a stale "running" row would mislead.
 */
export type SubagentRunStatus = 'running' | 'done' | 'failed' | 'interrupted';

export type SubagentRun = {
  id: string;
  goal: string;
  expert: string;
  status: SubagentRunStatus;
  startedAt: string;
  finishedAt?: string;
  answer?: string;
  subSessionId?: string;
  durationMs?: number;
  steps?: number;
};

export type UsageSource = 'provider-reported' | 'local-estimate';

export type UsageModelStats = {
  /** Stable identity: provider + baseUrl + model, not model id alone. */
  key?: string;
  model: string;
  provider?: string;
  baseUrl?: string;
  total: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  rounds: number;
  lastUsed?: number;
  source?: UsageSource;
};

export type UsageTotals = {
  tokens: number;
  rounds: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  source?: UsageSource;
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
  source?: UsageSource;
  /** 关联字段（新 ledger 行才有）。 */
  sessionId?: string;
  turnId?: string;
  toolCalls?: number;
  toolsUsed?: string[];
  boardId?: string;
  taskId?: string;
  durationMs?: number;
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
  /** Lossless provider+baseUrl+model buckets; optional for old IPC payloads. */
  byIdentity?: Record<string, number>;
  source?: UsageSource;
};

export type UsageSummary = {
  days: number;
  daily: UsageDay[];
  models: UsageModelStats[];
  /** 按会话聚合的下钻（新 ledger 行才有 sessionId；按 token 降序，前 10）。 */
  sessions?: UsageSessionStats[];
  totals: UsageTotals;
  source?: UsageSource;
};

export type UsageSessionStats = {
  sessionId: string;
  rounds: number;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  toolCalls: number;
  firstTs: number;
  lastTs: number;
  toolsUsed: string[];
  boardId?: string;
  taskId?: string;
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
  byIdentity?: Record<string, number>;
  source?: UsageSource;
};

export type UsageHourlySummary = {
  hours: number;
  hourly: UsageHourlyPoint[];
  models: UsageModelStats[];
  totals: UsageTotals;
  records: UsageRecord[];
  source?: UsageSource;
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

// ── Workspace full-text search (iteration 3) ─────────────────────────────────

export type SearchOptions = {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  include?: string;
  exclude?: string;
  path?: string;
  maxResults?: number;
};

export type SearchMatchContext = {
  line: number;
  content: string;
  matched: boolean;
};

export type SearchHit = {
  path: string;
  line: number;
  column: number;
  matched: string;
  preview: string;
  context: SearchMatchContext[];
};

export type SearchResult = {
  query: string;
  options: Required<Pick<SearchOptions, 'caseSensitive' | 'wholeWord' | 'regex' | 'include' | 'exclude'>>;
  results: SearchHit[];
  filesScanned: number;
  skippedBinary: number;
  skippedLarge: number;
  truncated: boolean;
  /** Set when the scan hit its file/time budget and results are partial. */
  scanWarning?: string;
  elapsedMs: number;
  error?: string;
};

// ── Cross-session transcript search (iteration 16) ───────────────────────────

export type SessionSearchOptions = {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  roles?: string[];
  maxResults?: number;
  context?: number;
};

export type SessionSearchContextLine = { line: number; text: string; matched: boolean };

export type SessionSearchHit = {
  messageIndex: number;
  role: string;
  createdAt: string;
  lineNo?: number;
  matchedText: string;
  context: SessionSearchContextLine[];
};

export type SessionSearchResultRow = {
  sessionId: string;
  updatedAt: string;
  model: string;
  hitCount: number;
  hits: SessionSearchHit[];
};

export type SessionSearchResult = {
  query: string;
  options: Record<string, unknown>;
  results: SessionSearchResultRow[];
  sessionsScanned: number;
  corrupted?: number;
  truncated?: boolean;
  elapsedMs: number;
  error?: string;
};

// ── Quick-open file index (iteration 17) ─────────────────────────────────────

export type QuickOpenFile = { path: string; mtimeMs: number };

export type QuickOpenIndex = {
  files: QuickOpenFile[];
  truncated: boolean;
  elapsedMs: number;
  cached: boolean;
  error?: string;
};

// ── Code snippets library (iteration 4) ──────────────────────────────────────

export type Snippet = {
  id: string;
  title: string;
  language: string;
  body: string;
  tags: string[];
  description: string;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
};

export type SnippetInput = {
  title: string;
  language?: string;
  body: string;
  tags?: string[];
  description?: string;
};

// ── Line bookmarks (iteration 6) ─────────────────────────────────────────────

export type Bookmark = {
  line: number;
  anchor: string;
  note: string;
  createdAt: string;
};

export type BookmarkGroup = {
  path: string;
  bookmarks: Bookmark[];
};

// ── File save history timeline (iteration 7) ─────────────────────────────────

export type HistoryEntry = {
  /** Snapshot id — the stored file name under the hash directory. */
  id: string;
  ts: number;
  size: number;
};

export type TrackedFile = {
  path: string;
  count: number;
  lastTs: number;
  totalBytes: number;
};

// ── Workspace code census (iteration 9) ──────────────────────────────────────

export type CensusLanguage = {
  language: string;
  files: number;
  lines: number;
  code: number;
  comment: number;
  blank: number;
};

export type CensusDir = { dir: string; files: number; bytes: number };
export type CensusFile = { path: string; bytes: number; lines: number };
export type CensusTodo = { path: string; line: number; text: string };

export type CodeCensus = {
  error?: string;
  totalFiles: number;
  totalBytes?: number;
  totalLines?: number;
  codeLines?: number;
  commentLines?: number;
  blankLines?: number;
  languages?: CensusLanguage[];
  directories?: CensusDir[];
  largestFiles?: CensusFile[];
  todos?: CensusTodo[];
  todoCount?: number;
  skippedLarge?: number;
  truncated?: boolean;
  scanWarning?: string;
  elapsedMs?: number;
};

// ── Session notes sidecar (iteration 10) ─────────────────────────────────────

export type SessionNote = {
  id: string;
  text: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
};

export type NotesSummaryRow = {
  sessionId: string;
  count: number;
  pinned: number;
  lastUpdatedAt: string;
};

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
