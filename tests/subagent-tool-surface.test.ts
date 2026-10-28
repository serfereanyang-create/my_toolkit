import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runAgentTurn } from '../src/agent/agent.js';
import type { AgentRuntime } from '../src/agent/agent.js';
import type { AppConfig } from '../src/config/types.js';
import { expertById } from '../src/experts/profiles.js';
import type { Provider, ProviderRequest } from '../src/providers/types.js';
import { createAgentRuntime } from '../src/runtime/createRuntime.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { ToolRegistry } from '../src/tools/registry.js';
import {
  MAX_PROVIDER_TOOLS,
  limitProviderTools,
  selectScopedTools,
  type ResolvedToolScope,
} from '../src/tools/scope.js';
import type { ToolDefinition } from '../src/tools/types.js';
import { runSubAgent } from '../src/subagent/runner.js';
import { buildSubAgentTools, ROOT_ONLY_TOOLS, SUBAGENT_CORE_TOOLS, subAgentScope } from '../src/subagent/runner.js';
import { MAX_SUBAGENT_DEPTH } from '../src/subagent/tool.js';
import { runCodeReview } from '../src/review/reviewer.js';
import { isReadOnlyTool } from '../src/tools/scope.js';

/*
 * 子 agent 的工具面。
 *
 * 这里钉的是「子 agent 送进 provider 的工具集」而不是「构造它的方式」：
 *
 *   1. 子 agent 每轮请求的工具数 ≤ MAX_PROVIDER_TOOLS（与父会话同一个上限）。
 *   2. 子 agent 的工具数 ≤ 同 scope 下父会话的工具数。
 *   3. runtime.toolFilter（父会话再裁一层）对子 agent 同样生效。
 *   4. 按需注入的 root-only 工具（review_loop / propose_plan /
 *      supervisor_status / open_pull_request）不进入子 agent。
 *   5. 子 agent 保留干活必需的核心工具（Read/Write/Edit/Bash 类）。
 *   6. 递归深度仍有上限，超限是拒绝而不是无限递归。
 *
 * 探针先于修复实测（2026-10-28，363 个工具的默认注册表）：
 *   - compact 父会话（205）派生 general 子 agent，子 agent 拿到 205 个工具，
 *     且 review_loop / propose_plan / supervisor_status / open_pull_request
 *     全部在场；
 *   - 注册表塞到 523 时，父会话 340、子 agent 340，两边都靠 provider 层裁剪，
 *     子 agent 自己那层裁的是注入工具而不是它自己的工具集；
 *   - toolFilter 排除 write_file 时子 agent 确实没有 write_file（这条本来就
 *     传下去了，测试保留它防止回退）。
 */

const baseConfig = (workspace: string, patch: Partial<AppConfig> = {}): AppConfig => ({
  provider: 'mock',
  model: 'mock-code-agent-v1',
  approval: 'auto',
  workspaceRoot: workspace,
  sessionDir: `${workspace}/sessions`,
  noBanner: true,
  json: true,
  quiet: true,
  ...patch,
});

/** Deterministic PRNG (mulberry32). Seed is fixed and printed in the report. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const RANDOM_SEED = 0x5eed1234;
export const RANDOM_CASES = 144;
/**
 * End-to-end cases are a quarter of the unit ones: each child turn costs a
 * sub-session write plus a full turn setup (~160 ms), and the unit randomized
 * case already covers the same 144 combinations against the pure function.
 */
export const RANDOM_E2E_CASES = 36;

function fakeTool(n: number, risk: ToolDefinition['risk'] = 'read'): ToolDefinition {
  return {
    name: `fake_${String(n).padStart(3, '0')}`,
    description: `synthetic tool ${n} for the sub-agent tool-surface tests`,
    inputHint: '{}',
    risk,
    validate: (input: unknown) => input ?? {},
    async execute() {
      return { ok: true, output: '' };
    },
  };
}

function paddedRegistry(padding: number): ToolRegistry {
  const registry = createDefaultToolRegistry();
  for (let i = 0; i < padding; i += 1) registry.register(fakeTool(i));
  return registry;
}

const toolNames = (registry: ToolRegistry) => registry.list().map((tool) => tool.name);

/**
 * What the parent's own request would carry, replicated from agent.ts:716-810:
 * scoped selection, the depth-0 post-scope injections, the runtime filter, then
 * the 340 cap with the injected names protected. Used as the upper bound the
 * child is asserted against in the randomized unit cases.
 */
/**
 * What the parent's own request would carry, given the registry the parent
 * runtime already holds (scoped selection + depth-0 injections, see agent.ts).
 * The root turn's post-scope injected names are protected from the trim; the
 * root-only ones are not in the child's world at all, so they are removed from
 * both sides of the comparison.
 */
function parentRequestSize(
  parentRuntimeTools: ToolRegistry,
  filter?: (tool: Pick<ToolDefinition, 'name' | 'risk' | 'description'>) => boolean,
): number {
  const injected = new Set(['spawn_subagent', 'review_loop', 'propose_plan', 'supervisor_status', 'open_pull_request']);
  let tools = parentRuntimeTools.list().filter((tool) => !ROOT_ONLY_TOOLS.has(tool.name));
  if (filter) tools = tools.filter(filter);
  return limitProviderTools(tools, { protectedNames: injected }).tools.length;
}

