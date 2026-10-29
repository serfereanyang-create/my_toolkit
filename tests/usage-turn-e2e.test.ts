import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runAgentTurn, type AgentRuntime } from '../src/agent/agent.js';
import { SUMMARIZATION_PROMPT } from '../src/agent/autoCompact.js';
import { SessionStore } from '../src/session/store.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { TerminalUI } from '../src/ui/terminal.js';
import { createOpenAIProvider } from '../src/providers/openai.js';

/*
 * The cross-file accounting invariant, measured on a REAL turn:
 *
 *   a turn's recorded tokens === the sum of the usage its provider returned,
 *   in BOTH ledgers, with the auto-compaction call counted exactly once.
 *
 * This is the one claim that cannot be checked with pure functions alone,
 * because it spans four writers (usageTotals, tierUsage, CompactUsageSink,
 * appendUsage/recordDispatch). Probe 2 showed the dispatch ledger 4,100 tokens
 * short of the invoice (the entire compaction) before turnAccounting.ts; this
 * test is that probe turned into a gate.
 */

const TURN_PROMPT = '审计探针：把 a.ts 里的函数改成 async（usage-turn-e2e）';

type SeenCall = { kind: 'turn' | 'compact'; model: string; usage: { prompt_tokens: number; completion_tokens: number } };

