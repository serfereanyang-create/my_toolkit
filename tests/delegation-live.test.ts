import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRuntime } from '../src/runtime/createRuntime.js';
import { runPromptMode } from '../src/cli/repl.js';
import { supervisorFor } from '../src/agent/agent.js';
import { buildToolSystemPromptParts } from '../src/providers/protocol.js';
import type { Provider, ProviderRequest, ProviderResponse } from '../src/providers/types.js';

/*
 * The causal chain the delegation level is supposed to drive, end to end:
 *
 *   configured level → system prompt block → model's decision → spawn_subagent
 *     → a real sub-session → the supervisor's delegated count
 *
 * A real model is not available in CI (and a live one is not deterministic), so
 * the "model" here is scripted: it reads its own system prompt and decides the
 * way the prompt tells it to. That makes the test about the WIRING rather than
 * about a particular model's compliance — it fails if the level stops reaching
 * the prompt, if the tool stops being callable, or if the delegation stops
 * being counted, which are the three things a config knob can silently break.
 *
 * What it deliberately does NOT claim: that a given real model obeys. That is
 * a property of the prompt text, asserted separately in delegation-level.test.ts.
 */

/** A provider that delegates iff its system prompt tells it to. */
function delegatingProvider(): { provider: Provider; promptsSeen: string[] } {
  const promptsSeen: string[] = [];
  let delegated = false;
  const provider: Provider = {
    name: 'mock',
    model: 'scripted-delegator',
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      const stable = buildToolSystemPromptParts(request.tools, request.projectContext, request.toolStrategy, {
        workspaceRoot: request.workspaceRoot,
        desktopBridge: request.desktopBridge,
        delegation: request.delegation,
      }).stable;
      promptsSeen.push(stable);

      const wantsDelegation = stable.includes('默认委派');
      const forbidsDelegation = stable.includes('不要派子智能体');

      if (wantsDelegation && !delegated) {
        delegated = true;
        return {
          actions: [{
            type: 'tool',
            tool: 'spawn_subagent',
            input: {
              subagents: [{ id: 'scout', goal: '调研 src 目录', expert: 'code_search', label: '调研' }],
            },
          }],
        };
      }
      return { actions: [{ type: 'message', content: 'done' }] };
    },
  } as Provider;
  return { provider, promptsSeen };
}

async function runWithLevel(level: 'off' | 'balanced' | 'eager') {
  const workspace = await mkdtemp(join(tmpdir(), `aicode-deleg-${level}-`));
  const created = await createAgentRuntime({
    provider: 'mock',
    model: 'mock-code-agent-v1',
    approval: 'auto',
    // spawn_subagent is risk 'shell' with no command string, so under `auto`
    // the policy layer refuses it ("command is not in auto approval allowlist")
    // unless computerAnyApp is on. That is the setting the desktop runs with,
    // and the only way delegation works in auto mode at all — see the
    // dedicated test below.
    computerAnyApp: true,
    workspaceRoot: workspace,
    sessionDir: join(workspace, 'sessions'),
    noBanner: true,
    json: true,
    quiet: true,
    delegation: level,
  });
  try {
    const scripted = delegatingProvider();
    created.runtime.provider = scripted.provider;
    const subagents: Array<Record<string, unknown>> = [];
    created.runtime.subagentEmit = (payload) => subagents.push(payload as Record<string, unknown>);

    await runPromptMode(created.runtime, 'src 目录里有什么文件？');
    return {
      promptsSeen: scripted.promptsSeen,
      subagents,
      snapshot: supervisorFor(created.runtime).snapshot(),
      sessionIds: created.runtime.session.id,
    };
  } finally {
    await created.close();
    await rm(workspace, { recursive: true, force: true });
  }
}

