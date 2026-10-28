import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runAgentTurn, type AgentRuntime } from '../src/agent/agent.js';
import { SUMMARIZATION_PROMPT, sessionTokens } from '../src/agent/autoCompact.js';
import { SessionStore } from '../src/session/store.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolDefinition } from '../src/tools/types.js';
import { TerminalUI } from '../src/ui/terminal.js';
import type { AgentMessage, Provider, ProviderRequest } from '../src/providers/types.js';

/*
 * Auto-compaction has to be proven on the path a real turn takes, not just in
 * `shouldAutoCompact`: two separate defects lived in the plumbing around it and
 * both looked like "compaction is off" from the outside.
 *
 *  1. The window used to be unknown for desktop models, so the trigger answered
 *     false forever (`modelWindows.ts` has the history).
 *  2. The summarization request used to carry the RAW session — including tool
 *     results that are far larger than the window. The provider rejected it with
 *     a context-length error, the history was kept, and the next step rebuilt the
 *     identical request; compaction then failed on every step forever while
 *     ordinary turns kept working, because those ARE packed first.
 *
 * These tests drive `runAgentTurn` itself with the real `SessionStore`, the real
 * packing and a provider that enforces the window the way a real API does.
 */

const noopTool: ToolDefinition<Record<string, never>> = {
  name: 'noop_compact_probe',
  description: 'no-op',
  inputHint: '{}',
  risk: 'read',
  validate(input) {
    return (input ?? {}) as Record<string, never>;
  },
  async execute() {
    return { ok: true, output: 'ok' };
  },
};

type Harness = {
  runtime: AgentRuntime;
  root: string;
  compactionPhases: string[];
  /** Every request the provider saw, with its measured prompt size. */
  requests: Array<{ tokens: number; messages: AgentMessage[]; tools: number }>;
};

async function makeHarness(
  history: Array<Pick<AgentMessage, 'role' | 'content' | 'name'>>,
  options: { windowTokens: number; rejectOverWindow?: boolean },
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'aicode-autocompact-'));
  const sessions = new SessionStore(join(root, 'sessions'));
  const session = await sessions.create({ provider: 'openai', model: 'test-model', workspaceRoot: root });
  for (const message of history) {
    await sessions.appendMessage(session, message as Omit<AgentMessage, 'createdAt'>);
  }
  const compactionPhases: string[] = [];
  const requests: Harness['requests'] = [];
  const provider: Provider = {
    name: 'openai',
    model: 'test-model',
    async complete(request: ProviderRequest) {
      const tokens = Math.ceil(
        Buffer.byteLength(request.messages.map((message) => message.content).join('\n'), 'utf8') / 4,
      );
      requests.push({ tokens, messages: request.messages, tools: request.tools.length });
      // A real endpoint rejects a prompt larger than the window instead of
      // silently truncating it — that rejection is what made compaction loop.
      if (options.rejectOverWindow && tokens > options.windowTokens) {
        throw new Error(`400 Bad Request: prompt is too long: ${tokens} tokens > ${options.windowTokens} maximum`);
      }
      const isCompaction = request.messages.at(-1)?.content === SUMMARIZATION_PROMPT;
      return {
        actions: [{ type: 'message', content: isCompaction ? 'handoff summary' : 'done' }],
      };
    },
  };
  const runtime: AgentRuntime = {
    config: {
      workspaceRoot: root,
      approval: 'auto',
      provider: 'openai',
      model: 'test-model',
      sessionDir: join(root, 'sessions'),
    },
    provider,
    session,
    sessions,
    tools: ToolRegistry.fromTools([noopTool]),
    ui: new TerminalUI({ quiet: true }),
    // Scope selection would otherwise filter the fixture tool out of the
    // registry and turn this into a test of the wrong thing.
    toolScope: 'full',
    compactEmit: (payload: { phase: 'started' | 'completed' | 'failed' }) => compactionPhases.push(payload.phase),
  } as unknown as AgentRuntime;
  return { runtime, root, compactionPhases, requests };
}

async function withWindow<T>(tokens: number, run: () => Promise<T>): Promise<T> {
  const previous = process.env.AICODE_CONTEXT_WINDOW;
  process.env.AICODE_CONTEXT_WINDOW = String(tokens);
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.AICODE_CONTEXT_WINDOW;
    else process.env.AICODE_CONTEXT_WINDOW = previous;
  }
}

