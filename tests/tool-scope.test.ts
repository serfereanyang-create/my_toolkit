import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import {
  AGENT_SPAWNING_TOOLS,
  DELEGATION_TOOLS,
  MAX_PROVIDER_TOOLS,
  canSpawnAgent,
  isReadOnlyTool,
  limitProviderTools,
  resolveToolScope,
  selectScopedTools,
} from '../src/tools/scope.js';

function names(scope: 'compact' | 'standard' | 'full') {
  return selectScopedTools(createDefaultToolRegistry(), scope).map((tool) => tool.name);
}

test('resolveToolScope maps auto mode from task size and reasoning effort', () => {
  assert.equal(resolveToolScope({ requested: 'auto', prompt: '读取 package.json', shouldUseTaskBoard: false, reasoningEffort: 'off' }), 'compact');
  assert.equal(resolveToolScope({ requested: 'auto', prompt: '实现完整登录流程并补测试', shouldUseTaskBoard: true, reasoningEffort: 'low' }), 'full');
  assert.equal(resolveToolScope({ requested: 'auto', prompt: 'update config and adjust docs', shouldUseTaskBoard: false, reasoningEffort: 'medium' }), 'standard');
  assert.equal(resolveToolScope({ requested: 'auto', prompt: 'open file', shouldUseTaskBoard: false, reasoningEffort: 'high' }), 'full');
});

test('manual tool scope override wins over auto mapping', () => {
  assert.equal(resolveToolScope({ requested: 'compact', prompt: '实现完整登录流程并补测试', shouldUseTaskBoard: true, reasoningEffort: 'max' }), 'compact');
  assert.equal(resolveToolScope({ requested: 'full', prompt: '读取 package.json', shouldUseTaskBoard: false, reasoningEffort: 'off' }), 'full');
});

/*
 * The tool array is serialized before the system block and inside the cached
 * prompt prefix, so any change to it invalidates the cache from byte 0. Scope is
 * resolved from the turn's PHRASE, so without a floor it flaps and kills the
 * cache; it also means what the agent could do last turn it might not do this
 * turn. The floor makes the session monotonic: widen only.
 */
test('a session never narrows its tool scope', () => {
  const small = { requested: 'auto' as const, reasoningEffort: 'auto' as const, shouldUseTaskBoard: false };
  // Turn 1 is a plain question → standard.
  const first = resolveToolScope({ ...small, prompt: '这个项目是干什么的' });
  assert.equal(first, 'standard');

  // Turn 2 is a one-line lookup, which on its own would drop to compact. The
  // floor keeps it at standard, so the tool array does not change.
  const second = resolveToolScope({ ...small, prompt: '读一下 package.json', previousScope: first });
  assert.equal(second, 'standard');

  // And it stays put on later small talk.
  assert.equal(resolveToolScope({ ...small, prompt: '谢谢', previousScope: second }), 'standard');
});

test('the floor does not stop a session from widening', () => {
  const base = { requested: 'auto' as const, reasoningEffort: 'auto' as const, shouldUseTaskBoard: false };
  const compact = resolveToolScope({ ...base, prompt: '读取 package.json' });
  assert.equal(compact, 'compact');
  const widened = resolveToolScope({ ...base, prompt: '实现完整登录流程并补测试', previousScope: compact });
  assert.equal(widened, 'full');
});

test('an explicit scope choice is not floored', () => {
  // The desktop scope picker is the user speaking. Floors exist to stop the
  // scope drifting on its own, not to override a deliberate choice.
  const picked = resolveToolScope({
    requested: 'compact', prompt: '实现完整登录流程并补测试', shouldUseTaskBoard: true, reasoningEffort: 'max', previousScope: 'full',
  });
  assert.equal(picked, 'compact');
});

test('the floored scope keeps the tool array byte-identical across turns', () => {
  // The whole point: same fingerprint, so the cached prefix survives.
  const reg = createDefaultToolRegistry();
  const base = { requested: 'auto' as const, reasoningEffort: 'auto' as const, shouldUseTaskBoard: false };
  const prompts = ['这个项目是干什么的', '读一下 package.json', '谢谢', '帮我看看这个函数'];
  let floor: ReturnType<typeof resolveToolScope> | undefined;
  const sizes = prompts.map((prompt) => {
    floor = resolveToolScope({ ...base, prompt, previousScope: floor });
    return selectScopedTools(reg, floor).length;
  });
  assert.equal(new Set(sizes).size, 1, `tool count changed across turns: ${sizes.join(' -> ')}`);
});

