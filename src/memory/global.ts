import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

/*
 * Global memory: one ledger of every file ZCode has ever edited, across every
 * workspace and every session.
 *
 * The project store (<workspace>/.aicode/memory/entries.json) answers "what do
 * we know about this project". This one answers "what have we touched, ever" —
 * it survives sessions, switching projects and deleting the workspace copy.
 *
 * Layout under ~/.zcode/cli/memories/global:
 *   edits.jsonl  append-only record {at, project, workspace, action, path}
 *   MEMORY.md    human-readable index, regenerated from the ledger tail
 *
 * Both files are derived data: nothing here is authoritative over the code
 * itself, so a corrupt ledger is dropped rather than throwing on every write.
 */

const INDEX_FILE_NAME = 'MEMORY.md';
const LEDGER_FILE_NAME = 'edits.jsonl';
/** Rotate once the ledger grows past this; keeps reads cheap forever. */
const LEDGER_ROTATE_BYTES = 4 * 1024 * 1024;
const LEDGER_KEEP_LINES = 4000;
/**
 * MEMORY.md is rendered from the whole ledger, so rewriting it on every single
 * edit turns a burst of writes into O(burst × ledger). Appending stays
 * immediate; the index is rewritten at most this often, with a trailing render
 * so the last edit of a burst is never lost.
 */
export const DEFAULT_INDEX_THROTTLE_MS = 800;
const indexWrites = new Map<string, { last: number; timer?: NodeJS.Timeout }>();
const INDEX_PROJECT_LIMIT = 12;
const INDEX_FILE_LIMIT = 12;
const SUMMARY_FILE_LIMIT = 8;

export type GlobalEditAction = 'write' | 'rename' | 'delete';

export type GlobalEditRecord = {
  /** ISO timestamp of the edit. */
  at: string;
  /** Workspace folder name the edit happened in. */
  project: string;
  /** Absolute workspace root. */
  workspace: string;
  action: GlobalEditAction;
  /** File touched (destination for a rename). Workspace-relative when inside it. */
  path: string;
  /** Old name, for renames only. */
  from?: string;
  /** True when a write created a file that did not exist before. */
  created: boolean;
};

export function globalMemoryRoot(): string {
  const override = process.env.AICODE_GLOBAL_MEMORY_ROOT;
  if (override && override.trim()) return override.trim();
  return join(homedir(), '.zcode', 'cli', 'memories', 'global');
}

/**
 * Throwaway workspaces (unit-test fixtures, scratch dirs) never belong in the
 * "everything you ever edited" record, and silently recording them would also
 * make every test run write to the user's home directory.
 */
