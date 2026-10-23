import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  globalMemoryIndexPath,
  globalMemoryLedgerPath,
  isScratchWorkspace,
  loadGlobalMemorySummary,
  readGlobalEdits,
  recordGlobalEdit,
  renderGlobalMemoryIndex,
} from '../src/memory/global.js';
import { runAgentTurn } from '../src/agent/agent.js';
import type { AppConfig } from '../src/config/types.js';
import { ProjectMemoryStore } from '../src/memory/store.js';
import type { Provider, ProviderRequest } from '../src/providers/types.js';
import { CheckpointStore } from '../src/session/checkpoint.js';
import { SessionStore } from '../src/session/store.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { TerminalUI } from '../src/ui/terminal.js';

async function scratch() {
  const base = await mkdtemp(join(tmpdir(), 'aicode-global-'));
  const memory = join(base, 'memory-root');
  const workspace = join(base, 'work');
  await mkdir(workspace, { recursive: true });
  return { base, memory, workspace };
}

test('an edit lands in the ledger and in MEMORY.md', async () => {
  const { base, memory, workspace } = await scratch();
  try {
    const file = join(workspace, 'src', 'app.ts');
    await recordGlobalEdit(
      { workspaceRoot: workspace, action: 'write', path: file, created: true, now: new Date('2026-10-22T10:00:00Z') },
      { root: memory },
    );

    const ledger = await readFile(globalMemoryLedgerPath(memory), 'utf8');
    assert.equal(ledger.trim().split('\n').length, 1);
    const parsed = JSON.parse(ledger.trim());
    assert.equal(parsed.action, 'write');
    assert.equal(parsed.path, 'src/app.ts', 'paths inside the workspace are stored relative');
    assert.equal(parsed.created, true);

    const index = await readFile(globalMemoryIndexPath(memory), 'utf8');
    assert.match(index, /^# 全局记忆/);
    assert.match(index, /## work/);
    assert.match(index, /- src\/app\.ts/);
    assert.match(index, /新建/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('MEMORY.md counts repeated edits of one file and orders projects by freshness', async () => {
  const { base, memory, workspace } = await scratch();
  try {
    const other = join(base, 'other');
    await mkdir(other, { recursive: true });
    // indexThrottleMs 0: assert the file as it is after every edit, not as the
    // trailing render leaves it later.
    await recordGlobalEdit({ workspaceRoot: workspace, action: 'write', path: join(workspace, 'a.ts'), now: new Date('2026-10-22T09:00:00Z') }, { root: memory, indexThrottleMs: 0 });
    await recordGlobalEdit({ workspaceRoot: workspace, action: 'write', path: join(workspace, 'a.ts'), now: new Date('2026-10-22T09:05:00Z') }, { root: memory, indexThrottleMs: 0 });
    await recordGlobalEdit({ workspaceRoot: other, action: 'write', path: join(other, 'b.ts'), now: new Date('2026-10-22T11:00:00Z') }, { root: memory, indexThrottleMs: 0 });

    const index = await readFile(globalMemoryIndexPath(memory), 'utf8');
    assert.match(index, /- a\.ts\u3000—\u3000[^\n]*2 次/);
    assert.ok(index.indexOf('## other') < index.indexOf('## work'), 'the freshly edited project comes first');
    assert.match(index, /共 2 个项目、3 次编辑/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a corrupt ledger line is skipped instead of failing the read', async () => {
  const { base, memory } = await scratch();
  try {
    await mkdir(memory, { recursive: true });
    await writeFile(
      globalMemoryLedgerPath(memory),
      ['{"at":"2026-10-22T09:00:00Z","project":"work","workspace":"/w","action":"write","path":"a.ts","created":false}', '{"at":"broken"', 'not json at all'].join('\n'),
      'utf8',
    );
    const records = await readGlobalEdits({ root: memory });
    assert.equal(records.length, 1);
    assert.equal(records[0]?.path, 'a.ts');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('the summary separates this workspace from the rest and stays short', async () => {
  const { base, memory, workspace } = await scratch();
  try {
    const other = join(base, 'elsewhere');
    await mkdir(other, { recursive: true });
    for (let i = 0; i < 5; i += 1) {
      await recordGlobalEdit(
        { workspaceRoot: workspace, action: 'write', path: join(workspace, `file-${i}.ts`), now: new Date(Date.UTC(2026, 9, 22, 9, i)) },
        { root: memory },
      );
    }
    await recordGlobalEdit({ workspaceRoot: other, action: 'write', path: join(other, 'remote.ts'), now: new Date('2026-10-22T12:00:00Z') }, { root: memory });

    const summary = await loadGlobalMemorySummary({ workspaceRoot: workspace, root: memory, limit: 3 });
    assert.ok(summary);
    const lines = summary.markdown.split('\n');
    assert.equal(lines[0], 'This workspace, recently edited (earlier sessions included):');
    assert.equal(lines.filter((line) => line.startsWith('- file-')).length, 3, 'limit caps the workspace file list');
    assert.match(summary.markdown, /Other projects, most recent edit:/);
    assert.match(summary.markdown, /elsewhere: remote\.ts/);
    assert.ok(lines.length < 12, 'the injected block stays small');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a busy ledger still shows this workspace its own history', async () => {
  const { base, memory, workspace } = await scratch();
  try {
    // 600 edits elsewhere, this workspace's only edit is the oldest one. A
    // fixed read window would drop it and tell a new session nothing.
    const lines: string[] = [];
    lines.push(JSON.stringify({
      at: '2026-10-22T08:00:00.000Z',
      project: 'work',
      workspace,
      action: 'write',
      path: 'mine.ts',
      created: false,
    }));
    for (let i = 0; i < 600; i += 1) {
      lines.push(JSON.stringify({
        at: new Date(Date.UTC(2026, 9, 22, 9, i % 60, i % 60)).toISOString(),
        project: 'other',
        workspace: join(base, 'other'),
        action: 'write',
        path: `other-${i}.ts`,
        created: false,
      }));
    }
    await mkdir(memory, { recursive: true });
    await writeFile(globalMemoryLedgerPath(memory), `${lines.join('\n')}\n`, 'utf8');

    const summary = await loadGlobalMemorySummary({ workspaceRoot: workspace, root: memory });
    assert.ok(summary);
    assert.match(summary.markdown, /^This workspace, recently edited/);
    assert.match(summary.markdown, /- mine\.ts/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('two spellings of one workspace are one project in MEMORY.md', async () => {
  const { base, workspace } = await scratch();
  try {
    const record = (path: string, at: string) => ({
      at,
      project: 'work',
      workspace,
      action: 'write' as const,
      path,
      created: false,
    });
    const index = renderGlobalMemoryIndex(
      [record('a.ts', '2026-10-22T09:00:00.000Z'), { ...record('b.ts', '2026-10-22T10:00:00.000Z'), workspace: `${workspace}/` }],
      '2026-10-22T10:00:00.000Z',
    );
    assert.equal(index.match(/^## /gm)?.length, 1, 'one heading, not one per spelling');
    assert.match(index, /共 2 次编辑、2 个文件/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('an empty ledger produces no block at all', async () => {
  const { base, memory, workspace } = await scratch();
  try {
    assert.equal(await loadGlobalMemorySummary({ workspaceRoot: workspace, root: memory }), undefined);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('temp workspaces are recognised as scratch, real ones are not', () => {
  assert.equal(isScratchWorkspace(join(tmpdir(), 'aicode-something')), true);
  const real = process.platform === 'win32' ? 'C:\\Users\\someone\\project' : '/home/someone/project';
  assert.equal(isScratchWorkspace(real), false);
});

test('renderGlobalMemoryIndex is stable without records', () => {
  const index = renderGlobalMemoryIndex([], '2026-10-22T10:00:00Z');
  assert.match(index, /# 全局记忆/);
  assert.match(index, /还没有任何编辑记录/);
});

test('a confirmed write reaches the ledger, and a rename records its source', async () => {
  const { base, memory, workspace } = await scratch();
  try {
    const store = new CheckpointStore(workspace, { globalMemoryRoot: memory, globalMemoryIndexThrottleMs: 0 });
    const target = join(workspace, 'notes.md');
    const created = await store.beforeWrite(target);
    await writeFile(target, 'hello\n');
    await store.confirm(created);
    const overwrite = await store.beforeWrite(target);
    await store.confirm(overwrite);
    const moved = await store.beforeRename(target, join(workspace, 'renamed.md'));
    await store.confirm(moved);

    const records = await readGlobalEdits({ root: memory });
    assert.equal(records.length, 3);
    assert.equal(records[0]?.path, 'notes.md');
    assert.equal(records[0]?.created, true, 'the first write created the file');
    assert.equal(records[1]?.created, false, 'the second write overwrote it');
    assert.equal(records[2]?.action, 'rename');
    assert.equal(records[2]?.path, 'renamed.md');
    assert.equal(records[2]?.from, 'notes.md');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('an unconfirmed checkpoint leaves no edit record', async () => {
  const { base, memory, workspace } = await scratch();
  try {
    const store = new CheckpointStore(workspace, { globalMemoryRoot: memory, globalMemoryIndexThrottleMs: 0 });
    await store.beforeWrite(join(workspace, 'attempt.md'));
    assert.deepEqual(await readGlobalEdits({ root: memory }), [], 'checkpointing alone is not an edit');
    assert.equal((await store.list()).length, 1, 'the checkpoint itself is still there for undo');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a write that fails is not remembered as an edit', async () => {
  const { base, memory, workspace } = await scratch();
  try {
    // `blocker` is a file, so writing below it fails after the checkpoint was taken.
    await writeFile(join(workspace, 'blocker'), 'not a directory\n');
    const store = new CheckpointStore(workspace, { globalMemoryRoot: memory, globalMemoryIndexThrottleMs: 0 });
    const registry = createDefaultToolRegistry();
    const result = await registry.execute(
      'write_file',
      { path: 'blocker/inside.md', content: 'never lands\n' },
      { workspaceRoot: workspace, approval: 'auto', checkpoints: store },
    );
    assert.equal(result.ok, false, 'the write really failed');
    assert.deepEqual(await readGlobalEdits({ root: memory }), [], 'a failed write must not claim the file was edited');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a deletion is recorded as a deletion, not as an edit', async () => {
  const { base, memory, workspace } = await scratch();
  try {
    const store = new CheckpointStore(workspace, { globalMemoryRoot: memory, globalMemoryIndexThrottleMs: 0 });
    const target = join(workspace, 'gone.md');
    const created = await store.beforeWrite(target);
    await writeFile(target, 'bye\n');
    await store.confirm(created);
    const removed = await store.beforeWrite(target, { action: 'delete' });
    await store.confirm(removed);

    const records = await readGlobalEdits({ root: memory });
    assert.equal(records.length, 2);
    assert.equal(records[1]?.action, 'delete');
    assert.equal(records[1]?.created, false, 'a deletion never counts as creating the file');

    const index = await readFile(globalMemoryIndexPath(memory), 'utf8');
    assert.match(index, /gone\.md.+已删除/);
    assert.doesNotMatch(index, /gone\.md.+新建/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('the ledger can be switched off per store', async () => {
  const { base, memory, workspace } = await scratch();
  try {
    const store = new CheckpointStore(workspace, { globalMemoryRoot: memory, recordGlobalMemory: false });
    const entry = await store.beforeWrite(join(workspace, 'quiet.md'));
    await store.confirm(entry);
    const records = await readGlobalEdits({ root: memory });
    assert.deepEqual(records, []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

/*
 * The block has to actually reach the model. Written after a change that
 * declared the block, passed every unit test and injected nothing: the wiring
 * is only real if a turn can be observed carrying it.
 */
test('an agent turn carries the global edit record into the model messages', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-agent-global-'));
  const memoryRoot = join(workspace, 'global-memory');
  const previous = process.env.AICODE_GLOBAL_MEMORY_ROOT;
  process.env.AICODE_GLOBAL_MEMORY_ROOT = memoryRoot;
  try {
    await recordGlobalEdit(
      { workspaceRoot: workspace, action: 'write', path: join(workspace, 'src', 'parser.ts'), now: new Date('2026-10-22T09:00:00Z') },
      { root: memoryRoot },
    );

    const config: AppConfig = { provider: 'mock', model: 'mock-code-agent-v1', approval: 'auto', workspaceRoot: workspace, sessionDir: join(workspace, 'sessions'), maxSteps: 2, noBanner: true };
    const sessions = new SessionStore(config.sessionDir);
    const session = await sessions.create({ provider: 'mock', model: 'mock-code-agent-v1', workspaceRoot: workspace });
    const memory = new ProjectMemoryStore(workspace);

    let captured: ProviderRequest['messages'] = [];
    const provider: Provider = {
      name: 'mock',
      model: 'mock-code-agent-v1',
      async complete(request: ProviderRequest) {
        captured = request.messages;
        return { actions: [{ type: 'message', content: 'ok' }] };
      },
    };

    const result = await runAgentTurn(
      { config, provider, tools: createDefaultToolRegistry(), sessions, session, memory, ui: new TerminalUI(true) },
      'continue the parser work',
    );
    assert.equal(result.ok, true);

    const block = captured.find((message) => typeof message.content === 'string' && message.content.startsWith('<global-memory>'));
    assert.ok(block, 'the global memory block should be injected as a message');
    assert.match(String(block?.content), /src\/parser\.ts/, 'it should name a file this workspace really edited');
    assert.match(String(block?.content), /<\/global-memory>/);
  } finally {
    if (previous === undefined) delete process.env.AICODE_GLOBAL_MEMORY_ROOT;
    else process.env.AICODE_GLOBAL_MEMORY_ROOT = previous;
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a burst of edits renders once, and the trailing render sees the last one', async () => {
  const { base, memory, workspace } = await scratch();
  const options = { root: memory, indexThrottleMs: 50 };
  try {
    await recordGlobalEdit({ workspaceRoot: workspace, action: 'write', path: join(workspace, 'a.ts') }, options);
    await recordGlobalEdit({ workspaceRoot: workspace, action: 'write', path: join(workspace, 'b.ts') }, options);

    const during = await readFile(globalMemoryIndexPath(memory), 'utf8');
    assert.doesNotMatch(during, /b\.ts/, 'the second edit is throttled out of the index for now');
    assert.equal((await readGlobalEdits({ root: memory })).length, 2, 'but the ledger is already complete');

    // Poll instead of sleeping a fixed time: the trailing render is a timer,
    // and a loaded machine may deliver it late.
    let after = '';
    for (let attempt = 0; attempt < 40; attempt += 1) {
      after = await readFile(globalMemoryIndexPath(memory), 'utf8');
      if (after.includes('b.ts')) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(after, /b\.ts/, 'the trailing render picks the throttled edit up');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