test('compact and standard scopes expose progressively larger registries', () => {
  const compact = names('compact');
  const standard = names('standard');
  const full = names('full');

  assert.ok(compact.length < standard.length);
  assert.ok(standard.length < full.length);

  assert.ok(compact.includes('read_file'));
  assert.ok(compact.includes('git_status'));
  assert.ok(compact.includes('git_diff'));
  assert.ok(!compact.includes('run_command'));
  assert.ok(!compact.includes('git_commit'));

  assert.ok(standard.includes('write_file'));
  assert.ok(standard.includes('apply_patch'));
  assert.ok(standard.includes('git_commit'));
  assert.ok(standard.includes('git_add'));
  assert.ok(standard.includes('run_command'));

  assert.ok(full.includes('run_command'));
  assert.ok(full.includes('git_commit'));
});

test('compact can still do web reading, which is what a lookup prompt asks for', () => {
  // "打开 https://... 找一篇论文" is classified small, so it runs in compact.
  // Without these three the agent literally cannot do what it was asked, which
  // is the reported failure: the tools to download and analyse material were
  // missing. They stay behind the network gate in decideApproval.
  const compact = names('compact');
  assert.ok(compact.includes('fetch_url'));
  assert.ok(compact.includes('web_search'));
  assert.ok(compact.includes('download_file'));
  assert.ok(compact.includes('pdf_to_text'));
  // Downloading writes, so compact still must not expose arbitrary writes.
  assert.ok(!compact.includes('write_file'));
  assert.ok(!compact.includes('run_command'));
});

test('limitProviderTools passes a small list through untouched', () => {
  const tools = createDefaultToolRegistry().list().slice(0, 5);
  const result = limitProviderTools(tools, { max: 10 });
  assert.equal(result.tools.length, 5);
  assert.deepEqual(result.dropped, []);
});

test('limitProviderTools caps oversized lists below the provider ceiling', () => {
  const all = createDefaultToolRegistry().list();
  assert.ok(all.length > MAX_PROVIDER_TOOLS, 'registry must exceed the cap for this test to be meaningful');
  const result = limitProviderTools(all);
  assert.equal(result.tools.length, MAX_PROVIDER_TOOLS);
  assert.equal(result.dropped.length, all.length - MAX_PROVIDER_TOOLS);
  assert.ok(MAX_PROVIDER_TOOLS < 350, 'must stay under the common 350 provider limit');
});

test('limitProviderTools keeps the working core instead of cutting alphabetically', () => {
  const all = createDefaultToolRegistry().list();
  const result = limitProviderTools(all);
  const kept = new Set(result.tools.map((tool) => tool.name));
  // Alphabetical truncation would drop these (late letters); the agent cannot
  // work without them, so they must survive the cap.
  for (const essential of ['write_file', 'apply_patch', 'run_command', 'search_text', 'read_file', 'git_commit', 'typecheck', 'web_search']) {
    assert.ok(kept.has(essential), `expected ${essential} to survive the cap`);
  }
});

test('limitProviderTools omits bridge tools before built-ins', () => {
  // The default registry has no plugin_/mcp_ tools, so synthesize a registry
  // where the bridge block is what pushes the count over the ceiling. The base
  // is cut to 300 real tools so that only the bridge block can exceed the cap —
  // `max` can never be raised to make room for the base (it is clamped to
  // MAX_PROVIDER_TOOLS since the 2026-10-29 tool-surface audit).
  const base = createDefaultToolRegistry().list().slice(0, 300);
  const bridge = Array.from({ length: 60 }, (_, index) => ({
    ...base[0]!,
    name: `plugin_extra_${String(index).padStart(2, '0')}`,
  }));
  const requested = MAX_PROVIDER_TOOLS;
  const result = limitProviderTools([...base, ...bridge], { max: requested });
  assert.equal(result.tools.length, requested);
  const droppedBridge = result.dropped.filter((name) => name.startsWith('plugin_') || name.startsWith('mcp_'));
  assert.equal(droppedBridge.length, result.dropped.length, 'every omitted tool should be a bridge tool');
  assert.equal(droppedBridge.length, base.length + bridge.length - requested);
});