export function isScratchWorkspace(workspaceRoot: string): boolean {
  const normalise = (value: string) => {
    const resolved = resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const rel = relative(normalise(tmpdir()), normalise(workspaceRoot));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function globalMemoryIndexPath(root: string = globalMemoryRoot()): string {
  return join(root, INDEX_FILE_NAME);
}

export function globalMemoryLedgerPath(root: string = globalMemoryRoot()): string {
  return join(root, LEDGER_FILE_NAME);
}

/**
 * Record one edit. Errors are the caller's to swallow: memory must never break
 * a write that already succeeded.
 */
export async function recordGlobalEdit(
  input: {
    workspaceRoot: string;
    action: GlobalEditAction;
    path: string;
    from?: string;
    created?: boolean;
    now?: Date;
  },
  options: { root?: string; indexThrottleMs?: number } = {},
): Promise<GlobalEditRecord> {
  const root = options.root ?? globalMemoryRoot();
  const at = (input.now ?? new Date()).toISOString();
  const record: GlobalEditRecord = {
    at,
    project: projectName(input.workspaceRoot),
    workspace: input.workspaceRoot,
    action: input.action,
    path: displayPath(input.workspaceRoot, input.path),
    ...(input.from ? { from: displayPath(input.workspaceRoot, input.from) } : {}),
    created: input.created === true,
  };
  await mkdir(root, { recursive: true });
  await appendFile(globalMemoryLedgerPath(root), `${JSON.stringify(record)}\n`, 'utf8');
  await rotateLedger(root);
  await refreshIndex(root, at, options.indexThrottleMs ?? DEFAULT_INDEX_THROTTLE_MS);
  return record;
}

/** Rewrite MEMORY.md from the ledger. Cheap enough to run a few times a second, not per write. */
async function writeIndex(root: string, at: string, now: number) {
  const previous = indexWrites.get(root);
  if (previous?.timer) clearTimeout(previous.timer);
  indexWrites.set(root, { last: now });
  const records = await readGlobalEdits({ root, limit: LEDGER_KEEP_LINES });
  await writeFile(globalMemoryIndexPath(root), renderGlobalMemoryIndex(records, at), 'utf8');
}

/**
 * Rewrite the index now, or schedule a trailing rewrite when a burst is in
 * progress. `throttleMs <= 0` means "every write rewrites it" (tests, and any
 * caller that needs the file up to date synchronously).
 */
async function refreshIndex(root: string, at: string, throttleMs: number) {
  const now = Date.now();
  if (throttleMs <= 0) {
    await writeIndex(root, at, now);
    return;
  }
  const state = indexWrites.get(root);
  if (!state || now - state.last >= throttleMs) {
    await writeIndex(root, at, now);
    return;
  }
  if (state.timer) return;
  // Trailing render: fire once the window closes so the newest edits land in
  // MEMORY.md without another write having to arrive first.
  const timer = setTimeout(() => {
    const current = indexWrites.get(root);
    if (current) delete current.timer;
    const stamp = new Date().toISOString();
    void writeIndex(root, stamp, Date.now()).catch(() => undefined);
  }, Math.max(0, throttleMs - (now - state.last)));
  timer.unref?.();
  state.timer = timer;
}

/** The most recent `limit` records, oldest first. Unreadable lines are skipped. */
export async function readGlobalEdits(options: { root?: string; limit?: number } = {}): Promise<GlobalEditRecord[]> {
  const root = options.root ?? globalMemoryRoot();
  let raw: string;
  try {
    raw = await readFile(globalMemoryLedgerPath(root), 'utf8');
  } catch {
    return [];
  }
  const limit = options.limit ?? LEDGER_KEEP_LINES;
  const records: GlobalEditRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as GlobalEditRecord;
      if (typeof parsed?.at === 'string' && typeof parsed?.path === 'string' && typeof parsed?.workspace === 'string') records.push(parsed);
    } catch {
      // A half-written line from a killed process: skip it, never fail the read.
    }
  }
  return records.slice(-limit);
}

/** Render the MEMORY.md index: every project, its freshest edits, newest first. */
export function renderGlobalMemoryIndex(records: GlobalEditRecord[], updatedAt: string): string {
  const projects = new Map<string, {
    project: string;
    workspace: string;
    edits: number;
    files: Map<string, { at: string; count: number; created: boolean; lastAction: GlobalEditAction }>;
  }>();
  for (const record of records) {
    const key = workspaceKey(record.workspace);
    let entry = projects.get(key);
    if (!entry) {
      entry = { project: record.project, workspace: record.workspace, edits: 0, files: new Map() };
      projects.set(key, entry);
    }
    entry.edits += 1;
    const file = entry.files.get(record.path);
    if (file) {
      file.count += 1;
      if (record.at >= file.at) {
        file.at = record.at;
        file.lastAction = record.action;
      }
    } else {
      entry.files.set(record.path, { at: record.at, count: 1, created: record.created, lastAction: record.action });
    }
  }
  const ordered = [...projects.values()].sort((a, b) => latestEdit(b).localeCompare(latestEdit(a)));
  const lines = [
    '# 全局记忆',
    '',
    '跨会话、跨项目记录所有被编辑过的文件。由 ZCode 自动维护，不要手工排序。',
    `最近更新：${formatWhen(updatedAt)}${records.length === 0 ? '（还没有任何编辑记录）' : ''}`,
    `共 ${projects.size} 个项目、${records.length} 次编辑${records.length >= LEDGER_KEEP_LINES ? `（只保留最近 ${LEDGER_KEEP_LINES} 次）` : ''}。`,
  ];
  for (const project of ordered.slice(0, INDEX_PROJECT_LIMIT)) {
    lines.push('', `## ${project.project}`, `工作区：\`${project.workspace}\`\u3000共 ${project.edits} 次编辑、${project.files.size} 个文件`);
    const files = [...project.files.entries()].sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, INDEX_FILE_LIMIT);
    for (const [path, info] of files) {
      const marks = [
        formatWhen(info.at),
        info.count > 1 ? `${info.count} 次` : '',
        // A file created and later deleted is not "新建" any more.
        info.created && info.lastAction !== 'delete' ? '新建' : '',
        info.lastAction === 'delete' ? '已删除' : '',
        info.lastAction === 'rename' ? '改名' : '',
      ].filter(Boolean).join(' ');
      lines.push(`- ${path}\u3000—\u3000${marks}`);
    }
  }
  if (ordered.length > INDEX_PROJECT_LIMIT) lines.push('', `（另有 ${ordered.length - INDEX_PROJECT_LIMIT} 个项目未列出）`);
  return `${lines.join('\n')}\n`;
}