/**
 * The exact surface the segment builder ships: root-only tools stripped, then
 * trimmed until it fits min(MAX_PROVIDER_TOOLS, the parent's delegated-from
 * size) — the ceiling, not the expert-filtered subset, exactly as runner.ts
 * computes it. Replicated here so the unit cases measure the final list.
 */
function finalNames(
  registry: ToolRegistry,
  options: {
    parentRuntime: { tools: ToolRegistry; allTools: ToolRegistry; resolvedToolScope?: ResolvedToolScope; toolFilter?: (tool: Pick<ToolDefinition, 'name' | 'risk' | 'description'>) => boolean };
    profile: { toolFilter: (tool: { name: string; risk: string; description: string }) => boolean };
  },
): string[] {
  const { parentRuntime } = options;
  const ceilingSize = parentRuntime.resolvedToolScope
    ? parentRuntime.tools.list().length
    : parentRuntime.allTools.list().filter((tool) => parentRuntime.toolFilter?.(tool) ?? true).length;
  const limit = Math.min(MAX_PROVIDER_TOOLS, ceilingSize);
  const kept = registry.list().filter((tool) => !ROOT_ONLY_TOOLS.has(tool.name));
  if (kept.length <= limit) return kept.map((tool) => tool.name);
  const core = new Set(kept.filter((tool) => SUBAGENT_CORE_TOOLS.has(tool.name)).map((tool) => tool.name));
  return limitProviderTools(kept, { max: limit, protectedNames: core }).tools.map((tool) => tool.name);
}

// ── 1. 不变量（构造层）────────────────────────────────────────────────────────

test('the child scope table: parent scope, then a standard floor for editors only', () => {
  const editor = expertById('code_edit')!;
  const reader = expertById('code_search')!;
  const general = expertById('general')!;
  const table: Array<[ResolvedToolScope, string, ResolvedToolScope]> = [
    ['compact', 'code_edit', 'standard'],
    ['compact', 'test_verify', 'standard'],
    ['compact', 'code_search', 'compact'],
    ['compact', 'general', 'standard'], // general can edit, so the floor applies
    ['standard', 'code_edit', 'standard'],
    ['full', 'code_search', 'full'],
  ];
  for (const [parent, expert, expected] of table) {
    const profile = expertById(expert)!;
    assert.equal(
      subAgentScope({ resolvedToolScope: parent }, profile),
      expected,
      `${expert} under ${parent}`,
    );
  }
  // No resolved scope yet: the expert's own override is the starting point, and
  // the same floor applies (code_edit declares standard, code_search compact).
  assert.equal(subAgentScope({ resolvedToolScope: undefined }, editor), 'standard');
  assert.equal(subAgentScope({ resolvedToolScope: undefined }, reader), 'compact');
  assert.equal(subAgentScope({ resolvedToolScope: undefined }, general), 'full');
  assert.ok(editor.toolFilter({ name: 'write_file', risk: 'write', description: '' }));
  assert.ok(!reader.toolFilter({ name: 'write_file', risk: 'write', description: '' }));
});

test('every scope × expert keeps the child at or under the provider cap', () => {
  const registry = createDefaultToolRegistry();
  const scopes: ResolvedToolScope[] = ['compact', 'standard', 'full'];
  const experts = ['general', 'code_edit', 'code_search', 'test_verify'];
  for (const expert of experts) {
    const profile = expertById(expert)!;
    for (const scope of scopes) {
      const built = buildSubAgentTools({
        parentRuntime: { tools: registry, allTools: registry, resolvedToolScope: undefined, toolFilter: undefined },
        profile,
        scope,
      });
      const count = built.registry.list().length;
      assert.ok(count <= MAX_PROVIDER_TOOLS, `${expert}/${scope}: ${count} > ${MAX_PROVIDER_TOOLS}`);
    }
  }
});

test('a child never receives a parent-denied non-core tool, and keeps its core tools', () => {
  const registry = createDefaultToolRegistry();
  const scopes: ResolvedToolScope[] = ['compact', 'standard', 'full'];
  // A tool the compact scope withholds and that is NOT core: delete_path.
  for (const scope of scopes) {
    for (const expert of ['general', 'code_edit', 'code_search']) {
      const profile = expertById(expert)!;
      const built = buildSubAgentTools({
        parentRuntime: { tools: registry, allTools: registry, resolvedToolScope: undefined, toolFilter: undefined },
        profile,
        scope,
      });
      // The final surface: strip root-only and pay for the restored core tools
      // by trimming, exactly as the segment builder does.
      const names = finalNames(built.registry, {
        parentRuntime: { tools: registry, allTools: registry, resolvedToolScope: undefined, toolFilter: undefined },
        profile,
      });
      if (scope === 'compact') {
        // compact plus an editor's standard floor would expose these only if
        // the ceiling were ignored; delete_path/git_init are never core, so
        // neither may appear for an editor or a reader.
        if (expert !== 'code_search') {
          assert.ok(!names.includes('delete_path'), `${expert}: delete_path leaked into a compact child`);
          assert.ok(!names.includes('git_init'), `${expert}: git_init leaked into a compact child`);
        }
      }
      const access = (name: string) => profile.toolFilter({
        name,
        risk: registry.get(name)?.risk ?? 'read',
        description: registry.get(name)?.description ?? '',
      });
      // The child is here to work: whatever core tool the expert accepts, it has.
      const expectedCore = [...SUBAGENT_CORE_TOOLS].filter((name) => registry.get(name) && access(name));
      const missing = expectedCore.filter((name) => !names.includes(name));
      assert.deepEqual(missing, [], `${expert}/${scope}: core tools withheld: ${missing.join(', ')}`);
      // code_edit and test_verify must be able to write and run; code_search must not.
      if (expert === 'code_edit') assert.ok(names.includes('write_file') && names.includes('apply_patch'));
      if (expert === 'test_verify') assert.ok(names.includes('run_command') && names.includes('run_tests'));
      if (expert === 'code_search') {
        assert.ok(names.includes('read_file'));
        assert.ok(!names.includes('write_file') && !names.includes('run_command'), 'code_search must stay read-only');
      }
    }
  }
});

