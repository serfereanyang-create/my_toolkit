import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runAgentTurn } from '../src/agent/agent.js';
import { SessionStore } from '../src/session/store.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { TerminalUI } from '../src/ui/terminal.js';
import { BACKGROUND_BROWSER_TOOL_NAMES } from '../src/tools/backgroundBrowser.js';
import { COMPUTER_TOOL_NAMES } from '../src/tools/computer.js';
import type { AppConfig } from '../src/config/types.js';

/*
 * `--background-browser-only` is a safety promise, not a preference: a web task
 * must run in the hidden browser and must NOT be able to seize the user's real
 * mouse, keyboard, or focus. That promise is kept in two places — the wake
 * decision and the tool list — and both have to hold, because either alone
 * leaves a path to `computer_*`:
 *
 *   - waking would inject the native tools post-scope, after the removal below
 *     has already run, and
 *   - the removal is what actually takes them out of the scoped set.
 *
 * The turn below is real (a mock provider, no network), so what is asserted is
 * the tool surface the model is actually offered, not a helper's return value.
 */

async function runOneTurn(config: Partial<AppConfig>, tools = createDefaultToolRegistry()) {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-bgonly-'));
  const sessionDir = join(workspace, '.aicode', 'sessions');
  const sessions = new SessionStore(sessionDir);
  const session = await sessions.create({ provider: 'mock', model: 'mock-code-agent-v1', workspaceRoot: workspace });
  const fullConfig = {
    provider: 'mock',
    model: 'mock-code-agent-v1',
    approval: 'auto',
    workspaceRoot: workspace,
    sessionDir,
    prompt: '',
    maxSteps: 5,
    noBanner: true,
    ...config,
  } as AppConfig;
  const provider = {
    name: 'mock' as const,
    model: 'mock-code-agent-v1',
    async complete() {
      return { actions: [{ type: 'message' as const, content: 'done' }] };
    },
  };
  const offers: string[][] = [];
  const spiedProvider = {
    ...provider,
    async complete(request: { tools?: Array<{ name: string }> }) {
      offers.push((request.tools ?? []).map((tool) => tool.name));
      return provider.complete();
    },
  };
  const runtime = {
    config: fullConfig,
    provider: spiedProvider,
    allTools: tools,
    tools,
    sessions,
    session,
    ui: new TerminalUI({ quiet: true, json: true, noColor: true }),
    // The desktop bridge installs this host RPC before the first turn; without
    // it the hidden-browser tools are not injected at all (there would be
    // nothing to serve them), so the fixture must provide it too.
    hostToolInvoke: async () => ({ ok: true, output: 'stub' }),
  } as never;
  try {
    // `computerUseActive` is what gates native computer control; a session that
    // was armed via `/computer use` persists that flag on the record.
    await runAgentTurn(runtime, 'open example.com and read the title');
    return { offers, runtime: runtime as unknown as { computerUseActive?: boolean } };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test('background-browser-only never offers a native computer tool, even when armed', async () => {
  // `sessionArmed` alone would wake computer control on any approval mode, so
  // this is the exact configuration that used to re-inject the native tools
  // after the background-only removal.
  const { offers, runtime } = await runOneTurn({ backgroundBrowserOnly: true, computerAnyApp: true });
  assert.equal(runtime.computerUseActive, false, 'background-only must not arm native computer control');
  const all = offers.flat();
  for (const name of COMPUTER_TOOL_NAMES) {
    assert.ok(!all.includes(name), `${name} must not be offered in background-only mode`);
  }
  assert.ok(!all.includes('excel_automate'), 'excel COM automation drives a native window and must not be offered');
});

test('background-browser-only offers the hidden browser tools instead', async () => {
  // The replacement for native control: without these the agent would have no
  // way to do a web task at all in this mode. `backgroundBrowser` is set
  // alongside the only-flag because that is what the config loader does —
  // `--background-browser-only` implies `--background-browser`.
  const { offers } = await runOneTurn({ backgroundBrowser: true, backgroundBrowserOnly: true });
  const all = offers.flat();
  assert.ok(
    [...BACKGROUND_BROWSER_TOOL_NAMES].some((name) => all.includes(name)),
    `no hidden browser tool was offered; saw ${all.length} tools`,
  );
});

test('the native tools are still available when background-only is off', async () => {
  // The removal must be conditional. If it ran unconditionally this test would
  // be the one to fail, and the mode would silently disable a feature the user
  // asked for.
  const { runtime } = await runOneTurn({ computerAnyApp: true }, createDefaultToolRegistry({ excelAutomation: true }));
  assert.equal(runtime.computerUseActive, true, 'full access + 任意应用 should still wake computer control');
});
