import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileWatchManager, validateWatchPatterns } from '../src/automation/file-watcher.js';
import type { AutomationTask, FileWatchTrigger } from '../src/automation/types.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function tempWorkspace(name: string) {
  const root = await mkdtemp(join(tmpdir(), `aicode-automation-watch-${name}-`));
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function watchTask(trigger: Partial<FileWatchTrigger> & { patterns: string[]; events: FileWatchTrigger['events'] }): AutomationTask {
  return {
    id: 'watch_task',
    name: 'watch task',
    enabled: true,
    trigger: { type: 'file_watch', debounceMs: 30, ...trigger },
    action: { type: 'task_board', goal: 'g', confirmPlan: true },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** Wait until `check` is true or the deadline passes; resolves to elapsed ms. */
async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<number> {
  const started = Date.now();
  while (!check() && Date.now() - started < timeoutMs) await sleep(20);
  return Date.now() - started;
}

test('patterns that would silently watch nothing are rejected up front', async () => {
  // Probed behaviour: `../**` produced zero events for a file it names.
  assert.match(validateWatchPatterns(['../**/*.ts']) ?? '', /escapes the workspace root/);
  assert.match(validateWatchPatterns(['src/../*.ts']) ?? '', /escapes the workspace root/);
  assert.match(validateWatchPatterns(['C:\\repo\\src\\**\\*.ts']) ?? '', /absolute/);
  assert.match(validateWatchPatterns(['/etc/**/*.conf']) ?? '', /absolute/);
  assert.equal(validateWatchPatterns(['src/**/*.ts', 'docs/**/*.md']), null);

  const root = await mkdtemp(join(tmpdir(), 'aicode-automation-watch-pattern-'));
  try {
    const manager = new FileWatchManager();
    await assert.rejects(
      () =>
        manager.start(watchTask({ patterns: ['../**/*.ts'], events: ['modify'] }), {
          workspaceRoot: root,
          runtime: {} as never,
          executor: { run: async () => ({ status: 'success', executedAt: '' }) } as never,
          store: { save: async () => {}, recordExecution: async () => {} } as never,
          onTrigger: () => {},
        }),
      /escapes the workspace root/,
    );
    assert.deepEqual(manager.getActiveWatchers(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an event that lands during a run is coalesced into one trailing run', async () => {
  const ws = await tempWorkspace('trailing');
  try {
    await mkdir(join(ws.root, 'src'), { recursive: true });
    const triggers: string[] = [];
    let release!: () => void;
    const firstRunGate = new Promise<void>((resolve) => { release = resolve; });
    let execs = 0;
    const manager = new FileWatchManager();
    await manager.start(watchTask({ patterns: ['src/*.txt'], events: ['create'], debounceMs: 30 }), {
      workspaceRoot: ws.root,
      runtime: {} as never,
      executor: {
        run: async () => {
          execs += 1;
          if (execs === 1) await firstRunGate; // hold the first run open
          return { status: 'success', executedAt: new Date().toISOString() };
        },
      } as never,
      store: { save: async () => {}, recordExecution: async () => {} } as never,
      onTrigger: (_taskId, event, filePath) => triggers.push(`${event}:${filePath}`),
    });
    // chokidar needs a beat before it reports the first event.
    await sleep(700);
    await writeFile(join(ws.root, 'src', 'a.txt'), '1');
    await waitFor(() => triggers.length === 1);
    // Arrives while the first run is blocked. It used to be dropped outright.
    await writeFile(join(ws.root, 'src', 'b.txt'), '2');
    await sleep(300);
    release();
    await waitFor(() => triggers.length >= 2);
    await sleep(200);
    const snapshot = [...triggers];
    await manager.stop('watch_task');
    assert.equal(execs, 2, `expected the queued event to run once, saw ${execs}`);
    assert.ok(snapshot.some((entry) => entry.includes('b.txt')), `trailing event was not run: ${JSON.stringify(snapshot)}`);
  } finally {
    await ws.cleanup();
  }
});

test('a storm of events runs at most twice (one active + one trailing)', async () => {
  const ws = await tempWorkspace('storm');
  try {
    await mkdir(join(ws.root, 'src'), { recursive: true });
    let execs = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const manager = new FileWatchManager();
    await manager.start(watchTask({ patterns: ['src/*.txt'], events: ['create'], debounceMs: 20 }), {
      workspaceRoot: ws.root,
      runtime: {} as never,
      executor: {
        run: async () => {
          execs += 1;
          await gate;
          return { status: 'success', executedAt: new Date().toISOString() };
        },
      } as never,
      store: { save: async () => {}, recordExecution: async () => {} } as never,
      onTrigger: () => {},
    });
    await sleep(700);
    await Promise.all(Array.from({ length: 40 }, (_, index) => writeFile(join(ws.root, 'src', `f${index}.txt`), String(index))));
    await waitFor(() => execs >= 1);
    await sleep(300);
    release();
    // No further gate: give the trailing run time to finish a couple of rounds.
    await sleep(600);
    const observed = execs;
    await manager.stop('watch_task');
    assert.ok(observed <= 2, `event storm caused ${observed} runs; the coalesced slot must bound it at 2`);
  } finally {
    await ws.cleanup();
  }
});

test('stop() cancels a pending trailing run', async () => {
  const ws = await tempWorkspace('stop-trailing');
  try {
    await mkdir(join(ws.root, 'src'), { recursive: true });
    let execs = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const manager = new FileWatchManager();
    await manager.start(watchTask({ patterns: ['src/*.txt'], events: ['create'], debounceMs: 30 }), {
      workspaceRoot: ws.root,
      runtime: {} as never,
      executor: {
        run: async () => {
          execs += 1;
          await gate;
          return { status: 'success', executedAt: new Date().toISOString() };
        },
      } as never,
      store: { save: async () => {}, recordExecution: async () => {} } as never,
      onTrigger: () => {},
    });
    await sleep(700);
    await writeFile(join(ws.root, 'src', 'a.txt'), '1');
    await waitFor(() => execs === 1);
    await writeFile(join(ws.root, 'src', 'b.txt'), '2');
    await sleep(200);
    const stop = manager.stop('watch_task');
    release();
    await stop;
    await sleep(600);
    assert.equal(execs, 1, 'a stopped watcher must not run the queued event');
  } finally {
    await ws.cleanup();
  }
});

test('CJK and space-containing paths trigger exactly once', async () => {
  const ws = await tempWorkspace('unicode');
  try {
    await mkdir(join(ws.root, '源码 目录'), { recursive: true });
    const triggers: string[] = [];
    const manager = new FileWatchManager();
    await manager.start(watchTask({ patterns: ['源码 目录/**/*.ts'], events: ['create'], debounceMs: 30 }), {
      workspaceRoot: ws.root,
      runtime: {} as never,
      executor: { run: async () => ({ status: 'success', executedAt: '' }) } as never,
      store: { save: async () => {}, recordExecution: async () => {} } as never,
      onTrigger: (_taskId, event, filePath) => triggers.push(`${event}:${filePath}`),
    });
    await sleep(700);
    await writeFile(join(ws.root, '源码 目录', '中文 文件.ts'), 'x');
    await waitFor(() => triggers.length >= 1);
    await sleep(300);
    const snapshot = [...triggers];
    await manager.stop('watch_task');
    assert.equal(snapshot.length, 1, `expected one trigger, saw ${JSON.stringify(snapshot)}`);
    assert.match(snapshot[0]!, /中文 文件\.ts/);
  } finally {
    await ws.cleanup();
  }
});