test('root-only tools are stripped from the child; spawn_subagent is not', () => {
  const registry = createDefaultToolRegistry();
  // The parent's resolved set is what a parent in full would hold: the registry
  // already has the base review_loop and spawn_subagent.
  const parentTools = ToolRegistry.fromTools(selectScopedTools(registry, 'full'));
  assert.ok(parentTools.get('review_loop'), 'fixture: the parent holds review_loop');
  assert.ok(parentTools.get('spawn_subagent'));

  const built = buildSubAgentTools({
    parentRuntime: { tools: parentTools, allTools: registry, resolvedToolScope: 'full', toolFilter: undefined },
    profile: expertById('general')!,
    scope: 'full',
  });
  // The final surface the segment builder ships (root-only stripped, capped).
  const names = finalNames(built.registry, {
    parentRuntime: { tools: parentTools, allTools: registry, resolvedToolScope: 'full', toolFilter: undefined },
    profile: expertById('general')!,
  });
  assert.ok(!names.includes('review_loop'), 'review_loop must not reach a sub-agent');
  assert.ok(names.includes('spawn_subagent'), 'nesting is bounded by depth, not by removing the tool');
  // The other three never live in the registry (agent.ts injects them at
  // depth 0 only), so the ROOT_ONLY_TOOLS membership is what matters there.
  assert.deepEqual(
    [...ROOT_ONLY_TOOLS].sort(),
    ['open_pull_request', 'propose_plan', 'review_loop', 'supervisor_status'],
  );
});

test('a direct caller (no parent turn) is bounded too: task-board filter and a 523-tool registry', () => {
  const registry = paddedRegistry(160);
  assert.equal(registry.list().length, 523);
  // The task-board runtime's filter, made visible as it would be after a turn.
  const boardFilter = (tool: Pick<ToolDefinition, 'name' | 'risk' | 'description'>) => !tool.name.startsWith('fake_');
  const materialized = ToolRegistry.fromTools(registry.list().filter((tool) => boardFilter(tool)));
  const profile = expertById('test_verify')!;

  const built = buildSubAgentTools({
    // No resolved scope: this is runCodeReview / workflow from a REPL that has
    // not run a turn, or task/runtime.ts having swapped the expert in.
    parentRuntime: { tools: materialized, allTools: registry, resolvedToolScope: undefined, toolFilter: boardFilter },
    profile,
    scope: subAgentScope({ resolvedToolScope: undefined }, profile),
  });
  const names = toolNames(built.registry);
  assert.ok(names.length <= MAX_PROVIDER_TOOLS, `direct child sent ${names.length}`);
  assert.ok(names.every((name) => !name.startsWith('fake_')), 'the task-board filter reached the direct child');
  for (const core of ['read_file', 'write_file', 'apply_patch', 'run_command']) {
    assert.ok(names.includes(core), `direct child must keep ${core}`);
  }
});

test('the parent runtime toolFilter reaches the child even when the parent never resolved a turn', () => {
  const registry = createDefaultToolRegistry();
  const built = buildSubAgentTools({
    // resolvedToolScope undefined: the ceiling falls back to allTools, which is
    // exactly the state a directly-invoked review or workflow sub-agent is in.
    parentRuntime: {
      tools: registry,
      allTools: registry,
      resolvedToolScope: undefined,
      toolFilter: (tool) => tool.name !== 'write_file',
    },
    profile: expertById('code_edit')!,
    scope: 'full',
  });
  assert.ok(!toolNames(built.registry).includes('write_file'), 'the parent filter must reach the child');
});

// ── 2. 随机化 ────────────────────────────────────────────────────────────────

/**
 * An ASCII-only tool that answers the way `spawn_subagent` does when there is
 * no sub-agent runner: a refusal that ADVANCES the turn instead of re-issuing
 * the same call. This is the adversary a random invariant "child ≤ parent"
 * would otherwise miss — the end-to-end cap only exists in `runAgentTurnCore`
 * (agent.ts:793-810), not in `runSubAgent`, so a child with 120 executable
 * tools really does send 120 tools unless the runner caps it itself.
 */
function advanceProbeTool(): ToolDefinition {
  return {
    name: 'probe_step_advance',
    description: 'synthetic tool: echoes back and asks the model to finish',
    inputHint: '{}',
    risk: 'read',
    validate: (input: unknown) => input ?? {},
    async execute() {
      return { ok: true, output: 'proceed and answer now without calling another tool' };
    },
  };
}

