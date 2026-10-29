import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { AppConfig } from '../src/config/types.js';
import { createAgentRuntime } from '../src/runtime/createRuntime.js';
import { SessionStore } from '../src/session/store.js';

/*
 * Runtime lifecycle: what createAgentRuntime holds, and what close() gives back.
 *
 * The runtime owns MCP child processes (spawned before any other constructor
 * can fail) and command-job children. Neither is visible to the rest of the
 * process, so "create/close N times" is the only way to see a leak: the handle
 * count has to come back to its starting level every time.
 */

/** tsc does not copy the .mjs fixture into dist, so search the layouts the runner may be in. */
async function resolveFixture(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'fixtures', 'mcp-echo-server.mjs'),
    join(here, '..', 'tests', 'fixtures', 'mcp-echo-server.mjs'),
    join(here, '..', '..', 'tests', 'fixtures', 'mcp-echo-server.mjs'),
    resolve(process.cwd(), 'tests', 'fixtures', 'mcp-echo-server.mjs'),
  ];
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true, () => false)) return candidate;
  }
  throw new Error(`mcp fixture not found: ${candidates.join(', ')}`);
}

async function withMcpWorkspace(run: (workspace: string) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-runtime-lifecycle-'));
  await mkdir(join(workspace, '.aicode'), { recursive: true });
  const fixture = await resolveFixture();
  await writeFile(
    join(workspace, '.aicode', 'mcp.json'),
    JSON.stringify({ servers: { echo: { command: process.execPath, args: [fixture] } } }),
    'utf8',
  );
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function configFor(workspace: string, extra: Partial<AppConfig> = {}): AppConfig {
  return {
    provider: 'mock',
    model: 'mock-code-agent-v1',
    approval: 'auto',
    workspaceRoot: workspace,
    sessionDir: join(workspace, 'sessions'),
    noBanner: true,
    quiet: true,
    ...extra,
  } as AppConfig;
}

function countChildren() {
  return process.getActiveResourcesInfo().filter((name) => name === 'ProcessWrap').length;
}

test('creating and closing a runtime with an MCP server N times leaves no child process behind', async () => {
  await withMcpWorkspace(async (workspace) => {
    // Warm up: the first run may leave a transient handle from the test runner.
    const warm = await createAgentRuntime(configFor(workspace));
    assert.equal(warm.runtime.mcp?.clients.length, 1, 'the MCP server must actually be connected');
    await warm.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const baselineHandles = countChildren();

    for (let round = 0; round < 4; round += 1) {
      const created = await createAgentRuntime(configFor(workspace));
      assert.equal(created.runtime.mcp?.clients.length, 1);
      await created.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(
        countChildren() <= baselineHandles,
        `round ${round}: child handles grew from ${baselineHandles} to ${countChildren()}`,
      );
    }
  });
});

test('close() is idempotent and every call succeeds', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-runtime-close-'));
  try {
    const created = await createAgentRuntime(configFor(workspace));
    await created.close();
    await created.close();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a resume request that fails after the MCP server is up does not leak it', async () => {
  await withMcpWorkspace(async (workspace) => {
    const baselineBefore = countChildren();
    // A well-formed id that does not exist: load() throws after the MCP manager
    // has already spawned its server.
    await assert.rejects(
      createAgentRuntime(configFor(workspace, { resumeSessionId: 'sess_20200101000000_aaaaaaaa' })),
      /ENOENT|no such file/i,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(countChildren(), baselineBefore, 'the spawned MCP child must be torn down with the failed create');
  });
});

test('resuming a session drops a Responses continuation when the runtime is not on that provider', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-runtime-resume-'));
  try {
    const sessions = new SessionStore(join(workspace, 'sessions'));
    const session = await sessions.create({ provider: 'openai-responses', model: 'gpt-5.5', workspaceRoot: workspace });
    session.providerContinuation = { responseId: 'resp_saved', status: 'pending' };
    session.lastTurn = { prompt: 'hello', status: 'done', startedAt: new Date().toISOString() };
    session.goal = 'keep me';
    await sessions.save(session);

    const created = await createAgentRuntime(configFor(workspace, { resumeSessionId: session.id }));
    try {
      // openai-responses-specific state must not reach a mock/openai/anthropic runtime.
      assert.equal(created.runtime.session.providerContinuation, undefined);
      // Everything else in the record is the user's and survives the resume.
      assert.equal(created.runtime.session.goal, 'keep me');
      assert.equal(created.runtime.session.lastTurn?.status, 'done');
      // The record describes the runtime it is opened on, not the one that wrote it.
      assert.equal(created.runtime.session.provider, 'mock');
      assert.equal(created.runtime.session.model, 'mock-code-agent-v1');
    } finally {
      await created.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a continuation is preserved when resuming on the Responses provider', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-runtime-resume-keep-'));
  try {
    const sessions = new SessionStore(join(workspace, 'sessions'));
    const session = await sessions.create({ provider: 'openai-responses', model: 'gpt-5.5', workspaceRoot: workspace });
    session.providerContinuation = { responseId: 'resp_saved', status: 'pending' };
    await sessions.save(session);

    const created = await createAgentRuntime(configFor(workspace, {
      provider: 'openai-responses',
      model: 'gpt-5.5',
      baseUrl: 'http://127.0.0.1:9',
      apiKey: 'test',
      resumeSessionId: session.id,
    }));
    try {
      assert.equal(created.runtime.session.providerContinuation?.responseId, 'resp_saved');
    } finally {
      await created.close();
    }
    // Nothing about resuming rewrites the file on its own.
    const onDisk = await readFile(sessions.filePath(session.id), 'utf8');
    assert.match(onDisk, /resp_saved/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