async function readRows(path: string): Promise<Array<Record<string, any>>> {
  try {
    const text = await readFile(path, 'utf8');
    return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * One local SSE endpoint that serves both a normal turn and the compaction
 * summary, and reports a real usage block for every call. `onCompact` lets a
 * test intervene at the moment the summary request arrives.
 */
async function startProvider(options: {
  windowTokens: number;
  onCompact?: (cancel: () => void) => void;
}) {
  const seen: SeenCall[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      let parsed: any = {};
      try { parsed = JSON.parse(body); } catch { /* keep {} */ }
      const messages: Array<{ content?: unknown }> = parsed.messages ?? [];
      const isCompact = String(messages.at(-1)?.content ?? '').includes(SUMMARIZATION_PROMPT);
      const model = String(parsed.model ?? 'unknown');
      if (isCompact && options.onCompact) {
        // Do not answer: the test decides what happens to the in-flight summary.
        options.onCompact(() => { try { response.destroy(); } catch { /* client may be gone */ } });
        return;
      }
      const usage = isCompact
        ? { prompt_tokens: 3_800, completion_tokens: 300 }
        : { prompt_tokens: 900, completion_tokens: 20 };
      seen.push({ kind: isCompact ? 'compact' : 'turn', model, usage });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: isCompact ? 'handoff summary' : 'done' } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    seen,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

async function withIsolatedHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'cost-home-'));
  const previous = process.env.USERPROFILE;
  const previousHome = process.env.HOME;
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    if (previous === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previous;
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
}

test('a dispatch turn with compaction records the provider total in both ledgers', async () => {
  const previousWindow = process.env.AICODE_CONTEXT_WINDOW;
  const provider = await startProvider({ windowTokens: 4_000 });
  process.env.AICODE_CONTEXT_WINDOW = '4000';
  await withIsolatedHome(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cost-e2e-'));
    try {
      const configPath = join(dir, 'v2.json');
      await writeFile(configPath, JSON.stringify({
        provider: {
          local: {
            name: 'local', kind: 'openai', enabled: true,
            options: { apiKey: 'test', baseURL: provider.baseUrl },
            models: { 'glm-5.3': {}, 'glm-5.3-flash': {} },
          },
        },
      }), 'utf8');
      const sessions = new SessionStore(join(dir, 'sessions'));
      const session = await sessions.create({ provider: 'openai', model: 'glm-5.3', workspaceRoot: dir });
      // 8 × 2,000 chars ≈ 4,000 estimated tokens: at the compaction trigger.
      for (let i = 0; i < 8; i += 1) {
        await sessions.appendMessage(session, { role: i % 2 === 0 ? 'user' : 'assistant', content: 'a'.repeat(2_000) });
      }
      const runtime = {
        config: {
          workspaceRoot: dir,
          approval: 'auto',
          maxSteps: 4,
          provider: 'openai',
          model: 'glm-5.3',
          baseUrl: provider.baseUrl,
          apiKey: 'test',
          sessionDir: join(dir, 'sessions'),
          usageLog: join(dir, 'usage.jsonl'),
          dispatch: true,
          dispatchConfigPath: configPath,
        },
        provider: createOpenAIProvider({ apiKey: 'test', baseUrl: provider.baseUrl, model: 'glm-5.3' }),
        session,
        sessions,
        tools: ToolRegistry.fromTools([]),
        ui: new TerminalUI({ quiet: true }),
        toolScope: 'full',
        compactEmit: () => {},
      } as unknown as AgentRuntime;

      const result = await runAgentTurn(runtime, TURN_PROMPT);
      assert.equal(result.ok, true);

      const calls = provider.seen;
      assert.ok(calls.some((call) => call.kind === 'compact'), 'the turn must actually have compacted');
      const providerTotal = calls.reduce((sum, call) => sum + call.usage.prompt_tokens + call.usage.completion_tokens, 0);
      const providerCompact = calls
        .filter((call) => call.kind === 'compact')
        .reduce((sum, call) => sum + call.usage.prompt_tokens + call.usage.completion_tokens, 0);

      const usageRows = await readRows(join(dir, 'usage.jsonl'));
      assert.equal(usageRows.length, 1, 'one ledger line per turn');
      const usageRow = usageRows[0];
      const usageTotal = usageRow.inputTokens + usageRow.outputTokens
        + (usageRow.autoCompact?.inputTokens ?? 0) + (usageRow.autoCompact?.outputTokens ?? 0);
      assert.equal(usageTotal, providerTotal, 'turn ledger + compaction block === invoice');
      assert.equal(
        usageRow.autoCompact?.inputTokens + usageRow.autoCompact?.outputTokens,
        providerCompact,
        'the compaction block carries the summary request alone',
      );

      const dispatchRows = await readRows(join(dir, '.shengqian-logs', 'usage-ledger.jsonl'));
      assert.ok(dispatchRows.length >= 1, 'the tier dispatch still writes its rows');
      assert.equal(
        dispatchRows.reduce((sum, row) => sum + row.totalTokens, 0),
        providerTotal,
        'dispatch ledger === invoice (this was 4,100 short before turnAccounting.ts)',
      );
      const labelled = dispatchRows.filter((row) => row.autoCompact !== undefined);
      assert.equal(labelled.length, 1, 'compaction is attached to exactly one row');
      assert.equal(labelled[0].autoCompact.inputTokens + labelled[0].autoCompact.outputTokens, providerCompact);
      // Every tier row names the model that answered it, not the last one used.
      for (const row of dispatchRows) {
        assert.ok(row.model, 'a row without a model cannot be attributed');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  await provider.close();
  if (previousWindow === undefined) delete process.env.AICODE_CONTEXT_WINDOW;
  else process.env.AICODE_CONTEXT_WINDOW = previousWindow;
});

test('a cancel during the summary call is recorded as cancelled, not as a provider failure', async () => {
  const previousWindow = process.env.AICODE_CONTEXT_WINDOW;
  let cancelTurn: (() => void) | undefined;
  // The summary request arrives, then the user stops the turn: the request is
  // already on the wire, so the attempt is billable, but it is not a defect.
  const provider = await startProvider({
    windowTokens: 4_000,
    onCompact: (cancel) => {
      cancelTurn = cancel;
    },
  });
  process.env.AICODE_CONTEXT_WINDOW = '4000';
  await withIsolatedHome(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cost-e2e-cancel-'));
    try {
      const sessions = new SessionStore(join(dir, 'sessions'));
      const session = await sessions.create({ provider: 'openai', model: 'glm-5.3', workspaceRoot: dir });
      for (let i = 0; i < 8; i += 1) {
        await sessions.appendMessage(session, { role: i % 2 === 0 ? 'user' : 'assistant', content: 'a'.repeat(2_000) });
      }
      const runtime = {
        config: {
          workspaceRoot: dir,
          approval: 'auto',
          maxSteps: 4,
          provider: 'openai',
          model: 'glm-5.3',
          baseUrl: provider.baseUrl,
          apiKey: 'test',
          sessionDir: join(dir, 'sessions'),
          usageLog: join(dir, 'usage.jsonl'),
          dispatch: false,
        },
        provider: createOpenAIProvider({ apiKey: 'test', baseUrl: provider.baseUrl, model: 'glm-5.3' }),
        session,
        sessions,
        tools: ToolRegistry.fromTools([]),
        ui: new TerminalUI({ quiet: true }),
        toolScope: 'full',
        compactEmit: () => {},
      } as unknown as AgentRuntime;

      const pending = runAgentTurn(runtime, TURN_PROMPT);
      // Wait for the summary request to be in flight, then stop the turn.
      const deadline = Date.now() + 5_000;
      while (!cancelTurn && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(cancelTurn, 'the summary request reached the provider');
      runtime.cancelCurrentTurn?.();
      cancelTurn!();
      const result = await pending;

      assert.equal(result.outcome, 'cancelled');
      const usageRows = await readRows(join(dir, 'usage.jsonl'));
      assert.equal(usageRows.length, 1, 'the attempt was still billed and recorded');
      assert.equal(usageRows[0].autoCompact?.calls, 1);
      assert.equal(
        usageRows[0].autoCompact?.outcome,
        'cancelled',
        'a user cancel must not be filed as a provider failure',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  await provider.close();
  if (previousWindow === undefined) delete process.env.AICODE_CONTEXT_WINDOW;
  else process.env.AICODE_CONTEXT_WINDOW = previousWindow;
});