test('randomized (end-to-end): the child provider request is ≤ cap and ≤ parent request, adversarially', async () => {
  const random = mulberry32(RANDOM_SEED);
  const scopes: ResolvedToolScope[] = ['compact', 'standard', 'full'];
  const experts = ['general', 'code_edit', 'code_search', 'test_verify'];
  // The probe's name contains no 'i', so an odd-padding "keep-even" filter can
  // never take it away from the child and make the adversarial step a no-op.
  assert.ok(!advanceProbeTool().name.includes('i'));

  // One runtime for all cases: each case resets the three fields a turn writes
  // (resolvedToolScope, sessionToolScopeFloor) and swaps the registry, so the
  // loop measures the runner, not session-store creation (144 fresh runtimes
  // took 24s; this is the same assertions at a fraction of the cost).
  await withRuntime({ maxSteps: 2 }, async (created) => {
    for (let caseIndex = 0; caseIndex < RANDOM_E2E_CASES; caseIndex += 1) {
      const parentScope = scopes[Math.floor(random() * scopes.length)]!;
      const padding = Math.floor(random() * 301);
      const filterOn = random() < 0.4;
      const expert = experts[Math.floor(random() * experts.length)]!;
      const step = caseIndex % 31;
      const label = `case ${caseIndex}: parent=${parentScope} padding=${padding} filter=${filterOn} expert=${expert} step=${step}`;

      const registry = paddedRegistry(padding);
      if (step !== 0) registry.register(advanceProbeTool());
      created.runtime.allTools = registry;
      created.runtime.tools = registry;
      created.runtime.toolScope = parentScope;
      created.runtime.resolvedToolScope = undefined;
      created.runtime.sessionToolScopeFloor = undefined;
      created.runtime.toolFilter = filterOn ? () => true : undefined;

      const requests: ProviderRequest[] = [];
      created.runtime.provider = {
        name: 'mock',
        model: 'mock-code-agent-v1',
        async complete(request) {
          requests.push(structuredClone({ ...request, onTextDelta: undefined, onThinkingDelta: undefined }));
          const isChild = JSON.stringify(request.messages).includes('sub work');
          if (isChild) {
            const last = String(request.messages.at(-1)?.content ?? '');
            if (last.includes('proceed and answer') || step === 0) {
              return { actions: [{ type: 'message', content: 'child done' }] };
            }
            return { actions: [{ type: 'tool', tool: 'probe_step_advance', input: {} }] };
          }
          return { actions: [{ type: 'message', content: 'parent leaf' }] };
        },
      };
      await runAgentTurn(created.runtime, 'parent turn');
      const parentRequest = requests.at(-1)!;
      await runSubAgent({ id: `r${caseIndex}-${Date.now()}`, expert, goal: 'sub work', maxSteps: 2 }, created.runtime, new Map());
      const childRequest = requests.at(-1)!;
      assert.ok(
        JSON.stringify(childRequest.messages).includes('sub work'),
        `${label}: the last request must be the child's (child provider was never reached)`,
      );

      assert.ok(parentRequest.tools.length <= MAX_PROVIDER_TOOLS, `${label}: parent ${parentRequest.tools.length}`);
      assert.ok(childRequest.tools.length <= MAX_PROVIDER_TOOLS, `${label}: child ${childRequest.tools.length} > cap`);
      assert.ok(
        childRequest.tools.length <= parentRequest.tools.length,
        `${label}: child ${childRequest.tools.length} > parent ${parentRequest.tools.length}`,
      );
    }
  });
});