test('a real turn compacts at 90% of the window and not before', async () => {
  const below = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: 'a'.repeat(1_200),
  }));
  const above = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: 'a'.repeat(2_000),
  }));

  // window 4_000 → limit 3_600 tokens = 14_400 bytes.
  await withWindow(4_000, async () => {
    const quiet = await makeHarness(below, { windowTokens: 4_000 });
    try {
      // `sessionTokens` joins with '\n', hence the few bytes over 9_600.
      const belowTokens = sessionTokens(quiet.runtime.session.messages);
      assert.ok(belowTokens < 3_600, `fixture must sit below the limit, got ${belowTokens}`);
      await runAgentTurn(quiet.runtime, 'next question');
      assert.deepEqual(quiet.compactionPhases, [], 'below 90% nothing may fire');
      assert.equal(quiet.requests.length, 1, 'exactly one model call');
      // 8 stored messages + the new input, plus any injected context block.
      assert.ok(
        quiet.requests[0]!.messages.length >= 9,
        `the whole history plus the new input is sent, saw ${quiet.requests[0]!.messages.length}`,
      );
    } finally {
      await rm(quiet.root, { recursive: true, force: true });
    }

    const loud = await makeHarness(above, { windowTokens: 4_000 });
    try {
      const aboveTokens = sessionTokens(loud.runtime.session.messages);
      assert.ok(aboveTokens >= 3_600, `fixture must reach the limit, got ${aboveTokens}`);
      await runAgentTurn(loud.runtime, 'next question');
      assert.deepEqual(loud.compactionPhases, ['started', 'completed'], 'the pre-turn pass replaced the history');
      assert.ok(loud.requests.length >= 2, 'the compaction call is followed by the real turn');
      const turnRequest = loud.requests.at(-1)!;
      assert.ok(
        turnRequest.messages.length < 9,
        `the turn must be sent the compacted history, saw ${turnRequest.messages.length} messages`,
      );
      assert.ok(
        loud.runtime.session.messages.some((message) => message.content.startsWith('[compacted session history]')),
        'the summary stub replaced the old history',
      );
    } finally {
      await rm(loud.root, { recursive: true, force: true });
    }
  });
});

/*
 * Regression for the desktop report "现在压缩不了上下文自动".
 *
 * One 300k-char tool result (a fetched page; the real session that reproduced
 * this carried 2.7 MB in a single `fetch_url` message) is enough. Ordinary
 * requests survive it because they are packed to the per-role limits first, so
 * the turn keeps working and it looks like compaction simply never runs.
 */
test('one oversized tool result cannot make every compaction attempt fail', async () => {
  const history: Array<Pick<AgentMessage, 'role' | 'content' | 'name'>> = [
    { role: 'user', content: 'compare with codex' },
    { role: 'assistant', content: 'reading the tree' },
    { role: 'tool', name: 'read_file', content: 'x'.repeat(2_000) },
    { role: 'tool', name: 'fetch_url', content: 'y'.repeat(300_000) },
    { role: 'tool', name: 'read_file', content: 'z'.repeat(8_000) },
    { role: 'assistant', content: 'here is the comparison' },
    { role: 'user', content: 'why does compaction always fail' },
    { role: 'tool', name: 'glob_files', content: 'a.ts\nb.ts' },
  ];

  // window 20_000 → limit 18_000 tokens = 72_000 bytes; the raw history is
  // ~78_000 tokens because of that one tool result.
  await withWindow(20_000, async () => {
    const harness = await makeHarness(history, { windowTokens: 20_000, rejectOverWindow: true });
    try {
      assert.ok(sessionTokens(harness.runtime.session.messages) > 18_000, 'fixture must trigger');
      await runAgentTurn(harness.runtime, 'continue');
      assert.deepEqual(
        harness.compactionPhases,
        ['started', 'completed'],
        'compaction must succeed despite the oversized tool result',
      );
      const compactionRequest = harness.requests.find(
        (request) => request.messages.at(-1)?.content === SUMMARIZATION_PROMPT,
      );
      assert.ok(compactionRequest, 'the summarization request was sent');
      assert.ok(
        compactionRequest.tokens <= 20_000,
        `summarization prompt must fit the window, was ${compactionRequest.tokens} tokens`,
      );
      assert.ok(
        harness.runtime.session.messages.some((message) => message.content.startsWith('[compacted session history]')),
        'the summary stub replaced the oversized history',
      );
      assert.ok(
        harness.runtime.session.messages.every((message) => message.content.length < 300_000),
        'the 300k-char tool result is no longer in history',
      );
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });
});
