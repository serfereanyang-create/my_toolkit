import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRuntime } from '../src/agent/agent.js';
import { handleSlashCommand } from '../src/cli/commands.js';
import { runPromptMode } from '../src/cli/repl.js';
import { extractMemoryCandidates, isDuplicateMemory, isUsefulMemoryText } from '../src/memory/extract.js';
import { formatMemories } from '../src/memory/format.js';
import { maybeRecordTaskMemory } from '../src/memory/record.js';
import { selectRelevantMemories } from '../src/memory/select.js';
import { ProjectMemoryStore } from '../src/memory/store.js';
import type { ProjectMemoryEntry } from '../src/memory/types.js';
import { createMockProvider } from '../src/providers/mock.js';
import { SessionStore } from '../src/session/store.js';
import { buildTaskPrompt, confirmBoard, runTaskBoardLoop } from '../src/tasks/runtime.js';
import { TaskBoardStore } from '../src/tasks/store.js';
import type { TaskBoard, TaskItem } from '../src/tasks/types.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { TerminalUI } from '../src/ui/terminal.js';

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
    assert.match(forgotten, /Forgot|forgot|deactivated|inactive/i);
    assert.deepEqual(await new ProjectMemoryStore(workspace).list(), []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('concurrent adds keep every entry', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-memory-race-'));
  try {
    // Two sessions in one workspace (and one session's Promise.all batch) each
    // load, edit and rewrite the whole file. Interleaved, the last write wins
    // and every earlier entry is gone.
    const store = new ProjectMemoryStore(workspace);
    const count = 25;
    await Promise.all(
      Array.from({ length: count }, (_, i) =>
        new ProjectMemoryStore(workspace).add({
          kind: 'note',
          summary: `fact number ${i}`,
          keywords: [`fact${i}`],
          source: { type: 'system' },
        }),
      ),
    );
    const listed = await store.list();
    assert.equal(listed.length, count, 'no add is lost');
    assert.equal(new Set(listed.map((entry) => entry.summary)).size, count);
    assert.equal((await readdir(join(workspace, '.aicode', 'memory'))).filter((name) => name.endsWith('.tmp')).length, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('an unreadable entries.json is preserved instead of being overwritten', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-memory-corrupt-'));
  try {
    const dir = join(workspace, '.aicode', 'memory');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'entries.json');
    await writeFile(file, '{"version":1,"entries":[{"id":"mem_1"', 'utf8');

    const store = new ProjectMemoryStore(workspace);
    assert.deepEqual(await store.load().then((loaded) => loaded.entries), []);
    assert.equal(await readFile(file, 'utf8').then(() => true).catch(() => false), false, 'the torn file is moved aside');

    const kept = (await readdir(dir)).filter((name) => name.includes('.corrupt-'));
    assert.equal(kept.length, 1, 'the old contents are still on disk to recover from');
    assert.match(await readFile(join(dir, kept[0]), 'utf8'), /mem_1/);

    // Memory keeps working from an empty file rather than failing.
    await store.add({ kind: 'note', summary: 'after the corruption', source: { type: 'user' } });
    assert.equal((await store.list()).length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
