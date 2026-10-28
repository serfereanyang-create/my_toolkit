import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TOOL_SCOPE_EVENT_FIELDS,
  TOOL_SCOPE_RESOLVED_EVENT,
  classifyToolScopeReason,
  resolveDesktopToolScope,
  runDesktopBridge,
  shouldEmitToolScopeResolved,
  toolScopeResolvedPayload,
  type ToolScopeEmissionState,
  type ToolScopeResolution,
} from '../src/cli/desktopBridge.js';
import { resolveToolScope, resolveToolScopeForTurn, SCOPE_RANK, type ResolvedToolScope, type ToolScope } from '../src/tools/scope.js';
import { analyzeTaskComplexity } from '../src/tasks/complexity.js';
import { clampReasoningEffort, getReasoningCapability } from '../src/providers/capabilities.js';
import type { AgentRuntime } from '../src/agent/agent.js';
import { createAgentRuntime } from '../src/runtime/createRuntime.js';
import type { AppConfig } from '../src/config/types.js';

/*
 * Protocol tests for the "what actually took effect" tool-scope event.
 *
 * The bridge exists so the desktop can show the scope a turn really ran with,
 * not only the one the user picked. Three properties carry that promise and all
 * three are tested here with generated sequences, not hand-picked examples:
 *
 *   1. Dedupe: the first value is always announced, then only changes. (A bug
 *      here is either a silent UI or one event per turn.)
 *   2. Widen-only: under `auto`, the effective scope never narrows across turns
 *      (absent an explicit pick), and an explicit pick clears the floor so the
 *      NEXT auto turn may narrow once.
 *   3. Normalisation: no value that is not compact/standard/full ever reaches
 *      the wire, whatever the picker or config supplied.
 *
 * The generator is a deterministic PRNG seeded per test, so a failure is
 * reproducible from the seed printed in the assertion message.
 */