test('randomized (unit): buildSubAgentTools keeps the child ≤ cap and ≤ parent across 144 combinations', () => {
  const random = mulberry32(RANDOM_SEED);
  const scopes: Array<ResolvedToolScope | 'auto'> = ['compact', 'standard', 'full', 'auto'];
  const experts = ['general', 'code_edit', 'code_search', 'test_verify', 'code_review'];
  let checked = 0;
  for (let i = 0; i < RANDOM_CASES; i += 1) {
    const parentScope = scopes[Math.floor(random() * scopes.length)]!;
    const padding = Math.floor(random() * 301); // 0..300 synthetic tools
    const filterMode = Math.floor(random() * 3); // none / keep-even / drop-write
    const taskBoard = random() < 0.5;
    const expert = experts[Math.floor(random() * experts.length)]!;
    const profile = expertById(expert);
    if (!profile) continue;

    const registry = paddedRegistry(padding);
    const filter: ((tool: Pick<ToolDefinition, 'name' | 'risk' | 'description'>) => boolean) | undefined = filterMode === 0
      ? undefined
      : filterMode === 1
        ? (tool) => !tool.name.startsWith('fake_') || Number(tool.name.slice(5)) % 2 === 0
        : (tool) => tool.risk !== 'write';

    // The parent's own turn resolves 'auto' through the task-board path (full)
    // or the compact path; the child inherits the parent's resolved value.
    const resolvedParent: ResolvedToolScope = parentScope === 'auto' ? (taskBoard ? 'full' : 'compact') : parentScope;
    // What the parent's runtime actually holds at delegation time: the scoped
    // selection plus the depth-0 post-scope injections. This, not the raw
    // registry, is the child's ceiling and the bound it is measured against.
    const parentRuntimeTools = ToolRegistry.fromTools([
      ...new Map([
        ...selectScopedTools(registry, resolvedParent),
        ...(registry.get('spawn_subagent') ? [registry.get('spawn_subagent')!] : []),
      ].map((tool) => [tool.name, tool])).values(),
    ]);
    const parentSize = parentRequestSize(parentRuntimeTools, filter);
    const parentRuntime = {
      tools: parentRuntimeTools,
      allTools: registry,
      resolvedToolScope: resolvedParent,
      // Same signature the runtime field declares (a Pick, not a full ToolDefinition).
      toolFilter: filter ? (tool: Pick<ToolDefinition, 'name' | 'risk' | 'description'>) => filter({ ...registry.get(tool.name)! }) : undefined,
    };

    const childScope = subAgentScope({ resolvedToolScope: resolvedParent, toolScope: parentScope }, profile);
    const built = buildSubAgentTools({ parentRuntime, profile, scope: childScope });
    // The builder's own output must already respect the provider ceiling, before
    // the segment-level trim below has a chance to paper over it.
    assert.ok(built.registry.list().length <= MAX_PROVIDER_TOOLS, `case ${i}: builder returned ${built.registry.list().length}`);
    const childCount = finalNames(built.registry, { parentRuntime, profile }).length;

    const label = `case ${i}: parent=${parentScope}->${resolvedParent} padding=${padding} filter=${filterMode} board=${taskBoard} expert=${expert}`;
    assert.ok(childCount <= MAX_PROVIDER_TOOLS, `${label}: child ${childCount} > cap ${MAX_PROVIDER_TOOLS}`);
    // The child may add SUBAGENT_CORE_TOOLS back, so the strict property is
    // "never more than the parent" — the core list is 14 tools, well under the
    // slack a real parent has; a child above the parent is a scope leak.
    assert.ok(childCount <= parentSize, `${label}: child ${childCount} > parent ${parentSize}`);
    checked += 1;
  }
  assert.equal(checked, RANDOM_CASES, 'every generated case must run');
});

// ── 3. 端到端：真正送进 provider 的数组 ──────────────────────────────────────

async function withRuntime(
  patch: Partial<AppConfig>,
  run: (created: Awaited<ReturnType<typeof createAgentRuntime>>) => Promise<void>,
  prepare?: (runtime: AgentRuntime) => void,
): Promise<void> {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-sub-tool-surface-'));
  const created = await createAgentRuntime(baseConfig(workspace, patch));
  try {
    prepare?.(created.runtime);
    await run(created);
  } finally {
    await created.close();
    await rm(workspace, { recursive: true, force: true });
  }
}

function recordingProvider(sink: ProviderRequest[]): Provider {
  return {
    name: 'mock',
    model: 'mock-code-agent-v1',
    async complete(request) {
      sink.push(structuredClone({ ...request, onTextDelta: undefined, onThinkingDelta: undefined }));
      return { actions: [{ type: 'message', content: 'leaf' }] };
    },
  };
}

test('e2e: a compact parent and its child both send ≤ 205, and the child has no root-only tool', async () => {
  await withRuntime({ toolScope: 'compact' }, async (created) => {
    const requests: ProviderRequest[] = [];
    created.runtime.provider = recordingProvider(requests);
    await runAgentTurn(created.runtime, 'hi');
    const parent = requests.at(-1)!;
    const parentFloor = created.runtime.sessionToolScopeFloor;
    const parentToolsBefore = created.runtime.tools.list().map((tool) => tool.name);
    await runSubAgent({ id: 'e2e', expert: 'general', goal: 'child work', maxSteps: 1 }, created.runtime, new Map());
    const child = requests.at(-1)!;
    const childNames = child.tools.map((tool) => tool.name);

    // The child's turn must not move the parent's scope floor or swap the
    // parent's tool registry (the spread used to inherit the floor VALUE; the
    // child now starts with its own pinned scope).
    assert.equal(created.runtime.sessionToolScopeFloor, parentFloor, 'the child turn moved the parent floor');
    assert.deepEqual(created.runtime.tools.list().map((tool) => tool.name), parentToolsBefore, 'the child turn swapped the parent registry');

    assert.equal(created.runtime.resolvedToolScope, 'compact');
    assert.ok(parent.tools.length <= MAX_PROVIDER_TOOLS);
    assert.ok(child.tools.length <= MAX_PROVIDER_TOOLS);
    assert.ok(child.tools.length <= parent.tools.length, `child ${child.tools.length} > parent ${parent.tools.length}`);
    for (const name of [...ROOT_ONLY_TOOLS]) assert.ok(!childNames.includes(name), `${name} reached the child`);
    // Tools the compact parent's own scope denies stay denied: the child gains
    // the work core, not delete_path or the git writers.
    for (const name of ['delete_path', 'git_init', 'git_reset']) {
      assert.ok(!childNames.includes(name), `the compact child gained ${name}`);
    }
    // The child is still able to do its job.
    for (const name of ['read_file', 'write_file', 'apply_patch', 'run_command', 'search_text']) {
      assert.ok(childNames.includes(name), `the child must keep ${name}`);
    }
  });
});

