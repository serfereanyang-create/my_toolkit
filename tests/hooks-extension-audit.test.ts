import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNoopHooks, DEFAULT_HOOK_TIMEOUT_MS, makeScriptableHooks, snapshotEvent } from '../src/hooks/hooks.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolDefinition, ToolContext } from '../src/tools/types.js';

function readTool(
  executed: Array<Record<string, unknown>>,
  risk: 'read' | 'write' = 'read',
): ToolDefinition<Record<string, unknown>> {
  return {
    name: 'probe_read',
    description: 'read-only probe',
    inputHint: '{}',
    risk,
    validate: (input) => (input ?? {}) as Record<string, unknown>,
    async execute(input) {
      executed.push(input);
      return { ok: true, output: `ran ${JSON.stringify(input)}` };
    },
  };
}

test('a throwing beforeTool vetoes the call and the tool never executes', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-hook-veto-'));
  try {
    const executed: Array<Record<string, unknown>> = [];
    const registry = ToolRegistry.fromTools([readTool(executed)]);
    const result = await registry.execute('probe_read', { path: 'a' }, {
      workspaceRoot: workspace,
      approval: 'auto',
      hooks: makeScriptableHooks({ beforeTool() { throw new Error('policy says no'); } }, { onHookError() {} }),
    });
    assert.equal(result.ok, false);
    assert.match(result.output, /policy says no/);
    assert.equal(executed.length, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a hook cannot resurrect a denied call, and it is not invoked at all', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-hook-deny-'));
  try {
    const executed: Array<Record<string, unknown>> = [];
    let called = false;
    // A write-tier tool so deny mode actually refuses it (read tools run
    // everywhere by design).
    const registry = ToolRegistry.fromTools([readTool(executed, 'write')]);
    const result = await registry.execute('probe_read', {}, {
      workspaceRoot: workspace,
      approval: 'deny',
      hooks: makeScriptableHooks({
        beforeTool() { called = true; return 'ALLOW' as unknown as void; },
      }),
    });
    assert.equal(result.ok, false);
    assert.match(result.output, /blocked/i);
    assert.equal(called, false);
    assert.equal(executed.length, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('hook return values are never read as an approval decision', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-hook-return-'));
  try {
    const executed: Array<Record<string, unknown>> = [];
    const registry = ToolRegistry.fromTools([readTool(executed)]);
    const result = await registry.execute('probe_read', {}, {
      workspaceRoot: workspace,
      approval: 'auto',
      hooks: { ...createNoopHooks(), beforeTool: async () => 'DENY' as unknown as void },
    });
    assert.equal(result.ok, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a hook mutating its event cannot change what the tool runs or what the caller sees', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-hook-mutate-'));
  try {
    const executed: Array<Record<string, unknown>> = [];
    const registry = ToolRegistry.fromTools([readTool(executed)]);
    const input = { path: 'approved.txt' };
    const result = await registry.execute('probe_read', input, {
      workspaceRoot: workspace,
      approval: 'auto',
      hooks: makeScriptableHooks({
        beforeTool(event) {
          // The event is a frozen snapshot: the write is rejected (ESM strict
          // mode) and, even if a host relaxed that, it could only touch the copy.
          assert.throws(() => {
            (event.input as Record<string, unknown>).path = 'C:/outside/pwned.txt';
          }, TypeError);
        },
        afterTool(event) {
          assert.throws(() => {
            if (event.result) event.result.output = 'rewritten by hook';
          }, TypeError);
        },
      }, { onHookError() {} }),
    });
    assert.deepEqual(executed[0], { path: 'approved.txt' });
    assert.deepEqual(input, { path: 'approved.txt' });
    assert.match(result.output, /approved\.txt/);
    assert.doesNotMatch(result.output, /rewritten by hook/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a hanging beforeTool is cut off at the timeout instead of wedging the turn', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-hook-hang-'));
  try {
    const executed: Array<Record<string, unknown>> = [];
    const registry = ToolRegistry.fromTools([readTool(executed)]);
    const started = Date.now();
    const result = await registry.execute('probe_read', {}, {
      workspaceRoot: workspace,
      approval: 'auto',
      hooks: makeScriptableHooks({ beforeTool: () => new Promise<void>(() => {}) }, { timeoutMs: 50, onHookError() {} }),
    });
    assert.equal(result.ok, false);
    assert.match(result.output, /timed out after 50ms/);
    assert.ok(Date.now() - started < 2_000);
    assert.equal(executed.length, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a failing afterTool is reported and swallowed so the real result survives', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-hook-after-'));
  try {
    const executed: Array<Record<string, unknown>> = [];
    const registry = ToolRegistry.fromTools([readTool(executed)]);
    const failures: string[] = [];
    const result = await registry.execute('probe_read', {}, {
      workspaceRoot: workspace,
      approval: 'auto',
      hooks: makeScriptableHooks({ afterTool() { throw new Error('after boom'); } }, { onHookError: (phase) => failures.push(phase) }),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(failures, ['afterTool']);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('snapshotEvent deep-freezes plain data and keeps class instances untouched', () => {
  const event = { tool: 'x', input: { nested: { list: [1, 2] } } };
  const frozen = snapshotEvent(event);
  assert.ok(Object.isFrozen(frozen));
  assert.ok(Object.isFrozen(frozen.input));
  assert.ok(Object.isFrozen((frozen.input as any).nested));
  assert.ok(Object.isFrozen((frozen.input as any).nested.list));
  event.input.nested.list.push(3);
  assert.deepEqual((frozen.input as any).nested.list, [1, 2], 'the snapshot is a copy');

  class Custom { value = 1; }
  const instance = new Custom();
  const withInstance = snapshotEvent({ tool: 'y', input: instance });
  assert.equal(withInstance.input, instance);
});

test('scriptable hooks use a bounded default timeout', () => {
  assert.ok(DEFAULT_HOOK_TIMEOUT_MS > 0 && DEFAULT_HOOK_TIMEOUT_MS <= 30_000);
});

test('randomized hook matrix: exact outcome per (phase, behaviour) pair', async () => {
  type Behaviour = 'ok' | 'throw' | 'hang' | 'garbage-return';
  const seed = 0xbadc0de;
  let state = seed >>> 0;
  const rand = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const behaviours: Behaviour[] = ['ok', 'throw', 'hang', 'garbage-return'];
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-hook-matrix-'));
  try {
    for (let index = 0; index < 60; index += 1) {
      const behaviour = behaviours[Math.floor(rand() * behaviours.length)]!;
      const failChance = rand();
      const impl = () => {
        if (behaviour === 'throw') throw new Error(`boom-${index}`);
        if (behaviour === 'hang') return new Promise<void>(() => {});
        if (behaviour === 'garbage-return') return 'DENY' as unknown as void;
        void failChance;
        return undefined;
      };
      const executed: Array<Record<string, unknown>> = [];
      const registry = ToolRegistry.fromTools([readTool(executed)]);
      const context: ToolContext = {
        workspaceRoot: workspace,
        approval: 'auto',
        hooks: makeScriptableHooks({ beforeTool: impl, afterTool: impl, onError: impl }, { timeoutMs: 30, onHookError() {} }),
      };
      try {
        const result = await registry.execute('probe_read', {}, context);
        if (behaviour === 'ok' || behaviour === 'garbage-return') {
          assert.equal(result.ok, true, `seed=${seed} case=${index} behaviour=${behaviour} failChance=${failChance}`);
          assert.equal(executed.length, 1);
        } else {
          assert.equal(result.ok, false, `seed=${seed} case=${index} behaviour=${behaviour}`);
          if (behaviour === 'throw') assert.match(result.output, new RegExp(`boom-${index}`));
          if (behaviour === 'hang') assert.match(result.output, /timed out after 30ms/);
        }
      } catch (error) {
        console.error(`seed=${seed} case=${index} behaviour=${behaviour}`);
        throw error;
      }
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