test('eager makes the prompt ask for delegation, and delegation happens', async () => {
  const run = await runWithLevel('eager');
  assert.ok(run.promptsSeen.length > 0, 'the provider must be consulted');
  assert.ok(run.promptsSeen[0]!.includes('默认委派'), 'eager block must reach the provider');

  // The sub-agent actually ran, as a real sub-session.
  assert.equal(run.subagents.length, 2, 'one started + one done event');
  assert.equal(run.subagents[0]!.phase, 'started');
  assert.equal(run.subagents[0]!.expert, 'code_search');
  // The session id arrives on the `done` event: at `started` the sub-session has
  // not been created yet, so it is legitimately empty there.
  assert.ok(run.subagents[1]!.subSessionId, 'the finished run carries its sub-session id');

  // And the supervisor counted it — this is the observable the desktop reads.
  assert.equal(run.snapshot.delegated, 1);
  assert.deepEqual(run.snapshot.delegatedExperts, ['code_search']);
});

test('balanced does not ask for delegation, so nothing is delegated', async () => {
  const run = await runWithLevel('balanced');
  assert.ok(run.promptsSeen[0]!.includes('适合委派的场景'), 'balanced block must reach the provider');
  assert.equal(run.subagents.length, 0);
  assert.equal(run.snapshot.delegated, 0, 'a session that delegated nothing reports 0, not an absence');
  assert.deepEqual(run.snapshot.delegatedExperts, []);
});

test('off forbids delegation, so nothing is delegated', async () => {
  const run = await runWithLevel('off');
  assert.ok(run.promptsSeen[0]!.includes('不要派子智能体'), 'off block must reach the provider');
  assert.equal(run.subagents.length, 0);
  assert.equal(run.snapshot.delegated, 0);
});

test('an absent level behaves as eager through the whole chain', async () => {
  // The default must be the configured behaviour, not just the documented one:
  // a runtime that never heard of this field still delegates.
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-deleg-default-'));
  const created = await createAgentRuntime({
    provider: 'mock',
    model: 'mock-code-agent-v1',
    approval: 'auto',
    workspaceRoot: workspace,
    sessionDir: join(workspace, 'sessions'),
    noBanner: true,
    json: true,
    quiet: true,
    computerAnyApp: true,
    // delegation deliberately omitted
  });
  try {
    const scripted = delegatingProvider();
    created.runtime.provider = scripted.provider;
    const subagents: Array<Record<string, unknown>> = [];
    created.runtime.subagentEmit = (payload) => subagents.push(payload as Record<string, unknown>);
    await runPromptMode(created.runtime, 'src 目录里有什么文件？');
    assert.ok(scripted.promptsSeen[0]!.includes('默认委派'));
    assert.equal(subagents.length, 2);
    assert.equal(supervisorFor(created.runtime).snapshot().delegated, 1);
  } finally {
    await created.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('spawn_subagent is refused under auto approval unless computerAnyApp is on', async () => {
  // Not a property of the delegation level — a gate that sits in front of it,
  // and the reason "delegation never fires" has a second cause beyond the
  // prompt. spawn_subagent carries risk 'shell' and no command string, so the
  // shell branch of decideApproval treats it as a command that must be on the
  // auto allowlist, which it never is. In `auto` mode the only thing that lets
  // it through is computerAnyApp ("任意应用").
  //
  // Pinned because the symptom is silent: the tool is offered, the model calls
  // it, and the call comes back as a policy refusal the user reads as a
  // failure — with nothing pointing at the approval mode.
  const { decideApproval } = await import('../src/safety/policy.js');
  const request = {
    risk: 'shell' as const,
    workspaceRoot: '.',
    command: undefined,
    computerUse: false,
  };
  assert.equal(decideApproval({ ...request, mode: 'auto', computerAnyApp: false }).allowed, false);
  assert.equal(decideApproval({ ...request, mode: 'auto', computerAnyApp: true }).allowed, true);
  // ask/plan prompt instead of refusing, so delegation is reachable there too.
  assert.equal(decideApproval({ ...request, mode: 'ask', computerAnyApp: false }).needsPrompt, true);
  assert.equal(decideApproval({ ...request, mode: 'plan', computerAnyApp: false }).needsPrompt, true);
  // deny refuses everywhere, as it should.
  assert.equal(decideApproval({ ...request, mode: 'deny', computerAnyApp: true }).allowed, false);
});