test('e2e: an oversized registry still sends ≤ 340 from the child', async () => {
  await withRuntime({ toolScope: 'full' }, async (created) => {
    const registry = paddedRegistry(160); // 523 tools, well over the cap
    created.runtime.allTools = registry;
    created.runtime.tools = registry;
    const requests: ProviderRequest[] = [];
    created.runtime.provider = recordingProvider(requests);
    await runAgentTurn(created.runtime, 'do a thing');
    const parent = requests.at(-1)!;
    await runSubAgent({ id: 'big', expert: 'general', goal: 'child work', maxSteps: 1 }, created.runtime, new Map());
    const child = requests.at(-1)!;

    assert.equal(registry.list().length, 523, 'fixture: the registry really is over the cap');
    assert.ok(parent.tools.length <= MAX_PROVIDER_TOOLS, `parent sent ${parent.tools.length}`);
    assert.ok(child.tools.length <= MAX_PROVIDER_TOOLS, `child sent ${child.tools.length}`);
    assert.ok(child.tools.length <= parent.tools.length, `child ${child.tools.length} > parent ${parent.tools.length}`);
  });
});

test('e2e: the parent toolFilter bounds the child as well', async () => {
  await withRuntime({ toolScope: 'full' }, async (created) => {
    created.runtime.toolFilter = (tool) => !tool.name.startsWith('fake_');
    const requests: ProviderRequest[] = [];
    created.runtime.provider = recordingProvider(requests);
    await runAgentTurn(created.runtime, 'do a thing');
    await runSubAgent({ id: 'f', expert: 'code_edit', goal: 'child work', maxSteps: 1 }, created.runtime, new Map());
    const child = requests.at(-1)!;
    assert.ok(child.tools.every((tool) => !tool.name.startsWith('fake_')), 'filtered tools reached the child');
    assert.ok(child.tools.some((tool) => tool.name === 'write_file'), 'the core write path survives the filter');
  });
});

test('e2e: a permissive filter plus a 500-tool registry is still sent at ≤ 340', async () => {
  await withRuntime({ toolScope: 'full' }, async (created) => {
    const registry = paddedRegistry(137); // 363 real + 137 synthetic = 500
    created.runtime.allTools = registry;
    created.runtime.tools = registry;
    // A filter that keeps everything is the adversarial case: it must not be a
    // reason to skip the cap.
    created.runtime.toolFilter = () => true;
    const requests: ProviderRequest[] = [];
    created.runtime.provider = recordingProvider(requests);
    await runAgentTurn(created.runtime, 'do a thing');
    const parent = requests.at(-1)!;
    await runSubAgent({ id: 'cap', expert: 'general', goal: 'child work', maxSteps: 1 }, created.runtime, new Map());
    const child = requests.at(-1)!;
    assert.equal(registry.list().length, 500);
    assert.equal(parent.tools.length, MAX_PROVIDER_TOOLS, 'the root turn caps at 340');
    assert.ok(child.tools.length <= MAX_PROVIDER_TOOLS, `child sent ${child.tools.length}`);
    assert.ok(child.tools.length <= parent.tools.length, `child ${child.tools.length} > parent ${parent.tools.length}`);
  });
});

// ── 4. 递归深度 ──────────────────────────────────────────────────────────────

test('a child can spawn, the chain stops at the depth limit with a refusal, not infinite recursion', async () => {
  await withRuntime({ computerAnyApp: true, maxSteps: 3 }, async (created) => {
    const requests: ProviderRequest[] = [];
    created.runtime.provider = {
      name: 'mock',
      model: 'mock-code-agent-v1',
      async complete(request) {
        requests.push(structuredClone({ ...request, onTextDelta: undefined, onThinkingDelta: undefined }));
        const text = JSON.stringify(request.messages);
        if (text.includes('嵌套深度上限') || text.includes('子智能体执行完成')) {
          return { actions: [{ type: 'message', content: 'chain stopped' }] };
        }
        if (request.tools.some((tool) => tool.name === 'spawn_subagent')) {
          return {
            actions: [{
              type: 'tool',
              tool: 'spawn_subagent',
              input: { subagents: [{ id: `lv${requests.length}`, goal: 'DEPTH child', expert: 'general' }] },
            }],
          };
        }
        return { actions: [{ type: 'message', content: 'leaf' }] };
      },
    };

    await runAgentTurn(created.runtime, 'start the depth chain');

    const refusals = requests.filter((request) => JSON.stringify(request.messages).includes('嵌套深度上限'));
    assert.equal(refusals.length, 1, 'exactly one node is refused at the limit');
    assert.match(JSON.stringify(refusals[0]!.messages), new RegExp(`已达嵌套深度上限（${MAX_SUBAGENT_DEPTH} 层，当前 ${MAX_SUBAGENT_DEPTH} 层）`));
    // Three child segments actually ran (depth 1..3); the depth-3 one is the
    // node that tried a fourth call. The bound is an execution-time refusal,
    // not a silently pruned list: the refused request was still OFFERED the
    // tool (subagent-boundary.test.ts asserts the same at its own level).
    // Three child segments actually ran (depths 1..3); the depth-3 one is the
    // node that tried a fourth call. The bound is an execution-time refusal,
    // not a silently pruned list: the refused request was still OFFERED the
    // tool (subagent-boundary.test.ts asserts the same at its own level).
    // (Per-run ids are not collected here: the mock records the same id for
    // every nested spawn, so the boundary test's emit counter is the assertion
    // of record for "how many nested runs happened".)
    assert.ok(refusals[0]!.tools.some((tool) => tool.name === 'spawn_subagent'), 'the refused node still saw the tool');
    // And no session recursed past the limit: every request came from the root
    // plus those three child segments.
    assert.ok(requests.length <= 1 + MAX_SUBAGENT_DEPTH * 3, `unexpected recursion: ${requests.length} requests`);
  });
});