test('limitProviderTools never trims a protected tool', () => {
  // spawn_subagent / review_loop / computer tools are registered AFTER scope
  // selection; the cap runs last and must keep them even when they sort late.
  const base = createDefaultToolRegistry().list();
  const injected = [
    { ...base[0]!, name: 'zzz_spawn_subagent' },
    { ...base[0]!, name: 'zzz_review_loop' },
  ];
  const result = limitProviderTools([...base, ...injected], {
    max: 20,
    protectedNames: new Set(['zzz_spawn_subagent', 'zzz_review_loop']),
  });
  const kept = new Set(result.tools.map((tool) => tool.name));
  assert.ok(kept.has('zzz_spawn_subagent'), 'protected tool must survive');
  assert.ok(kept.has('zzz_review_loop'), 'protected tool must survive');
  assert.equal(result.tools.length, 20);
});

test('capping after injection keeps the serialized count under the ceiling', () => {
  // Regression: the cap used to run BEFORE the post-scope injections, so those
  // tools pushed the outbound array back over the provider limit and every turn
  // 400'd. Simulate the real order: scope -> inject -> cap.
  const base = createDefaultToolRegistry().list();
  const injected = ['spawn_subagent', 'review_loop', 'computer_screenshot', 'computer_click']
    .map((name) => ({ ...base[0]!, name }));
  const protectedNames = new Set(injected.map((tool) => tool.name));
  const result = limitProviderTools([...base, ...injected], { protectedNames });
  assert.ok(result.tools.length <= MAX_PROVIDER_TOOLS, `serialized ${result.tools.length} exceeds cap`);
  assert.ok(MAX_PROVIDER_TOOLS < 350);
  const kept = new Set(result.tools.map((tool) => tool.name));
  for (const name of protectedNames) assert.ok(kept.has(name), `${name} must survive`);
});

/*
 * standard is the default scope, so a tool missing here is a tool the agent
 * works around with a shell command. The allowlists are an enumeration and had
 * drifted: 127 of 363 tools were absent from standard, 92 of them read-only.
 * read-only is now the axis rather than a name list.
 */
test('standard reaches read-only analysis tools without naming each one', () => {
  const standard = names('standard');
  for (const tool of ['semantic_search', 'repo_map', 'codebase_search', 'explain_code', 'find_similar_code', 'review_code', 'health_report']) {
    assert.ok(standard.includes(tool), `expected standard to expose ${tool}`);
  }
});

/*
 * Delegation used to be excluded from standard on the grounds that "delegation
 * is a deliberate choice, not a default". That changed for exactly two tools:
 * without spawn_subagent a large file set can only be read serially, and
 * without review_loop nothing reviews the session's output from outside it.
 * Two schemas for parallel reading plus an independent review pass is the
 * better default.
 *
 * The exception is scoped to delegation and does NOT extend to workflow. Same
 * risk shape (a call that starts agents, so `risk` alone is not the whole
 * story), different purpose: spawn_subagent/review_loop are ways to do this
 * task faster or better, while workflow_execute/workflow_resume replay a stored
 * plan unattended — a mode switch, not a reading strategy. Nothing in a default
 * scope's job needs it, so it would cost schemas and buy no behaviour. It also
 * keeps the rule honest: every entry point that runs a plan without a human
 * watching stays behind an explicit scope choice.
 *
 * The read-only claim itself is unchanged — isReadOnlyTool still subtracts all
 * of AGENT_SPAWNING_TOOLS, which is what the read-only experts and reviewers
 * rely on (tests/review-readonly.test.ts). Standard's exception is an allowlist
 * applied on top, not a redefinition of read-only.
 */
