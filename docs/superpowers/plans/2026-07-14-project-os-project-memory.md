# Project OS P2 Project Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable workspace project memory so conventions, decisions, and pitfalls from earlier tasks are stored, manually manageable, and injected into later task-board planning/execution.

**Architecture:** Introduce a pure `cli/src/memory/` package (types/store/extract/select/format/record) with authoritative JSON at `.aicode/memory/entries.json`. Hook task terminal states in `runTaskBoardLoop` for best-effort auto-record; inject selected memories into `buildTaskPrompt`; show memory hints when drafting boards; expose `/memory` slash commands. Memory failures must never block board execution.

**Tech Stack:** TypeScript, Node.js test runner (`node:test`), existing CLI session/task-board architecture.

**Spec:** `docs/superpowers/specs/2026-07-14-project-os-project-memory-design.md`

**Workspace note:** `C:\Users\34516\ZCodeProject` may not be a git repository. For every commit step, run `git rev-parse --is-inside-work-tree` first; if it fails, skip the commit and continue.

---

## File Structure

- Create `cli/src/memory/types.ts`
  - Memory kinds, entry, file envelope types.

- Create `cli/src/memory/store.ts`
  - `ProjectMemoryStore` load/save/list/add/forget under `.aicode/memory/entries.json`.

- Create `cli/src/memory/extract.ts`
  - Pure task-outcome candidate extraction + usefulness/dedup helpers.

- Create `cli/src/memory/select.ts`
  - Pure relevance ranking for goal/task queries.

- Create `cli/src/memory/format.ts`
  - Compact CLI/prompt formatting.

- Create `cli/src/memory/record.ts`
  - Best-effort `maybeRecordTaskMemory` orchestration used by runtime.

- Modify `cli/src/tasks/runtime.ts`
  - `buildTaskPrompt(..., memories?)`
  - In `runTaskBoardLoop`, select memories before turn; record after terminal task status.

- Modify `cli/src/cli/repl.ts`
  - After draft board creation, show relevant memory hints.

- Modify `cli/src/cli/commands.ts`
  - Add `/memory` subcommands and help line.

- Create `cli/tests/project-memory.test.ts`
  - Store/extract/select/runtime/command coverage.

- Modify `cli/src/audit/checks.ts`
  - Register memory files/needles/tests.

- Modify `cli/docs/capability-matrix.md`
  - Mark project memory as Implemented MVP.

- Modify `cli/README.md`
  - Document `/memory` and auto-record behavior briefly.

---

### Task 1: Memory Types and Store

**Files:**
- Create: `cli/src/memory/types.ts`
- Create: `cli/src/memory/store.ts`
- Test: `cli/tests/project-memory.test.ts`

- [ ] **Step 1: Write failing store tests**

Create `cli/tests/project-memory.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectMemoryStore } from '../src/memory/store.js';

test('ProjectMemoryStore adds lists and soft-forgets entries', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-memory-store-'));
  try {
    const store = new ProjectMemoryStore(workspace);
    assert.deepEqual(await store.list(), []);

    const entry = await store.add({
      kind: 'decision',
      summary: 'Prefer npm test for verification',
      keywords: ['npm', 'test', 'verification'],
      source: { type: 'user' },
    });
    assert.ok(entry.id.startsWith('mem_'));
    assert.equal(entry.active, true);

    const listed = await store.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].summary, 'Prefer npm test for verification');

    const forgotten = await store.forget(entry.id);
    assert.equal(forgotten?.active, false);
    assert.deepEqual(await store.list(), []);
    assert.equal((await store.list({ includeInactive: true })).length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('ProjectMemoryStore load missing file returns empty envelope', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-memory-missing-'));
  try {
    const store = new ProjectMemoryStore(workspace);
    const file = await store.load();
    assert.equal(file.version, 1);
    assert.deepEqual(file.entries, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test "C:/Users/34516/ZCodeProject/cli/dist/tests/project-memory.test.js"
```

Expected: FAIL because `../src/memory/store.js` does not exist.

- [ ] **Step 3: Implement types and store**

Create `cli/src/memory/types.ts`:

```ts
export type MemoryKind = 'convention' | 'decision' | 'pitfall' | 'note';

export type MemorySource = {
  type: 'task' | 'user' | 'system';
  boardId?: string;
  taskId?: string;
};

export type ProjectMemoryEntry = {
  id: string;
  kind: MemoryKind;
  summary: string;
  keywords: string[];
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
  active: boolean;
};

export type ProjectMemoryFile = {
  version: 1;
  updatedAt: string;
  entries: ProjectMemoryEntry[];
};

export type NewMemoryInput = {
  kind: MemoryKind;
  summary: string;
  keywords?: string[];
  source: MemorySource;
  nowIso?: string;
};
```

