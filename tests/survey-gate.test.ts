import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runAgentTurn, type AgentRuntime } from '../src/agent/agent.js';
import { SessionStore } from '../src/session/store.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolDefinition } from '../src/tools/types.js';
import { TerminalUI } from '../src/ui/terminal.js';
import type { Provider } from '../src/providers/types.js';
import { shouldSurveyFirst, surveyBlocksTool, surveyRefusal } from '../src/tasks/survey.js';

/*
 * Investigate-before-editing.
 *
 * The failure this pins: asked to change something, the agent went straight to
 * the write tool without reading the file it was about to change. The gate makes
 * the first edit of a turn wait until something has been read, and it must not
 * turn into a trap — the refusal has to be a normal tool result the model can
 * act on in the next step, not the end of the turn.
 */

/** Named exactly like the real tools: the gate keys on tool names. */
function namedTool(
  name: string,
  risk: 'read' | 'write',
  execute: () => Promise<{ ok: boolean; output: string }>,
): ToolDefinition<Record<string, unknown>> {
  return {
    name,
    description: `${name} fixture`,
    inputHint: '{}',
    risk,
    validate: (input) => (input ?? {}) as Record<string, unknown>,
    execute,
  };
}

async function makeRuntime(root: string, provider: Provider, tools: ToolDefinition<Record<string, unknown>>[]) {
  const sessions = new SessionStore(join(root, 'sessions'));
  const session = await sessions.create({ provider: 'openai', model: 'test-model', workspaceRoot: root });
  const runtime = {
    config: {
      workspaceRoot: root,
      approval: 'auto',
      maxSteps: 10,
      provider: 'openai',
      model: 'test-model',
      sessionDir: join(root, 'sessions'),
    },
    provider,
    session,
    sessions,
    tools: ToolRegistry.fromTools(tools),
    ui: new TerminalUI({ quiet: true }),
    toolScope: 'full',
  } as unknown as AgentRuntime;
  return { runtime, session };
}

test('an edit before any read is refused, and the model may edit after reading', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aicode-survey-'));
  try {
    await writeFile(join(root, 'app.ts'), 'export const answer = 41;\n', 'utf8');
    let calls = 0;
    const refusals: string[] = [];
    const provider: Provider = {
      name: 'openai',
      model: 'test-model',
      async complete(request) {
        calls += 1;
        for (const message of request.messages) {
          if (typeof message.content === 'string' && message.content.includes('已拒绝')) {
            refusals.push(message.content);
          }
        }
        if (calls === 1) {
          // A blind overwrite of a file it has never read.
          return { actions: [{ type: 'tool', tool: 'write_file', input: { path: 'app.ts', content: 'x' }, callId: 'c1' }] };
        }
        if (calls === 2) {
          return { actions: [{ type: 'tool', tool: 'read_file', input: { path: 'app.ts' }, callId: 'c2' }] };
        }
        if (calls === 3) {
          return { actions: [{ type: 'tool', tool: 'write_file', input: { path: 'app.ts', content: 'export const answer = 42;\n' }, callId: 'c3' }] };
        }
        return { actions: [{ type: 'message', content: '改好了：app.ts 里的常量改为 42。' }] };
      },
    };

    const tools = [
      namedTool('read_file', 'read', async () => ({ ok: true, output: 'export const answer = 41;' })),
      namedTool('write_file', 'write', async () => ({ ok: true, output: 'wrote app.ts' })),
    ];
    const { runtime, session } = await makeRuntime(root, provider, tools);
    // The prompt has to carry write intent, otherwise the gate stands down.
    const result = await runAgentTurn(runtime, '把 app.ts 里的常量改成 42');

    assert.equal(result.ok, true, 'a refusal must not end the turn');
    assert.deepEqual(
      session.toolCalls.map((call) => `${call.tool}:${call.ok}`),
      ['write_file:false', 'read_file:true', 'write_file:true'],
      'the blind write is refused, the read passes, the write after the read passes',
    );
    assert.ok(refusals.length >= 1, 'the refusal is fed back to the model as a tool result');
    assert.match(refusals[0] ?? '', /本轮还没有读过任何代码/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a read-only turn is not gated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aicode-survey-readonly-'));
  try {
    await writeFile(join(root, 'app.ts'), 'export const answer = 41;\n', 'utf8');
    let calls = 0;
    const provider: Provider = {
      name: 'openai',
      model: 'test-model',
      async complete() {
        calls += 1;
        if (calls === 1) {
          // Overwriting an existing file is on the gated list, but this turn has
          // no write intent at all, so the gate must not fire.
          return { actions: [{ type: 'tool', tool: 'write_file', input: { path: 'app.ts', content: 'y' }, callId: 'c1' }] };
        }
        return { actions: [{ type: 'message', content: 'ok' }] };
      },
    };
    // Only the write tool is registered on purpose: the checkpoint layer
    // snapshots a file before a write by calling `read_file`, and a fixture that
    // answers that snapshot would stand in for the write itself.
    const tools = [namedTool('write_file', 'write', async () => ({ ok: true, output: 'wrote app.ts' }))];
    const { runtime, session } = await makeRuntime(root, provider, tools);
    const result = await runAgentTurn(runtime, 'app.ts 里有哪些内容');

    assert.equal(result.ok, true);
    const writeCall = session.toolCalls.find((call) => call.tool === 'write_file');
    assert.ok(writeCall, 'the write was attempted');
    // The claim is about the survey, not about the write succeeding: any other
    // layer may still refuse it, but this one must stay out of the way.
    assert.doesNotMatch(String(writeCall.output), /已拒绝|还没有读过任何代码/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the gate judgement itself: patches always, plain writes only when the file exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aicode-survey-rules-'));
  try {
    await writeFile(join(root, 'existing.ts'), 'x\n', 'utf8');

    assert.equal(surveyBlocksTool('apply_patch', { patch: 'x' }, root), true);
    assert.equal(surveyBlocksTool('edit_lines', { path: 'existing.ts' }, root), true);

    // Overwriting needs a read first; creating a new file does not.
    assert.equal(surveyBlocksTool('write_file', { path: 'existing.ts' }, root), true);
    assert.equal(surveyBlocksTool('write_file', { path: 'brand-new.ts' }, root), false);

    // Unrelated tools and unreadable inputs are left to the tool itself.
    assert.equal(surveyBlocksTool('read_file', { path: 'existing.ts' }, root), false);
    assert.equal(surveyBlocksTool('write_file', {}, root), false);

    assert.match(surveyRefusal('write_file'), /write_file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('which turns need the survey: write intent, not plan turns, not small talk', () => {
  assert.equal(shouldSurveyFirst({ complexity: 'standard', hasWriteIntent: true }), true);
  assert.equal(shouldSurveyFirst({ complexity: 'large', hasWriteIntent: true }), true);
  // A planning turn already carries a stricter survey-then-propose contract.
  assert.equal(shouldSurveyFirst({ complexity: 'large', hasWriteIntent: true }, true), false);
  assert.equal(shouldSurveyFirst({ complexity: 'standard', hasWriteIntent: false }), false);
  assert.equal(shouldSurveyFirst({ complexity: 'small', hasWriteIntent: true }), false);
});