/**
 * Compact block for the model's context: what this workspace has been editing
 * (so a new session starts informed) plus the freshest edits elsewhere. Short
 * on purpose — it is injected on every turn.
 */
export async function loadGlobalMemorySummary(options: {
  workspaceRoot: string;
  root?: string;
  limit?: number;
}): Promise<{ markdown: string; records: GlobalEditRecord[] } | undefined> {
  // The whole tail, not a small slice: an active machine edits other projects
  // too, and a fixed window would silently drop this workspace's history —
  // exactly the case where the block is most useful.
  const records = await readGlobalEdits({ root: options.root, limit: LEDGER_KEEP_LINES });
  if (records.length === 0) return undefined;
  const limit = options.limit ?? SUMMARY_FILE_LIMIT;
  const currentKey = workspaceKey(options.workspaceRoot);
  const sameProject = records.filter((record) => workspaceKey(record.workspace) === currentKey);
  const elsewhere = records.filter((record) => workspaceKey(record.workspace) !== currentKey);

  const lines: string[] = [];
  const current = topFiles(sameProject, limit);
  if (current.length > 0) {
    lines.push('This workspace, recently edited (earlier sessions included):');
    for (const file of current) lines.push(`- ${file.path} — ${formatWhen(file.at)}${file.count > 1 ? `, ${file.count} edits` : ''}`);
  }
  const other = latestPerProject(elsewhere).slice(0, 3);
  if (other.length > 0) {
    lines.push('Other projects, most recent edit:');
    for (const file of other) lines.push(`- ${file.project}: ${file.path} — ${formatWhen(file.at)}`);
  }
  return lines.length > 0 ? { markdown: lines.join('\n'), records } : undefined;
}

function topFiles(records: GlobalEditRecord[], limit: number) {
  const files = new Map<string, { at: string; count: number }>();
  for (const record of records) {
    const existing = files.get(record.path);
    if (existing) {
      existing.count += 1;
      if (record.at > existing.at) existing.at = record.at;
    } else {
      files.set(record.path, { at: record.at, count: 1 });
    }
  }
  return [...files.entries()]
    .sort((a, b) => b[1].at.localeCompare(a[1].at))
    .slice(0, limit)
    .map(([path, info]) => ({ path, ...info }));
}

function latestPerProject(records: GlobalEditRecord[]) {
  const byProject = new Map<string, GlobalEditRecord>();
  for (const record of records) {
    const key = workspaceKey(record.workspace);
    const current = byProject.get(key);
    if (!current || record.at > current.at) byProject.set(key, record);
  }
  return [...byProject.values()].sort((a, b) => b.at.localeCompare(a.at));
}

function latestEdit(project: { files: Map<string, { at: string }> }) {
  let latest = '';
  for (const file of project.files.values()) if (file.at > latest) latest = file.at;
  return latest;
}

async function rotateLedger(root: string) {
  const path = globalMemoryLedgerPath(root);
  try {
    const info = await stat(path);
    if (info.size <= LEDGER_ROTATE_BYTES) return;
    const lines = (await readFile(path, 'utf8')).split('\n').filter((line) => line.trim());
    await writeFile(path, `${lines.slice(-LEDGER_KEEP_LINES).join('\n')}\n`, 'utf8');
  } catch {
    // Rotation is an optimisation; a failure here never breaks the edit.
  }
}

function projectName(workspaceRoot: string) {
  return basename(workspaceRoot.replace(/[\\/]+$/, '')) || workspaceRoot;
}

/**
 * Identity of a workspace for grouping. The ledger stores the path verbatim as
 * the CLI was given it, so `D:\proj` and `d:/proj/` are one project; showing
 * two of them would split the history the record exists to keep together.
 */
function workspaceKey(workspaceRoot: string) {
  const trimmed = workspaceRoot.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/** Workspace-relative (forward slashes) when the file is inside the workspace. */
function displayPath(workspaceRoot: string, path: string) {
  const rel = relative(workspaceRoot, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return path.replace(/\\/g, '/');
  return rel.replace(/\\/g, '/');
}

function formatWhen(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