Create `cli/src/memory/store.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { NewMemoryInput, ProjectMemoryEntry, ProjectMemoryFile } from './types.js';

const MAX_SUMMARY = 240;

export class ProjectMemoryStore {
  private readonly filePath: string;

  constructor(workspaceRoot: string) {
    this.filePath = resolve(workspaceRoot, '.aicode', 'memory', 'entries.json');
  }

  async load(): Promise<ProjectMemoryFile> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as ProjectMemoryFile;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
        return emptyFile(new Date().toISOString());
      }
      return parsed;
    } catch {
      return emptyFile(new Date().toISOString());
    }
  }

  async save(file: ProjectMemoryFile) {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  }

  async list(options?: { includeInactive?: boolean }) {
    const file = await this.load();
    const entries = options?.includeInactive ? file.entries : file.entries.filter((entry) => entry.active);
    return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async add(input: NewMemoryInput): Promise<ProjectMemoryEntry> {
    const nowIso = input.nowIso ?? new Date().toISOString();
    const summary = truncateSummary(input.summary);
    if (!summary) throw new Error('Memory summary is required');
    const entry: ProjectMemoryEntry = {
      id: `mem_${nowIso.replace(/[-:.TZ]/g, '').slice(0, 14)}_${randomUUID().slice(0, 8)}`,
      kind: input.kind,
      summary,
      keywords: uniqueKeywords(input.keywords ?? deriveKeywords(summary)),
      source: input.source,
      createdAt: nowIso,
      updatedAt: nowIso,
      active: true,
    };
    const file = await this.load();
    file.entries = [entry, ...file.entries];
    file.updatedAt = nowIso;
    await this.save(file);
    return entry;
  }

  async forget(idOrQuery: string): Promise<ProjectMemoryEntry | undefined> {
    const file = await this.load();
    const needle = idOrQuery.trim().toLowerCase();
    const index = file.entries.findIndex((entry) => {
      if (!entry.active) return false;
      if (entry.id === idOrQuery) return true;
      return entry.summary.toLowerCase().includes(needle) || entry.keywords.some((keyword) => keyword.includes(needle));
    });
    if (index < 0) return undefined;
    const nowIso = new Date().toISOString();
    file.entries[index] = { ...file.entries[index], active: false, updatedAt: nowIso };
    file.updatedAt = nowIso;
    await this.save(file);
    return file.entries[index];
  }
}

export function truncateSummary(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY);
}

export function deriveKeywords(summary: string) {
  return uniqueKeywords(
    summary
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/i)
      .map((part) => part.trim())
      .filter((part) => part.length >= 2),
  );
}

export function uniqueKeywords(values: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = value.toLowerCase().trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= 12) break;
  }
  return out;
}

function emptyFile(nowIso: string): ProjectMemoryFile {
  return { version: 1, updatedAt: nowIso, entries: [] };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test "C:/Users/34516/ZCodeProject/cli/dist/tests/project-memory.test.js"
```

Expected: PASS.

- [ ] **Step 5: Commit if git repo**

```bash
git rev-parse --is-inside-work-tree && git add cli/src/memory/types.ts cli/src/memory/store.ts cli/tests/project-memory.test.ts && git commit -m "feat: add project memory store"
```

If not a git repo, skip.

---

### Task 2: Extract and Select Helpers

**Files:**
- Create: `cli/src/memory/extract.ts`
- Create: `cli/src/memory/select.ts`
- Create: `cli/src/memory/format.ts`
- Test: `cli/tests/project-memory.test.ts`

- [ ] **Step 1: Write failing extract/select/format tests**

Append:

```ts
import { extractMemoryCandidates, isUsefulMemoryText, isDuplicateMemory } from '../src/memory/extract.js';
import { selectRelevantMemories } from '../src/memory/select.js';
import { formatMemories } from '../src/memory/format.js';
import type { ProjectMemoryEntry } from '../src/memory/types.js';

test('extractMemoryCandidates records decisions and pitfalls while skipping noise', () => {
  const done = extractMemoryCandidates({
    boardId: 'board_1',
    taskId: 'task_1',
    status: 'done',
    resultSummary: 'Prefer npm test for verification after code changes',
    existing: [],
  });
  assert.equal(done.length, 1);
  assert.equal(done[0].kind, 'decision');
  assert.match(done[0].summary, /npm test/i);

  const blocked = extractMemoryCandidates({
    boardId: 'board_1',
    taskId: 'task_2',
    status: 'blocked',
    error: 'Do not edit generated dist/ output; path blocked',
    existing: [],
  });
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].kind, 'pitfall');

  const noisy = extractMemoryCandidates({
    boardId: 'board_1',
    taskId: 'task_3',
    status: 'done',
    resultSummary: 'TASK_DONE: ok',
    existing: [],
  });
  assert.equal(noisy.length, 0);
  assert.equal(isUsefulMemoryText('ok'), false);
});

test('extractMemoryCandidates skips duplicates', () => {
  const existing: ProjectMemoryEntry[] = [{
    id: 'mem_1',
    kind: 'decision',
    summary: 'Prefer npm test for verification after code changes',
    keywords: ['npm', 'test'],
    source: { type: 'user' },
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
    active: true,
  }];
  const candidates = extractMemoryCandidates({
    boardId: 'board_1',
    taskId: 'task_1',
    status: 'done',
    resultSummary: 'Prefer npm test for verification after code changes',
    existing,
  });
  assert.equal(candidates.length, 0);
  assert.equal(isDuplicateMemory(existing, 'Prefer npm test for verification after code changes'), true);
});

test('selectRelevantMemories ranks keyword hits and falls back to conventions/decisions', () => {
  const entries: ProjectMemoryEntry[] = [
    {
      id: 'mem_old_note',
      kind: 'note',
      summary: 'Random note about docs',
      keywords: ['docs'],
      source: { type: 'user' },
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      active: true,
    },
    {
      id: 'mem_test',
      kind: 'decision',
      summary: 'Prefer npm test for verification',
      keywords: ['npm', 'test', 'verification'],
      source: { type: 'user' },
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
      active: true,
    },
    {
      id: 'mem_dist',
      kind: 'pitfall',
      summary: 'Do not edit generated dist output',
      keywords: ['dist', 'generated'],
      source: { type: 'task', boardId: 'b', taskId: 't' },
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
      active: true,
    },
  ];

  const selected = selectRelevantMemories({
    entries,
    goal: 'Implement feature and run verification tests',
    taskTitle: 'Add tests',
    limit: 5,
  });
  assert.equal(selected[0].id, 'mem_test');

  const fallback = selectRelevantMemories({
    entries,
    goal: 'Unrelated topic with no keywords',
    limit: 2,
  });
  assert.ok(fallback.every((entry) => entry.kind === 'decision' || entry.kind === 'convention'));
  assert.ok(fallback.some((entry) => entry.id === 'mem_test'));
});

test('formatMemories renders compact bullets', () => {
  const text = formatMemories([
    {
      id: 'mem_1',
      kind: 'decision',
      summary: 'Prefer npm test',
      keywords: ['npm'],
      source: { type: 'user' },
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
      active: true,
    },
  ]);
  assert.match(text, /Project memory:/);
  assert.match(text, /\[decision\] Prefer npm test/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test "C:/Users/34516/ZCodeProject/cli/dist/tests/project-memory.test.js"
```

Expected: FAIL because extract/select/format modules are missing.

- [ ] **Step 3: Implement extract/select/format**

Create `cli/src/memory/extract.ts`:

```ts
import { deriveKeywords, truncateSummary } from './store.js';
import type { MemoryKind, NewMemoryInput, ProjectMemoryEntry } from './types.js';

export function extractMemoryCandidates(input: {
  boardId: string;
  taskId: string;
  status: 'done' | 'blocked';
  resultSummary?: string;
  error?: string;
  existing: ProjectMemoryEntry[];
  nowIso?: string;
}): NewMemoryInput[] {
  const text = input.status === 'done' ? input.resultSummary ?? '' : input.error ?? '';
  const summary = truncateSummary(text.replace(/^TASK_DONE:\s*/i, ''));
  if (!isUsefulMemoryText(summary)) return [];
  if (isDuplicateMemory(input.existing, summary)) return [];

  const kind = input.status === 'blocked' ? 'pitfall' : classifySuccessKind(summary);
  return [{
    kind,
    summary,
    keywords: deriveKeywords(summary),
    source: { type: 'task', boardId: input.boardId, taskId: input.taskId },
    nowIso: input.nowIso,
  }];
}

export function isUsefulMemoryText(value: string) {
  const normalized = value.replace(/\s+/g, ' ').trim().toLowerCase();
  if (normalized.length < 12) return false;
  if (['ok', 'done', 'completed', 'finished', 'task_done: ok', 'task_done: done'].includes(normalized)) return false;
  if (/^(task_done:\s*)?(ok|done|completed|finished)\.?$/.test(normalized)) return false;
  return true;
}

export function isDuplicateMemory(existing: ProjectMemoryEntry[], summary: string) {
  const normalized = normalizeSummary(summary);
  return existing.some((entry) => {
    if (!entry.active) return false;
    const other = normalizeSummary(entry.summary);
    return other === normalized || other.includes(normalized) || normalized.includes(other);
  });
}

function classifySuccessKind(summary: string): MemoryKind {
  const normalized = summary.toLowerCase();
  if (hasAny(normalized, ['约定', 'convention', 'always use', '必须使用'])) return 'convention';
  if (hasAny(normalized, ['use ', 'must', 'never', '不要', '必须', '测试用', 'prefer'])) return 'decision';
  return 'note';
}

function normalizeSummary(value: string) {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function hasAny(value: string, needles: string[]) {
  return needles.some((needle) => value.includes(needle));
}
```

Create `cli/src/memory/select.ts`:

```ts
import type { ProjectMemoryEntry } from './types.js';

const kindWeight: Record<ProjectMemoryEntry['kind'], number> = {
  convention: 3,
  decision: 3,
  pitfall: 2,
  note: 1,
};

export function selectRelevantMemories(input: {
  entries: ProjectMemoryEntry[];
  goal: string;
  taskTitle?: string;
  taskDetail?: string;
  limit?: number;
}): ProjectMemoryEntry[] {
  const limit = input.limit ?? 5;
  const active = input.entries.filter((entry) => entry.active);
  const query = `${input.goal} ${input.taskTitle ?? ''} ${input.taskDetail ?? ''}`.toLowerCase();
  const queryTokens = new Set(
    query
      .split(/[^a-z0-9\u4e00-\u9fff]+/i)
      .map((part) => part.trim())
      .filter((part) => part.length >= 2),
  );

  const scored = active.map((entry) => {
    const keywordHits = entry.keywords.reduce((count, keyword) => count + (queryTokens.has(keyword) || query.includes(keyword) ? 1 : 0), 0);
    const summaryHits = queryTokens.size === 0 ? 0 : [...queryTokens].reduce((count, token) => count + (entry.summary.toLowerCase().includes(token) ? 1 : 0), 0);
    const score = keywordHits * 5 + summaryHits + kindWeight[entry.kind] + recencyBoost(entry.updatedAt);
    return { entry, score, keywordHits: keywordHits + summaryHits };
  });

  const hits = scored.filter((item) => item.keywordHits > 0).sort(compareScore);
  if (hits.length > 0) return hits.slice(0, limit).map((item) => item.entry);

  return scored
    .filter((item) => item.entry.kind === 'convention' || item.entry.kind === 'decision')
    .sort(compareScore)
    .slice(0, Math.min(2, limit))
    .map((item) => item.entry);
}

function recencyBoost(updatedAt: string) {
  const ts = Date.parse(updatedAt);
  if (!Number.isFinite(ts)) return 0;
  const ageDays = Math.max(0, (Date.now() - ts) / 86_400_000);
  return Math.max(0, 2 - ageDays / 30);
}

function compareScore(a: { score: number; entry: ProjectMemoryEntry }, b: { score: number; entry: ProjectMemoryEntry }) {
  if (b.score !== a.score) return b.score - a.score;
  const byDate = b.entry.updatedAt.localeCompare(a.entry.updatedAt);
  if (byDate !== 0) return byDate;
  return b.entry.id.localeCompare(a.entry.id);
}
```

Create `cli/src/memory/format.ts`:

```ts
import type { ProjectMemoryEntry } from './types.js';

export function formatMemories(entries: ProjectMemoryEntry[]) {
  if (entries.length === 0) return 'Project memory: (none)';
  return [
    'Project memory:',
    ...entries.map((entry) => `- [${entry.kind}] ${entry.summary}`),
  ].join('\n');
}

export function formatMemoryList(entries: ProjectMemoryEntry[]) {
  if (entries.length === 0) return 'No active project memory entries.';
  return entries.map((entry) => `${entry.id} [${entry.kind}] ${entry.summary}`).join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test "C:/Users/34516/ZCodeProject/cli/dist/tests/project-memory.test.js"
```

Expected: PASS.

- [ ] **Step 5: Commit if git repo**

```bash
git rev-parse --is-inside-work-tree && git add cli/src/memory/extract.ts cli/src/memory/select.ts cli/src/memory/format.ts cli/tests/project-memory.test.ts && git commit -m "feat: add project memory extract and select"
```

---

### Task 3: Best-Effort Record Helper

**Files:**
- Create: `cli/src/memory/record.ts`
- Test: `cli/tests/project-memory.test.ts`

- [ ] **Step 1: Write failing record test**

Append:

```ts
import { maybeRecordTaskMemory } from '../src/memory/record.js';
import type { TaskItem } from '../src/tasks/types.js';

test('maybeRecordTaskMemory persists useful done and blocked outcomes', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-memory-record-'));
  try {
    const store = new ProjectMemoryStore(workspace);
    const doneTask: TaskItem = {
      id: 'task_1',
      title: 'Add tests',
      status: 'done',
      dependsOn: [],
      resultSummary: 'Prefer npm test for verification after changes',
    };
    const recorded = await maybeRecordTaskMemory({
      store,
      boardId: 'board_1',
      task: doneTask,
    });
    assert.equal(recorded.length, 1);
    assert.equal((await store.list()).length, 1);

    const blockedTask: TaskItem = {
      id: 'task_2',
      title: 'Touch dist',
      status: 'blocked',
      dependsOn: [],
      error: 'Do not edit generated dist/ output',
    };
    const blocked = await maybeRecordTaskMemory({
      store,
      boardId: 'board_1',
      task: blockedTask,
    });
    assert.equal(blocked.length, 1);
    assert.equal((await store.list()).length, 2);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test "C:/Users/34516/ZCodeProject/cli/dist/tests/project-memory.test.js"
```

Expected: FAIL because `record.ts` is missing.

- [ ] **Step 3: Implement record helper**

Create `cli/src/memory/record.ts`:

```ts
import type { TaskItem } from '../tasks/types.js';
import { extractMemoryCandidates } from './extract.js';
import type { ProjectMemoryStore } from './store.js';
import type { ProjectMemoryEntry } from './types.js';

export async function maybeRecordTaskMemory(options: {
  store: ProjectMemoryStore;
  boardId: string;
  task: TaskItem;
  onWarn?: (message: string) => void;
}): Promise<ProjectMemoryEntry[]> {
  if (options.task.status !== 'done' && options.task.status !== 'blocked') return [];
  try {
    const existing = await options.store.list({ includeInactive: true });
    const candidates = extractMemoryCandidates({
      boardId: options.boardId,
      taskId: options.task.id,
      status: options.task.status,
      resultSummary: options.task.resultSummary,
      error: options.task.error,
      existing,
    });
    const created: ProjectMemoryEntry[] = [];
    for (const candidate of candidates) {
      created.push(await options.store.add(candidate));
    }
    return created;
  } catch (error) {
    options.onWarn?.(`Project memory update failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test "C:/Users/34516/ZCodeProject/cli/dist/tests/project-memory.test.js"