// ── 5. review 子会话（/review → runCodeReview → runSubAgent(code_review)）────
//
// 这里钉的是「审查者实际送进 provider 的工具数组」，不是 profile 函数：
// review-readonly.test.ts 已经证明了 codeReviewExpert.toolFilter 只放行
// isReadOnlyTool，但它没有经过 runner 的 ceiling / scope / core-restore / cap
// 那条链。链上任何一步（例如把 core 工具无条件恢复、或把 parent 的写工具
// 原样传下去）都会让「只读审查」变成空话，而 profile 测试仍然全绿。
//
// 探针实测（2026-10-29，工作树）：
//   - 默认注册表 363：review 子会话 197 个工具，全部 risk=read；
//   - 523 工具注册表、无父 turn：197 个，仍全部 read；
//   - full 父 turn 之后：294 个（父 scope 的只读子集），全部 read；
//   - spawn_subagent / review_loop / workflow_* 均缺席。

async function reviewRequest(
  created: Awaited<ReturnType<typeof createAgentRuntime>>,
  prepare?: (runtime: AgentRuntime) => void,
): Promise<ProviderRequest['tools']> {
  const requests: ProviderRequest[] = [];
  created.runtime.provider = {
    name: 'mock',
    model: 'mock-code-agent-v1',
    async complete(request) {
      requests.push(structuredClone({ ...request, onTextDelta: undefined, onThinkingDelta: undefined }));
      return { actions: [{ type: 'message', content: '{"findings":[],"overall_correctness":"correct"}' }] };
    },
  };
  prepare?.(created.runtime);
  const result = await runCodeReview({
    runtime: created.runtime,
    id: 'review-probe',
    target: { target: { kind: 'uncommitted' }, label: 'probe', diff: 'diff --git a/x b/x\n+1', files: ['x'], truncated: false },
  });
  assert.ok(result.ok, `the review must run so the request can be inspected: ${result.error ?? ''}`);
  return requests.at(-1)!.tools;
}

test('review sub-session: no write/shell/delegating tool, and under the cap', async () => {
  await withRuntime({ toolScope: 'full' }, async (created) => {
    // 523 工具注册表：审查者的 cap 走的是它自己的 runner 链，与父会话无关。
    const registry = paddedRegistry(160);
    const tools = await reviewRequest(created, (runtime) => {
      runtime.allTools = registry;
      runtime.tools = registry;
      runtime.resolvedToolScope = undefined;
      runtime.sessionToolScopeFloor = undefined;
    });
    assert.equal(registry.list().length, 523, 'fixture: the registry really is over the cap');
    assert.ok(tools.length <= MAX_PROVIDER_TOOLS, `review sent ${tools.length}`);

    // isReadOnlyTool, not risk === 'read': spawn_subagent carries risk 'read'
    // in some revisions and can still start a writer, so both checks are made.
    const offenders = tools.filter((tool) => !isReadOnlyTool(tool));
    assert.deepEqual(
      offenders.map((tool) => `${tool.name}(${tool.risk})`),
      [],
      'a reviewer that can write, run or delegate is no longer a read-only review',
    );
    for (const name of ['write_file', 'append_file', 'edit_lines', 'apply_patch', 'run_command',
      'spawn_subagent', 'review_loop', 'workflow_execute', 'workflow_resume', 'open_pull_request']) {
      assert.ok(!tools.some((tool) => tool.name === name), `${name} reached the reviewer`);
    }
    // It must still be able to do the job.
    for (const name of ['read_file', 'search_text', 'git_diff']) {
      assert.ok(tools.some((tool) => tool.name === name), `the reviewer lost ${name}`);
    }
  });
});

test('review sub-session after a full-scope parent turn: same read-only surface', async () => {
  await withRuntime({ toolScope: 'full' }, async (created) => {
    const requests: ProviderRequest[] = [];
    created.runtime.provider = {
      name: 'mock',
      model: 'mock-code-agent-v1',
      async complete(request) {
        requests.push(structuredClone({ ...request, onTextDelta: undefined, onThinkingDelta: undefined }));
        return { actions: [{ type: 'message', content: 'leaf' }] };
      },
    };
    await runAgentTurn(created.runtime, 'inspect the tree');
    const parent = requests.at(-1)!;
    await runCodeReview({
      runtime: created.runtime,
      id: 'review-after-turn',
      target: { target: { kind: 'uncommitted' }, label: 'probe', diff: 'd', files: ['x'], truncated: false },
    });
    const review = requests.at(-1)!;
    assert.equal(created.runtime.resolvedToolScope, 'full');
    assert.ok(parent.tools.length <= MAX_PROVIDER_TOOLS);
    assert.ok(review.tools.length <= MAX_PROVIDER_TOOLS, `review sent ${review.tools.length}`);
    assert.deepEqual(
      review.tools.filter((tool) => !isReadOnlyTool(tool)).map((tool) => tool.name),
      [],
      'the full-scope parent leaked a write/delegating tool into the reviewer',
    );
  });
});