/** mulberry32 — 32-bit, deterministic, no dependency. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SCOPES: ToolScope[] = ['auto', 'compact', 'standard', 'full'];
const RESOLVED: ResolvedToolScope[] = ['compact', 'standard', 'full'];

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)];
}

test('the first emission always fires, then only a changed effective value does', () => {
  const random = mulberry32(0x5eed_0001);
  const sessionId = 'sess_dedupe';
  for (let run = 0; run < 200; run += 1) {
    let last: ToolScopeEmissionState;
    let previousSent: ResolvedToolScope | undefined;
    const turns = 1 + Math.floor(random() * 40);
    for (let turn = 0; turn < turns; turn += 1) {
      const effective = pick(random, RESOLVED);
      const send = shouldEmitToolScopeResolved(last, sessionId, effective);
      // The contract, restated independently of the implementation.
      const expected = previousSent === undefined || previousSent !== effective;
      assert.equal(send, expected, `run ${run} turn ${turn}: last=${previousSent} next=${effective}`);
      if (send) {
        last = { sessionId, effective };
        previousSent = effective;
      }
    }
    assert.notEqual(previousSent, undefined, `run ${run}: the first value must have been sent`);
  }
});

test('a different session does not inherit the previous value', () => {
  const last: ToolScopeEmissionState = { sessionId: 'sess_a', effective: 'full' };
  assert.equal(shouldEmitToolScopeResolved(last, 'sess_b', 'full'), true);
  assert.equal(shouldEmitToolScopeResolved(last, 'sess_a', 'full'), false);
  assert.equal(shouldEmitToolScopeResolved(last, 'sess_a', 'standard'), true);
});

test('random command + turn streams: emitted values are exactly the deduped sequence', () => {
  // Mirrors the bridge's own state machine: an explicit pick reports
  // immediately, `auto` only reports a concrete value, and both go through the
  // same dedupe. The recomputed turn is the resolveDesktopToolScope result, so
  // this also pins that an `auto` pick never invents a value early.
  const random = mulberry32(0x5eed_0002);
  const runtime = fakeRuntime('auto');
  let last: ToolScopeEmissionState;
  let previousSent: ResolvedToolScope | undefined;
  const sent: ResolvedToolScope[] = [];
  let sentNonString = 0;

  const emit = (effective: unknown) => {
    if (typeof effective !== 'string' || !RESOLVED.includes(effective as ResolvedToolScope)) {
      sentNonString += 1;
      return;
    }
    if (shouldEmitToolScopeResolved(last, runtime.session.id, effective as ResolvedToolScope)) {
      last = { sessionId: runtime.session.id, effective: effective as ResolvedToolScope };
      previousSent = effective as ResolvedToolScope;
      sent.push(effective as ResolvedToolScope);
    }
  };

  const prompts = ['读一下 package.json', '实现完整的登录功能并补测试', 'smoke multi-tool task', '/plan 重构目录'];
  for (let step = 0; step < 400; step += 1) {
    if (random() < 0.35) {
      const picked = pick(random, SCOPES);
      runtime.toolScope = picked;
      if (picked !== 'auto') {
        // Explicit pick clears the floor (desktopBridge set_tool_scope).
        runtime.sessionToolScopeFloor = undefined;
        emit(picked);
      } else {
        // `auto` reports nothing at pick time; the dedupe state is kept, so the
        // next turn emits only if it resolves to a different value.
      }
      continue;
    }
    const prompt = pick(random, prompts);
    const resolution = resolveDesktopToolScope(runtime, prompt, runtime.sessionToolScopeFloor);
    // In the real bridge the floor is agent.ts's answer; here the recomputation
    // stands in for it and is fed back exactly as agent.ts would.
    runtime.sessionToolScopeFloor = resolution.effective;
    const shouldSend = previousSent === undefined || previousSent !== resolution.effective;
    const before = sent.length;
    emit(resolution.effective);
    assert.equal(sent.length - before, shouldSend ? 1 : 0, `step ${step}: emission decision must follow the dedupe rule`);
  }

  assert.equal(sentNonString, 0, 'a non-resolved value must never be emitted');
  for (let i = 1; i < sent.length; i += 1) {
    assert.notEqual(sent[i], sent[i - 1], `duplicate consecutive emission at ${i}: ${sent.join(' -> ')}`);
  }
});

test('auto is monotonic across a random 100-turn session', () => {
  const random = mulberry32(0x5eed_0003);
  const prompts = [
    '读一下 package.json',
    '实现完整的登录功能并补测试',
    '帮我看看这个文件',
    'smoke multi-tool task',
    '/plan 重构目录',
    '修复这个 bug',
  ];
  let checkedTurns = 0;
  for (let session = 0; session < 100; session += 1) {
    const runtime = fakeRuntime('auto');
    let floor: ResolvedToolScope | undefined;
    let highest = 0;
    const steps = 2 + Math.floor(random() * 12);
    for (let step = 0; step < steps; step += 1) {
      const prompt = pick(random, prompts);
      const resolution = resolveDesktopToolScope(runtime, prompt, floor);
      // The API's promise, stated once: `resolveToolScope` with a previous
      // scope can never come back narrower than the floor.
      const parsed = resolveToolScope({
        requested: 'auto',
        reasoningEffort: 'off',
        prompt,
        shouldUseTaskBoard: false,
        previousScope: floor,
      });
      assert.equal(resolution.effective, parsed, `session ${session} step ${step}: recompute must match scope.ts`);
      if (floor !== undefined) {
        assert.ok(
          SCOPE_RANK[resolution.effective] >= SCOPE_RANK[floor],
          `session ${session} step ${step}: ${resolution.effective} narrowed below floor ${floor}`,
        );
      }
      highest = Math.max(highest, SCOPE_RANK[resolution.effective]);
      assert.equal(SCOPE_RANK[resolution.effective], highest, `session ${session} step ${step}: scope dipped after widening`);
      floor = resolution.effective;
      checkedTurns += 1;
    }
  }
  assert.ok(checkedTurns >= 100, `expected at least 100 turns, checked ${checkedTurns}`);
});

test('an explicit pick clears the floor, so the next auto turn may narrow once', () => {
  const random = mulberry32(0x5eed_0004);
  const runtime = fakeRuntime('full');
  let floor: ResolvedToolScope | undefined = 'full';
  let explicitPicks = 0;
  for (let step = 0; step < 200; step += 1) {
    const picked = pick(random, SCOPES);
    runtime.toolScope = picked;
    if (picked !== 'auto') {
      floor = undefined;
      explicitPicks += 1;
      const explicit = resolveDesktopToolScope(runtime, '实现完整的登录功能', floor);
      assert.equal(explicit.effective, picked, 'an explicit pick is returned verbatim, never floored');
      assert.equal(explicit.resolution, 'explicit');
      floor = explicit.effective;
      continue;
    }
    const prompt = '读一下 package.json';
    const resolution = resolveDesktopToolScope(runtime, prompt, floor);
    if (picked === 'auto') {
      // Whatever the floor was, the auto answer is at least as wide as the
      // per-turn signal and never below a floor that survived.
      const turnOnly = resolveToolScope({ requested: 'auto', reasoningEffort: 'off', prompt, shouldUseTaskBoard: false });
      assert.ok(SCOPE_RANK[resolution.effective] >= SCOPE_RANK[turnOnly]);
      floor = resolution.effective;
    }
  }
  assert.ok(explicitPicks > 0, 'the generator must have produced explicit picks');
});

test('the floor lets a cleared session narrow exactly once', () => {
  const runtime = fakeRuntime('auto');
  // One big task widens the session…
  const wide = resolveDesktopToolScope(runtime, '实现完整的登录功能并补测试', undefined);
  assert.equal(wide.effective, 'full');
  // …and a later small one must stay full (widen-only).
  assert.equal(resolveDesktopToolScope(runtime, '读一下 package.json', wide.effective).effective, 'full');
  // An explicit pick clears the floor; the next auto turn is allowed to narrow.
  runtime.toolScope = 'compact';
  const explicit = resolveDesktopToolScope(runtime, '读一下 package.json', undefined);
  assert.equal(explicit.effective, 'compact');
  runtime.toolScope = 'auto';
  assert.equal(resolveDesktopToolScope(runtime, '读一下 package.json', explicit.effective).effective, 'compact');
});

test('invalid values never reach the event payload', () => {
  const valid = new Set(['compact', 'standard', 'full']);
  const random = mulberry32(0x5eed_0005);
  const bogus = ['auto', '', 'FULL', 'readonly', null, undefined, 42, {}, []] as unknown[];
  for (let i = 0; i < 100; i += 1) {
    const runtime = fakeRuntime(pick(random, SCOPES));
    const resolution = resolveDesktopToolScope(runtime, '读一下 package.json', pick(random, [undefined, ...RESOLVED]));
    const payload = toolScopeResolvedPayload('sess_x', resolution);
    assert.equal(payload.type, TOOL_SCOPE_RESOLVED_EVENT);
    assert.ok(valid.has(String(payload.toolScope)), `toolScope must be resolved, got ${String(payload.toolScope)}`);
    assert.equal(typeof payload.requested, 'string');
    assert.ok(['auto', 'compact', 'standard', 'full'].includes(payload.requested));
    assert.equal(typeof payload.at, 'number');
  }
  // A garbage `requested` from config is treated as `auto` (the CLI's own
  // default), never forwarded verbatim.
  for (const value of bogus) {
    const runtime = fakeRuntime(value as ToolScope);
    const resolution = resolveDesktopToolScope(runtime, '读一下 package.json', undefined);
    assert.ok(valid.has(resolution.effective), `effective must be resolved for requested=${String(value)}`);
  }
});

/** Minimal runtime shape the resolver reads; no provider/agent needed. */
function fakeRuntime(toolScope: ToolScope) {
  const runtime: Pick<AgentRuntime, 'toolScope' | 'reasoningEffort' | 'config' | 'provider'> & {
    session: { id: string };
    sessionToolScopeFloor: ResolvedToolScope | undefined;
  } = {
    toolScope,
    reasoningEffort: 'off',
    config: { workspaceRoot: '.' } as AgentRuntime['config'],
    provider: { name: 'mock', model: 'mock-code-agent-v1' } as AgentRuntime['provider'],
    session: { id: 'sess_test' },
    sessionToolScopeFloor: undefined,
  };
  return runtime;
}