```

Expected: PASS.

- [ ] **Step 5: Commit if git repo**

```bash
git rev-parse --is-inside-work-tree && git add cli/src/memory/record.ts cli/tests/project-memory.test.ts && git commit -m "feat: add best-effort task memory recording"
```

---

### Task 4: Runtime Prompt Injection and Auto-Record

**Files:**
- Modify: `cli/src/tasks/runtime.ts`
- Test: `cli/tests/project-memory.test.ts`

- [ ] **Step 1: Write failing runtime integration tests**

Append:

```ts
import { buildTaskPrompt, markTaskDone, runTaskBoardLoop, startTask, confirmBoard } from '../src/tasks/runtime.js';
import { TaskBoardStore } from '../src/tasks/store.js';
import { SessionStore } from '../src/session/store.js';
import type { TaskBoard } from '../src/tasks/types.js';

test('buildTaskPrompt injects project memory block', () => {
  const board: TaskBoard = {
    id: 'board_demo',
    title: 'Demo',
    goal: 'Ship feature',
    status: 'active',
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
    tasks: [{ id: 'task_1', title: 'Implement', status: 'pending', dependsOn: [] }],
  };
  const prompt = buildTaskPrompt(board, board.tasks[0], [
    {
      id: 'mem_1',
      kind: 'decision',
      summary: 'Prefer npm test for verification',
      keywords: ['npm', 'test'],
      source: { type: 'user' },
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
      active: true,
    },
  ]);
  assert.match(prompt, /Project memory:/);
  assert.match(prompt, /Prefer npm test for verification/);
  assert.match(prompt, /Focus only on this task/);
});