// ── 6. 子 agent 的「工具使用约定」（C 的提示部分）────────────────────────────
//
// 旧提示只有「## 你的角色 + ## 当前任务」两段散文，模型据此把「先读再改 /
// 改完跑测试 / 跨文件并行拆分」当作角色设定以外的事。这一块由实际工具集生成：
// 只读角色不会被要求跑测试，也不会被告知可以 spawn。
import { subAgentToolGuidance } from '../src/subagent/runner.js';

test('tool guidance is generated from what the child actually has', () => {
  const general = subAgentToolGuidance(
    ['read_file', 'search_text', 'write_file', 'apply_patch', 'run_command', 'run_tests', 'spawn_subagent']
      .map((name) => ({ name })),
  );
  assert.match(general, /先读再改/);
  // Only the verifiers actually present are named: telling a child to run
  // `lint` when it has no lint tool is the same lie as telling it to delegate
  // without spawn_subagent, just with a longer fuse.
  assert.match(general, /改完自检：用 run_tests 跑一遍/);
  assert.doesNotMatch(general, /typecheck|lint/);
  assert.match(general, /spawn_subagent/);
  assert.match(general, /TASK_DONE/);

  const reader = subAgentToolGuidance(['read_file', 'search_text', 'git_diff'].map((name) => ({ name })));
  assert.match(reader, /本角色只读/);
  assert.match(reader, /先读再答/, 'a read-only role is not told to edit after reading');
  assert.doesNotMatch(reader, /run_tests \/ typecheck/);
  assert.doesNotMatch(reader, /spawn_subagent/, 'a child without the tool must not be told to delegate');
  // 「只读」这一行会提到「没有写文件的能力」，但不得给出改文件的指令。
  assert.doesNotMatch(reader, /改动尽量小/);
});

test('the guidance matches how the child can actually verify its own work', () => {
  // run_command without a test runner: the old text told it to "run the project's
  // verification command", which in practice produced invented commands.
  const shell = subAgentToolGuidance(
    ['read_file', 'write_file', 'run_command'].map((name) => ({ name })),
  );
  assert.match(shell, /自检只能用 run_command/);
  assert.match(shell, /不要凭空编一条命令/);
  assert.match(shell, /不要声称跑过测试/);

  // A real test runner present: name it, do not hedge.
  const tester = subAgentToolGuidance(
    ['read_file', 'write_file', 'run_tests', 'lint'].map((name) => ({ name })),
  );
  assert.match(tester, /改完自检：用 run_tests \/ lint 跑一遍/);
  assert.doesNotMatch(tester, /不要声称跑过测试/);

  // Run-only: may gather evidence, may not change files.
  const runner = subAgentToolGuidance(['read_file', 'run_command'].map((name) => ({ name })));
  assert.match(runner, /本角色不改文件/);
  assert.doesNotMatch(runner, /改动尽量小/);

  // Every branch ends with the same protocol line, and none of them claim a
  // capability the surface lacks.
  for (const names of [
    ['read_file'],
    ['read_file', 'write_file'],
    ['read_file', 'run_command'],
    ['read_file', 'write_file', 'run_command', 'spawn_subagent'],
    ['read_file', 'write_file', 'run_tests', 'spawn_subagent'],
  ]) {
    const text = subAgentToolGuidance(names.map((name) => ({ name })));
    assert.match(text, /TASK_DONE/, `missing handoff line for ${names.join(',')}`);
    if (!names.includes('write_file')) assert.doesNotMatch(text, /改动尽量小/);
    if (!names.includes('spawn_subagent')) assert.doesNotMatch(text, /spawn_subagent/);
    if (!names.includes('run_command') && !names.includes('run_tests')) {
      assert.doesNotMatch(text, /自检只能用 run_command/);
    }
  }
});

test('the guidance block is in the prompt between the role and the task, from the real surface', async () => {
  await withRuntime({ toolScope: 'standard' }, async (created) => {
    const requests: ProviderRequest[] = [];
    created.runtime.provider = {
      name: 'mock',
      model: 'mock-code-agent-v1',
      async complete(request) {
        requests.push(structuredClone({ ...request, onTextDelta: undefined, onThinkingDelta: undefined }));
        return { actions: [{ type: 'message', content: 'leaf' }] };
      },
    };
    await runSubAgent({ id: 'guide-general', expert: 'general', goal: 'GUIDE child', maxSteps: 1 }, created.runtime, new Map());
    const generalText = JSON.stringify(requests.at(-1)!.messages);
    assert.ok(generalText.includes('## 工具使用约定'), 'the child prompt must carry the tool conventions');
    assert.ok(generalText.indexOf('## 你的角色') < generalText.indexOf('## 工具使用约定'));
    assert.ok(generalText.indexOf('## 工具使用约定') < generalText.indexOf('## 当前任务'));

    await runSubAgent({ id: 'guide-reader', expert: 'code_search', goal: 'READER child', maxSteps: 1 }, created.runtime, new Map());
    const readerText = JSON.stringify(requests.at(-1)!.messages);
    const readerTools = requests.at(-1)!.tools.map((tool) => tool.name);
    assert.ok(!readerTools.includes('write_file') && !readerTools.includes('run_command'));
    assert.ok(readerText.includes('本角色只读'), 'the reader is told it cannot write');
    assert.ok(!readerText.includes('用 spawn_subagent'), 'the reader is not told to delegate');
  });
});