/** Poll a collected event list until the predicate holds (or the deadline). */
async function waitFor(
  events: Array<Record<string, unknown>>,
  predicate: (event: Record<string, unknown>) => boolean,
  timeoutMs = 30_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (events.some(predicate)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return events.some(predicate);
}

test('an in-process bridge emits the effective scope after a turn, exactly once per value', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-scope-protocol-'));
  const config: AppConfig = {
    provider: 'mock',
    model: 'mock-code-agent-v1',
    approval: 'auto',
    workspaceRoot: workspace,
    sessionDir: join(workspace, 'sessions'),
    noBanner: true,
    json: true,
  };
  const created = await createAgentRuntime(config);
  const runtime = created.runtime;
  // The real wiring under test: agent.ts must have recorded the floor by the
  // time the post-turn report runs, so this also catches the floor not being
  // set at all (the event would then be a pure recomputation).
  const events: Array<Record<string, unknown>> = [];
  const input = new PassThrough();
  const bridge = runDesktopBridge(runtime, { input, emit: (event) => events.push(event), approvalTimeoutMs: 5_000 });
  try {
    assert.ok(await waitFor(events, (event) => event.type === 'bridge_ready'), 'bridge must become ready');

    input.write(`${JSON.stringify({ type: 'user_message', text: '读一下 package.json', toolScope: 'auto' })}\n`);
    assert.ok(await waitFor(events, (event) => event.type === 'turn_done'), 'first turn must finish');

    const reported = events.filter((event) => event.type === TOOL_SCOPE_RESOLVED_EVENT);
    assert.equal(reported.length, 1, `first turn must report once: ${JSON.stringify(reported)}`);
    const first = reported[0];
    assert.equal(first.requested, 'auto');
    assert.equal(first.resolution, 'auto');
    assert.ok(['compact', 'standard', 'full'].includes(String(first.toolScope)), `unexpected scope ${String(first.toolScope)}`);
    assert.ok(runtime.sessionToolScopeFloor, 'agent.ts must have set the session floor for the turn');
    assert.equal(first.toolScope, runtime.sessionToolScopeFloor, 'the reported scope must be the one the turn ran with');

    // The same small prompt again: same effective value, so no second event.
    input.write(`${JSON.stringify({ type: 'user_message', text: '读一下 package.json', toolScope: 'auto' })}\n`);
    const doneAt = events.filter((event) => event.type === 'turn_done').length;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && events.filter((event) => event.type === 'turn_done').length <= doneAt) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      events.filter((event) => event.type === TOOL_SCOPE_RESOLVED_EVENT).length,
      1,
      'an unchanged effective scope must not be re-announced',
    );
  } finally {
    input.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
    input.end();
    await bridge.catch(() => {});
    await created.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('the payload carries exactly the fields pinned for the desktop', () => {
  const resolution: ToolScopeResolution = { effective: 'standard', requested: 'auto', resolution: 'auto', reason: 'complexity' };
  const payload = toolScopeResolvedPayload('sess_fields', resolution, 1700000000000);
  assert.deepEqual(Object.keys(payload), [...TOOL_SCOPE_EVENT_FIELDS], 'wire order and names are a cross-repo contract');
  assert.equal(payload.sessionId, 'sess_fields');
  assert.equal(payload.at, 1700000000000);
});

test('the reason names the signal that actually decided the scope', () => {
  /*
   * The first cut derived the reason from the REQUESTED effort, which is `off`
   * by default, so every auto resolution came back 'complexity' — including the
   * two the user most needs distinguished. These cases pin the classifier
   * against `resolveToolScopeForTurn` itself: for every generated input, the
   * reason must name a branch that would have produced the observed value on
   * its own, and no earlier branch may also explain it.
   */
  const EFFORTS = ['off', 'low', 'medium', 'high', 'max'] as const;
  const random = mulberry32(0x5eed_0007);
  const prompts = [
    '读一下 package.json',                       // small
    '把测试跑一遍并修复失败',                     // standard (write)
    '1. 读配置 2. 改入口 3. 跑测试',              // large (numbered steps)
    '/plan 实现登录',                             // large (plan command)
    '把整个仓库重构成模块化结构，先分析依赖再分阶段迁移，最后补测试', // large prose
  ];
  const reasons = new Set(['explicit', 'task-board', 'reasoning', 'complexity', 'floor']);
  for (let i = 0; i < 300; i += 1) {
    const prompt = pick(random, prompts);
    const effort = pick(random, EFFORTS);
    const previous = pick(random, [undefined, ...RESOLVED] as Array<ResolvedToolScope | undefined>);
    const taskBoard = random() < 0.3;
    const runtime = { ...fakeRuntime('auto'), reasoningEffort: effort };
    // A task board request is a runtime input, not a prompt one.
    const effective = resolveToolScope({
      reasoningEffort: effort,
      prompt,
      shouldUseTaskBoard: taskBoard,
      previousScope: previous,
    });
    const analysis = analyzeTaskComplexity(prompt);
    const capability = getReasoningCapability('mock', 'mock-code-agent-v1');
    const clamped = clampReasoningEffort(effort, capability, prompt, taskBoard);
    const floored = previous !== undefined && SCOPE_RANK[previous] > SCOPE_RANK[resolveToolScopeForTurn({
      reasoningEffort: clamped,
      prompt,
      shouldUseTaskBoard: taskBoard,
    })];
    const reason = classifyToolScopeReason({
      effective,
      taskBoard,
      effort: clamped,
      complexity: analysis.complexity,
      floored,
    });
    assert.ok(reasons.has(reason), `unknown reason ${reason}`);
    if (floored) {
      assert.equal(reason, 'floor', `a floored value must say so: prompt=${prompt} effort=${effort}`);
    } else if (taskBoard) {
      assert.equal(reason, 'task-board', `board must win without a floor: prompt=${prompt}`);
    } else if (clamped === 'high' || clamped === 'max') {
      assert.equal(reason, 'reasoning', `effort ${clamped} must be named, prompt=${prompt}`);
    } else {
      assert.equal(reason, 'complexity');
    }
    assert.equal(runtime.toolScope, 'auto');
  }
});

test('the reason distinguishes a board/size full from a reasoning full', () => {
  // Same answer, three different causes — the defect the field exists to fix.
  const large = '1. 读配置 2. 改入口 3. 跑测试';
  const board = resolveDesktopToolScope({ ...fakeRuntime('auto'), reasoningEffort: 'off' as const }, '随便看看', undefined);
  assert.equal(board.effective, 'compact');
  const size = resolveDesktopToolScope({ ...fakeRuntime('auto'), reasoningEffort: 'off' as const }, large, undefined);
  assert.equal(size.effective, 'full');
  assert.equal(size.reason, 'task-board', 'a large task is the board case in scope.ts');
  // A board prompt with no reasoning signal: the board is what forces full, and
  // it must be named as the board rather than as generic task size.
  const boardForced = classifyToolScopeReason({ effective: 'full', taskBoard: true, effort: 'off', complexity: 'small', floored: false });
  assert.equal(boardForced, 'task-board');
  // Only the classifier can name 'reasoning': the mock provider clamps every
  // effort to off, so this branch is unreachable through the resolver here.
  const reasoning = classifyToolScopeReason({ effective: 'full', taskBoard: false, effort: 'high', complexity: 'small', floored: false });
  assert.equal(reasoning, 'reasoning');
});

test('a floor is named as a floor even when this turn looks large', () => {
  const runtime = { ...fakeRuntime('auto'), reasoningEffort: 'off' as const };
  // 'full' from an earlier turn, this turn's prompt alone would say standard.
  const resolution = resolveDesktopToolScope(runtime, '把测试跑一遍并修复失败', 'full');
  assert.equal(resolution.effective, 'full');
  assert.equal(resolution.reason, 'floor', 'the widening cause must not be blamed on this turn');
});

test('the hook is the production path: agent.ts reports value and cause together', async () => {
  /*
   * The bridge used to derive the reason by recomputing the resolver. That
   * covers the happy path but misses every turn agent.ts starts on its own
   * (task board, automation, sub-agents), and it makes the UI's explanation a
   * guess about inputs rather than a record of what happened. The hook inverts
   * that: agent.ts reports the value it ran with and the cause it derived from
   * the answer. This drives a real turn through the real bridge and pins that
   * the emitted reason is the hook's, not a recomputation's — they can differ
   * only if the wiring regresses.
   */
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-scope-hook-'));
  const config: AppConfig = {
    provider: 'mock',
    model: 'mock-code-agent-v1',
    approval: 'auto',
    workspaceRoot: workspace,
    sessionDir: join(workspace, 'sessions'),
    noBanner: true,
    json: true,
  };
  const created = await createAgentRuntime(config);
  const runtime = created.runtime;
  const events: Array<Record<string, unknown>> = [];
  const input = new PassThrough();
  const bridge = runDesktopBridge(runtime, { input, emit: (event) => events.push(event), approvalTimeoutMs: 5_000 });
  try {
    assert.ok(await waitFor(events, (event) => event.type === 'bridge_ready'), 'bridge must become ready');
    input.write(`${JSON.stringify({ type: 'user_message', text: '读一下 package.json', toolScope: 'auto' })}\n`);
    assert.ok(await waitFor(events, (event) => event.type === 'turn_done'), 'turn must finish');

    const reported = events.filter((event) => event.type === TOOL_SCOPE_RESOLVED_EVENT);
    assert.equal(reported.length, 1);
    const reason = reported[0].reason;
    assert.ok(
      ['task-board', 'reasoning', 'complexity'].includes(String(reason)),
      `an auto turn must be explained by a turn signal, got ${String(reason)}`,
    );
    // The mock provider cannot reason, so this turn's own signals are the only
    // possible source — 'reasoning' would mean the requested effort leaked in.
    assert.notEqual(reason, 'reasoning');
    assert.equal(reported[0].resolution, 'auto');
    assert.equal(reported[0].requested, 'auto');
  } finally {
    input.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
    input.end();
    await bridge.catch(() => {});
    await created.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('an explicit pick is reported as explicit, with an explicit cause', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-scope-explicit-'));
  const config: AppConfig = {
    provider: 'mock',
    model: 'mock-code-agent-v1',
    approval: 'auto',
    workspaceRoot: workspace,
    sessionDir: join(workspace, 'sessions'),
    noBanner: true,
    json: true,
  };
  const created = await createAgentRuntime(config);
  const runtime = created.runtime;
  const events: Array<Record<string, unknown>> = [];
  const input = new PassThrough();
  const bridge = runDesktopBridge(runtime, { input, emit: (event) => events.push(event), approvalTimeoutMs: 5_000 });
  try {
    assert.ok(await waitFor(events, (event) => event.type === 'bridge_ready'), 'bridge must become ready');
    input.write(`${JSON.stringify({ type: 'user_message', text: '读一下 package.json', toolScope: 'standard' })}\n`);
    assert.ok(await waitFor(events, (event) => event.type === 'turn_done'), 'turn must finish');
    const reported = events.filter((event) => event.type === TOOL_SCOPE_RESOLVED_EVENT);
    assert.equal(reported.length, 1);
    assert.equal(reported[0].requested, 'standard');
    assert.equal(reported[0].toolScope, 'standard');
    assert.equal(reported[0].resolution, 'explicit');
    assert.equal(reported[0].reason, 'explicit');
  } finally {
    input.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
    input.end();
    await bridge.catch(() => {});
    await created.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