test('runTaskBoardLoop records memory and injects it into later task prompts', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-memory-loop-'));
  try {
    const sessions = new SessionStore(join(workspace, 'sessions'));
    const session = await sessions.create({ provider: 'mock', model: 'mock', workspaceRoot: workspace });
    const boardStore = new TaskBoardStore(workspace);
    const memoryStore = new ProjectMemoryStore(workspace);
    await memoryStore.add({
      kind: 'decision',
      summary: 'Prefer npm test for verification',
      keywords: ['npm', 'test', 'verification'],
      source: { type: 'user' },
    });

    const board: TaskBoard = {
      id: 'board_loop',
      title: 'Loop',
      goal: 'Implement feature and verify with tests',
      status: 'draft',
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
      tasks: [
        { id: 'task_1', title: 'Implement core', status: 'pending', dependsOn: [] },
        { id: 'task_2', title: 'Add verification tests', status: 'pending', dependsOn: ['task_1'] },
      ],
    };
    confirmBoard(board, '2026-07-14T00:01:00.000Z');
    await boardStore.save(board);
    session.taskRuntime = { boardId: board.id, mode: 'executing', lastSyncAt: board.updatedAt };
    await sessions.save(session);

    const seenPrompts: string[] = [];
    const result = await runTaskBoardLoop({
      board,
      store: boardStore,
      sessions,
      session,
      runTurn: async (prompt) => {
        seenPrompts.push(prompt);
        return {
          ok: true,
          finalAnswer: seenPrompts.length === 1
            ? 'TASK_DONE: Prefer npm test for verification after core changes'
            : 'TASK_DONE: verification covered with npm test',
        };
      },
    });

    assert.equal(result.ok, true);
    assert.ok(seenPrompts[0]?.includes('Prefer npm test for verification'));
    assert.ok((await memoryStore.list()).length >= 1);
    assert.ok(seenPrompts.length >= 2);
    assert.ok(seenPrompts[1]?.includes('Project memory:'));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test "C:/Users/34516/ZCodeProject/cli/dist/tests/project-memory.test.js"
```

Expected: FAIL on `buildTaskPrompt` arity/memory injection and missing auto-record behavior.

- [ ] **Step 3: Wire runtime**

In `cli/src/tasks/runtime.ts`:

1. Add imports:

```ts
import { formatMemories } from '../memory/format.js';
import { maybeRecordTaskMemory } from '../memory/record.js';
import { selectRelevantMemories } from '../memory/select.js';
import { ProjectMemoryStore } from '../memory/store.js';
import type { ProjectMemoryEntry } from '../memory/types.js';
```

2. Replace `buildTaskPrompt` with:

```ts
export function buildTaskPrompt(board: TaskBoard, task: TaskItem, memories: ProjectMemoryEntry[] = []) {
  const completed = board.tasks
    .filter((item) => item.status === 'done' || item.status === 'skipped')
    .map((item) => `- ${item.id} ${item.title}: ${item.resultSummary ?? item.status}`)
    .join('\n');

  return [
    `You are executing one task from an approved project board.`,
    `Board goal: ${board.goal}`,
    `Current task: ${task.id} ${task.title}`,
    task.detail ? `Detail: ${task.detail}` : undefined,
    task.acceptance ? `Acceptance: ${task.acceptance}` : undefined,
    completed ? `Completed tasks:\n${completed}` : 'Completed tasks: none',
    memories.length > 0 ? formatMemories(memories) : undefined,
    `Focus only on this task.`,
    `When finished successfully, end with: TASK_DONE: <short summary>`,
    `If blocked, explain the blocker clearly.`,
  ].filter((line): line is string => typeof line === 'string').join('\n');
}
```

3. In `runTaskBoardLoop`, before `runTurn`, load/select memories from the session workspace (never from `TaskBoardStore`):

```ts
    const memoryStore = new ProjectMemoryStore(options.session.workspaceRoot);
    let memories: ProjectMemoryEntry[] = [];
    try {
      memories = selectRelevantMemories({
        entries: await memoryStore.list({ includeInactive: true }),
        goal: options.board.goal,
        taskTitle: task.title,
        taskDetail: task.detail,
      });
    } catch (error) {
      options.onInfo?.(`Project memory load failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    options.onInfo?.(`Running ${task.id}: ${task.title}`);
    const turn = await options.runTurn(buildTaskPrompt(options.board, task, memories));
```

4. Replace the post-completion branch with best-effort record after board save:

```ts
    if (completion.status === 'done') {
      markTaskDone(options.board, task.id, completion.summary, doneAt);
      await options.store.save(options.board);
      await maybeRecordTaskMemory({
        store: memoryStore,
        boardId: options.board.id,
        task: options.board.tasks.find((item) => item.id === task.id)!,
        onWarn: options.onInfo,
      });
      await options.sessions.save(options.session);
      executed += 1;
      continue;
    }

    markTaskBlocked(options.board, task.id, completion.error, doneAt);
    options.session.taskRuntime = {
      boardId: options.board.id,
      activeTaskId: task.id,
      mode: 'paused',
      lastSyncAt: doneAt,
    };
    await options.store.save(options.board);
    await maybeRecordTaskMemory({
      store: memoryStore,
      boardId: options.board.id,
      task: options.board.tasks.find((item) => item.id === task.id)!,
      onWarn: options.onInfo,
    });
    await options.sessions.save(options.session);
    options.onInfo?.(`Blocked on ${task.id}: ${completion.error}`);
    return { ok: false, status: 'blocked' as const, reason: completion.error };
```

Remove the old trailing save/executed block that no longer applies.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test "C:/Users/34516/ZCodeProject/cli/dist/tests/project-memory.test.js" "C:/Users/34516/ZCodeProject/cli/dist/tests/task-board.test.js"
```

Expected: PASS for both suites.

- [ ] **Step 5: Commit if git repo**

```bash
git rev-parse --is-inside-work-tree && git add cli/src/tasks/runtime.ts cli/tests/project-memory.test.ts && git commit -m "feat: inject and record project memory in task loop"
```

---

### Task 5: Board-Create Memory Hints in REPL

**Files:**
- Modify: `cli/src/cli/repl.ts`
- Test: `cli/tests/project-memory.test.ts`

- [ ] **Step 1: Write failing board-create hint test**

Append:

```ts
import { runPromptMode } from '../src/cli/repl.js';
import type { AgentRuntime } from '../src/agent/agent.js';
import { TerminalUI } from '../src/ui/terminal.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';

test('draft board creation shows relevant project memory hints', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-memory-hint-'));
  try {
    const sessionDir = join(workspace, 'sessions');
    const sessions = new SessionStore(sessionDir);
    const session = await sessions.create({ provider: 'mock', model: 'mock', workspaceRoot: workspace });
    const memoryStore = new ProjectMemoryStore(workspace);
    await memoryStore.add({
      kind: 'decision',
      summary: 'Prefer npm test for verification',
      keywords: ['npm', 'test', 'verification', '任务板'],
      source: { type: 'user' },
    });

    const infos: string[] = [];
    const ui = new TerminalUI(true);
    const originalInfo = ui.info.bind(ui);
    ui.info = (message: string) => {
      infos.push(message);
      originalInfo(message);
    };

    const runtime: AgentRuntime = {
      config: {
        provider: 'mock',
        model: 'mock',
        approval: 'auto',
        workspaceRoot: workspace,
        sessionDir,
        maxSteps: 4,
        noBanner: true,
        confirmPlan: false,
      },
      provider: {
        name: 'mock',
        model: 'mock',
        async complete() {
          return { actions: [{ type: 'message', content: 'unused' }] };
        },
      },
      tools: createDefaultToolRegistry(),
      sessions,
      session,
      ui,
    };

    const result = await runPromptMode(runtime, '分步实现项目任务板：规划、确认、自动执行、失败恢复');
    assert.equal(result.ok, true);
    assert.ok(infos.some((line) => /Project memory:|Prefer npm test/i.test(line)));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test "C:/Users/34516/ZCodeProject/cli/dist/tests/project-memory.test.js"
```

Expected: FAIL because board creation does not print memory hints.

- [ ] **Step 3: Implement hint display**

In `cli/src/cli/repl.ts` add imports:

```ts
import { formatMemories } from '../memory/format.js';
import { selectRelevantMemories } from '../memory/select.js';
import { ProjectMemoryStore } from '../memory/store.js';
```

In `handleDevelopmentPrompt`, after `runtime.ui.info(formatBoard(board));` add:

```ts
  try {
    const memoryStore = new ProjectMemoryStore(runtime.config.workspaceRoot);
    const memories = selectRelevantMemories({
      entries: await memoryStore.list({ includeInactive: true }),
      goal: board.goal,
      limit: 5,
    });
    if (memories.length > 0) runtime.ui.info(formatMemories(memories));
  } catch (error) {
    runtime.ui.info(`Project memory load failed: ${error instanceof Error ? error.message : String(error)}`);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test "C:/Users/34516/ZCodeProject/cli/dist/tests/project-memory.test.js"
```

Expected: PASS.

- [ ] **Step 5: Commit if git repo**

```bash
git rev-parse --is-inside-work-tree && git add cli/src/cli/repl.ts cli/tests/project-memory.test.ts && git commit -m "feat: show project memory hints on board draft"
```

---

### Task 6: `/memory` Slash Commands

**Files:**
- Modify: `cli/src/cli/commands.ts`
- Test: `cli/tests/project-memory.test.ts`

- [ ] **Step 1: Write failing command tests**

Append:

```ts
import { handleSlashCommand } from '../src/cli/commands.js';
import { createMockProvider } from '../src/providers/mock.js';

test('/memory supports add list and forget', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-memory-cmd-'));
  try {
    const sessions = new SessionStore(join(workspace, 'sessions'));
    const session = await sessions.create({ provider: 'mock', model: 'mock', workspaceRoot: workspace });
    const base = {
      config: {
        provider: 'mock' as const,
        model: 'mock',
        approval: 'auto' as const,
        workspaceRoot: workspace,
        sessionDir: join(workspace, 'sessions'),
        maxSteps: 4,
        noBanner: true,
      },
      provider: createMockProvider(),
      tools: createDefaultToolRegistry(),
      sessions,
      session,
    };

    const empty = await handleSlashCommand({ line: '/memory', ...base });
    assert.match(empty, /No active project memory/i);

    const added = await handleSlashCommand({ line: '/memory add decision Prefer npm test for verification', ...base });
    assert.match(added, /mem_/);
    assert.match(added, /Prefer npm test/);

    const listed = await handleSlashCommand({ line: '/memory list', ...base });
    assert.match(listed, /\[decision\] Prefer npm test/);

    const id = (await new ProjectMemoryStore(workspace).list())[0].id;
    const forgotten = await handleSlashCommand({ line: `/memory forget ${id}`, ...base });
    assert.match(forgotten, /forgot|deactivated|inactive/i);
    assert.deepEqual(await new ProjectMemoryStore(workspace).list(), []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test "C:/Users/34516/ZCodeProject/cli/dist/tests/project-memory.test.js"
```

Expected: FAIL because `/memory` is unknown.

- [ ] **Step 3: Implement `/memory` commands**

In `cli/src/cli/commands.ts`:

1. Imports:

```ts
import { formatMemoryList } from '../memory/format.js';
import { ProjectMemoryStore } from '../memory/store.js';
import type { MemoryKind } from '../memory/types.js';
```

2. Before switch, add:

```ts
  if (command === '/memory' || command.startsWith('/memory ')) {
    return handleMemoryCommand(command, options);
  }
```

3. Help line:

```ts
        '/memory     Show project memory (use /memory add|list|forget)',
```

4. Implement:

```ts
async function handleMemoryCommand(
  command: string,
  options: {
    config: AppConfig;
  },
) {
  const store = new ProjectMemoryStore(options.config.workspaceRoot);
  const args = command.slice('/memory'.length).trim();
  const [action, ...rest] = args.split(/\s+/).filter(Boolean);

  if (!action || action === 'list') {
    return formatMemoryList(await store.list());
  }

  if (action === 'add') {
    const kind = rest[0] as MemoryKind | undefined;
    const summary = rest.slice(1).join(' ').trim();
    if (!kind || !['convention', 'decision', 'pitfall', 'note'].includes(kind) || !summary) {
      return 'Usage: /memory add <convention|decision|pitfall|note> <text>';
    }
    const entry = await store.add({ kind, summary, source: { type: 'user' } });
    return `Added ${entry.id} [${entry.kind}] ${entry.summary}`;
  }

  if (action === 'forget') {
    const target = rest.join(' ').trim();
    if (!target) return 'Usage: /memory forget <id|query>';
    const entry = await store.forget(target);
    if (!entry) return `No active memory matched: ${target}`;
    return `Forgot ${entry.id} [${entry.kind}] ${entry.summary}`;
  }

  return 'Unknown /memory action. Try /memory, /memory list, /memory add <kind> <text>, /memory forget <id|query>.';
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test "C:/Users/34516/ZCodeProject/cli/dist/tests/project-memory.test.js"
```

Expected: PASS.

- [ ] **Step 5: Commit if git repo**

```bash
git rev-parse --is-inside-work-tree && git add cli/src/cli/commands.ts cli/tests/project-memory.test.ts && git commit -m "feat: add /memory project memory commands"
```

---

### Task 7: Audit, Docs, Full Verification

**Files:**
- Modify: `cli/src/audit/checks.ts`
- Modify: `cli/docs/capability-matrix.md`
- Modify: `cli/README.md`

- [ ] **Step 1: Register audit files and needles**

In `cli/src/audit/checks.ts` `requiredFiles`, add near tasks entries:

```ts
    'src/memory/types.ts',
    'src/memory/store.ts',
    'src/memory/extract.ts',
    'src/memory/select.ts',
    'src/memory/format.ts',
    'src/memory/record.ts',
    'tests/project-memory.test.ts',
```

Add needles near task-board needles:

```ts
  const projectMemoryFileNeedles: Array<[string, string]> = [
    ['src/memory/store.ts', 'ProjectMemoryStore'],
    ['src/memory/extract.ts', 'extractMemoryCandidates'],
    ['src/memory/select.ts', 'selectRelevantMemories'],
    ['src/memory/record.ts', 'maybeRecordTaskMemory'],
    ['src/tasks/runtime.ts', 'maybeRecordTaskMemory'],
    ['src/cli/commands.ts', '/memory add'],
    ['src/cli/repl.ts', 'formatMemories'],
  ];
  projectMemoryFileNeedles.forEach(([path, needle]) => checks.push({ name: `project memory ${path} contains ${needle}`, run: () => contains(path, needle) }));

  const projectMemoryTestNeedles = [
    'ProjectMemoryStore adds lists and soft-forgets entries',
    'extractMemoryCandidates records decisions and pitfalls',
    'runTaskBoardLoop records memory and injects it into later task prompts',
    '/memory supports add list and forget',
  ];
  projectMemoryTestNeedles.forEach((needle) => checks.push({ name: `project memory test contains ${needle}`, run: () => contains('tests/project-memory.test.ts', needle) }));
```

Update matrix needle list to include:

```ts
'Project memory'
```

Update README needles to include:

```ts
'Project memory'
```

(Exact heading added in Step 3.)

- [ ] **Step 2: Update capability matrix**

In `cli/docs/capability-matrix.md` add after task board row:

```md
| Project memory | Implemented MVP | Durable `.aicode/memory` entries, auto-record from tasks, `/memory` controls, task-prompt injection |
```

- [ ] **Step 3: README usage note**

In `cli/README.md` slash commands list add:

```md
- `/memory` - list project memory
- `/memory add <convention|decision|pitfall|note> <text>` - add memory
- `/memory forget <id|query>` - soft-delete memory
```

After Task boards section add:

```md
## Project memory

Task outcomes can store short conventions/decisions/pitfalls under `.aicode/memory/entries.json`.
Relevant entries are injected into later task-board execution prompts.

```bash
# interactive
/memory add decision Prefer npm test for verification
/memory list
/memory forget Prefer npm test
```
```

- [ ] **Step 4: Full verification**

```bash
cd "C:/Users/34516/ZCodeProject/cli"
npm run typecheck
npm test
npm run audit:100
```

Optional smoke:

```bash
node dist/src/index.js --provider mock --approval auto --no-color --prompt "/memory add decision Prefer npm test for verification"
```

Expected:

- typecheck pass
- all tests pass (includes new project-memory tests)
- audit all checks passed

- [ ] **Step 5: Commit if git repo**

```bash
git rev-parse --is-inside-work-tree && git add cli/src/audit/checks.ts cli/docs/capability-matrix.md cli/README.md cli/tests/project-memory.test.ts && git commit -m "docs: register project memory coverage"
```

---

## Spec Coverage Checklist

| Spec requirement | Task |
| --- | --- |
| Workspace `.aicode/memory/entries.json` store | Task 1 |
| Entry kinds + soft forget | Task 1, Task 6 |
| Auto extract from done/blocked | Task 2, Task 3, Task 4 |
| Usefulness + dedup filters | Task 2 |
| Relevant selection + fallback | Task 2 |
| Inject into task execution prompt | Task 4 |
| Board-create memory hints | Task 5 |
| `/memory` add/list/forget | Task 6 |
| Memory failures do not block board | Task 3, Task 4 |
| Small one-shot path unchanged | Task 4/5 (no injection there) |
| Tests + audit + docs | Task 7 |

## Placeholder / Consistency Notes

- `buildTaskPrompt(board, task, memories = [])` remains backward compatible for existing callers.
- Memory store path is always `resolve(workspaceRoot, '.aicode/memory/entries.json')`.
- Runtime constructs `ProjectMemoryStore` from `options.session.workspaceRoot`, not from task board store internals.
- Auto-extract never requires network/model calls.
- Commit steps are optional when the workspace is not a git repository.