test('standard refuses direct writes, but exposes the two delegation tools', () => {
  const standard = names('standard');
  const reg = createDefaultToolRegistry();
  const byName = new Map(reg.list().map((tool) => [tool.name, tool]));

  // Genuine writes and execution stay behind the allowlists.
  for (const tool of ['delete_path', 'rename_symbol', 'extract_method', 'git_init']) {
    assert.ok(!standard.includes(tool), `standard must not expose ${tool}`);
  }
  // `spawn_subagent` carries risk `read`, so this is the case the read-only rule
  // would have let through if it had not been subtracted — and now re-admitted
  // by name. The risk label must stay `read`, or the two rules stop being
  // distinguishable and this exception becomes untestable.
  assert.equal(byName.get('spawn_subagent')?.risk, 'read', 'this test guards the read-only exception');
  assert.ok(byName.has('review_loop'), 'review_loop must be in the registry for scope to see it');

  // Delegation is now in.
  for (const tool of ['spawn_subagent', 'review_loop']) {
    assert.ok(standard.includes(tool), `standard must expose ${tool}`);
    assert.equal(canSpawnAgent(tool), true, `${tool} must still be treated as able to write`);
    assert.equal(isReadOnlyTool(byName.get(tool)!), false, `${tool} must not count as read-only`);
  }
  // Every tool standard re-admits by delegation must be one of the spawners, and
  // the read-only filter must never have learned about them.
  for (const name of DELEGATION_TOOLS) {
    assert.ok(AGENT_SPAWNING_TOOLS.has(name), `${name} must be in AGENT_SPAWNING_TOOLS`);
  }

  // Workflow execution stays out.
  for (const tool of ['workflow_execute', 'workflow_resume']) {
    assert.ok(!standard.includes(tool), `standard must not expose ${tool}`);
  }
  // And compact, the read-only scope, gets neither.
  const compact = names('compact');
  for (const tool of ['spawn_subagent', 'review_loop', 'workflow_execute', 'workflow_resume']) {
    assert.ok(!compact.includes(tool), `compact must not expose ${tool}`);
  }
});

test('standard exposes the structured test/script gates, not only their hand-written shell equivalents', () => {
  // HIGH_VALUE_EXTRA was declared for the provider cap's ranking and never read
  // by scope selection, so `run_tests` was `full`-only while `run_command` —
  // which the agent then used to hand-write the same thing — was already
  // present. `run_script` had the same shape (shell risk, so the read-only rule
  // cannot reach it) and was added to STANDARD_EXTRA_ALLOW on 2026-10-29.
  const standard = names('standard');
  for (const tool of ['run_tests', 'lint', 'typecheck', 'run_script', 'test_fix', 'generate_function_test']) {
    assert.ok(standard.includes(tool), `expected standard to expose ${tool}`);
  }
  // compact stays a read-only scope: running tests is not a read.
  const compact = names('compact');
  for (const tool of ['run_tests', 'lint', 'typecheck', 'run_script']) {
    assert.ok(!compact.includes(tool), `compact must not expose ${tool}`);
  }
});

test('widening read-only into standard leaves the tool array under the provider cap', () => {
  const counts = ['compact', 'standard', 'full'].map((scope) => names(scope as 'compact' | 'standard' | 'full').length);
  // 236 before the read-only widening, 330 after it, 332 once the two delegation
  // tools were admitted, 333 after run_script (2026-10-29 tool-surface audit).
  // The floor tracks those decisions, not a target.
  assert.ok(counts[1] >= 333, `standard should be at least 333 (236 → 330 read-only → 332 delegation → 333 run_script); saw ${counts[1]}`);
  assert.ok(counts[1] < counts[2], `standard must stay smaller than full: ${counts.join(' / ')}`);
  assert.ok(counts[1] <= MAX_PROVIDER_TOOLS, `standard (${counts[1]}) must fit under the cap of ${MAX_PROVIDER_TOOLS}`);
  // The cap runs AFTER the post-scope injections, so the headroom has to cover
  // the tools scope selection cannot see: propose_plan, open_pull_request and
  // supervisor_status (computer/browser tools are switch-gated and are covered
  // by the protected-name rank instead).
  assert.ok(counts[1] + 3 <= MAX_PROVIDER_TOOLS, `standard (${counts[1]}) plus 3 post-scope tools must still fit under ${MAX_PROVIDER_TOOLS}`);
});
