import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allExperts, codeReviewExpert, codeSearchExpert, expertById, CODE_REVIEW_EXPERT_ID } from '../src/experts/profiles.js';
import { routeTaskToExpert } from '../src/experts/router.js';
import { expertIdForSubAgentRequest } from '../src/subagent/runner.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { AGENT_SPAWNING_TOOLS, canSpawnAgent, isReadOnlyTool } from '../src/tools/scope.js';
import type { TaskBoard } from '../src/tasks/types.js';

/*
 * The reviewer runs with `confirm`/`toolConfirm` hardcoded to `() => true`
 * (subagent/runner.ts) — it is never stopped by an approval prompt. That makes
 * the expert's toolFilter the ONLY thing keeping a review read-only, and turns
 * "the filter is correct" into a security property rather than a preference.
 *
 * These tests assert on the actual filtered registry, not on the filter
 * function: a filter that is correct but wired to the wrong place protects
 * nothing.
 */

/** The reviewer's toolset, built exactly the way runSubAgent builds it. */
function reviewerTools() {
  const source = createDefaultToolRegistry();
  return ToolRegistry.fromTools(
    source.list().filter((tool) => codeReviewExpert.toolFilter({
      name: tool.name,
      risk: tool.risk,
      description: tool.description,
    })),
  );
}

test('the reviewer gets no tool that can write, execute, or reach the network', () => {
  const tools = reviewerTools().list();
  assert.ok(tools.length > 0, 'the reviewer must have read tools to work with');

  const dangerous = tools.filter((tool) => tool.risk !== 'read');
  assert.deepEqual(
    dangerous.map((tool) => `${tool.name}(${tool.risk})`),
    [],
    'a non-read tool in the reviewer toolset is a write/execute capability the reviewer cannot be prompted for',
  );
});

test('the specific escape hatches are absent by name', () => {
  const names = new Set(reviewerTools().list().map((tool) => tool.name));
  for (const name of [
    'write_file', 'append_file', 'edit_lines', 'apply_patch',
    'run_command',
    'git_commit', 'git_add', 'git_checkout', 'git_reset', 'git_restore', 'git_merge', 'git_pull',
    // Delegation is the non-obvious one: spawn_subagent is risk 'read' (the
    // call writes nothing) but with readonly:false it starts a write-capable
    // sub-agent, and review_loop's executor edits files. A risk check alone
    // would let the reviewer write through a delegate it cannot be prompted
    // about.
    'spawn_subagent', 'review_loop', 'workflow_execute', 'workflow_resume',
    'open_pull_request',
    'create_docx', 'create_xlsx', 'create_pptx',
  ]) {
    assert.ok(!names.has(name), `${name} must not be available to the reviewer`);
  }
  // `poll_command` IS present and that is correct: it is risk 'read' and can
  // only read the output of a job that already exists — it cannot start one
  // (run_command is gone), so it causes no side effect. The boundary is "can
  // this cause a write or an execution", not "does this sound like a shell".
  assert.ok(names.has('poll_command'));
  assert.ok(!names.has('run_command'), 'the only way to create a job is absent');
});

test('isReadOnlyTool excludes delegation, which a risk check alone cannot', () => {
  // The property the filter must express: "cannot cause a write". spawn_subagent
  // satisfies risk === 'read' while violating it.
  assert.equal(isReadOnlyTool({ name: 'read_file', risk: 'read' }), true);
  assert.equal(isReadOnlyTool({ name: 'spawn_subagent', risk: 'read' }), false);
  assert.equal(isReadOnlyTool({ name: 'review_loop', risk: 'read' }), false);
  assert.equal(isReadOnlyTool({ name: 'workflow_execute', risk: 'write' }), false);
  assert.equal(isReadOnlyTool({ name: 'write_file', risk: 'write' }), false);
  // The set and the predicate must not drift apart.
  for (const name of AGENT_SPAWNING_TOOLS) {
    assert.equal(canSpawnAgent(name), true);
    assert.equal(isReadOnlyTool({ name, risk: 'read' }), false);
  }
});

test('read-only experts get no agent-spawning tool', () => {
  const source = createDefaultToolRegistry();
  for (const expert of [codeSearchExpert, codeReviewExpert]) {
    const names = source.list()
      .filter((tool) => expert.toolFilter({ name: tool.name, risk: tool.risk, description: tool.description }))
      .map((tool) => tool.name);
    for (const spawner of AGENT_SPAWNING_TOOLS) {
      assert.ok(!names.includes(spawner), `${expert.id} must not have ${spawner}`);
    }
  }
});

test('a readonly sub-agent request really gets the read-only expert', () => {
  // The other half of the boundary: spawn_subagent advertises `readonly: true`,
  // and the wired runner must act on it. It used to ignore the option entirely
  // and always pass expert 'code_edit' — so a caller asking for a read-only
  // sub-agent silently got one that could write.
  assert.equal(expertIdForSubAgentRequest({ readonly: true }), 'code_search');
  assert.equal(expertIdForSubAgentRequest({ readonly: false }), 'code_edit');
  assert.equal(expertIdForSubAgentRequest(undefined), 'code_edit');
  // A misspelled/absent flag must not silently mean read-only, and a true one
  // must not silently mean writable: assert the expert it picks actually
  // refuses a write, rather than trusting the id string.
  for (const [options, expectedReadOnly] of [
    [{ readonly: true }, true],
    [{ readonly: false }, false],
    [undefined, false],
  ] as const) {
    const profile = expertById(expertIdForSubAgentRequest(options))!;
    const allowsWrite = profile.toolFilter({ name: 'write_file', risk: 'write', description: '' });
    assert.equal(allowsWrite, !expectedReadOnly, `readonly=${String(options?.readonly)} must pick a matching expert`);
  }
});

test('the reviewer keeps the read tools it needs to investigate', () => {
  const names = new Set(reviewerTools().list().map((tool) => tool.name));
  // The whole point of a separate session is that the reviewer goes and checks
  // for itself instead of trusting the diff alone.
  for (const name of ['read_file', 'search_text', 'git_diff', 'git_show', 'list_files']) {
    assert.ok(names.has(name), `${name} is how the reviewer verifies a finding`);
  }
});

test('the tool filter is the boundary, so widening it must be detectable', () => {
  // Mutation guard: if someone relaxes the filter, the first test above has to
  // be the thing that fails. Rebuild the set with a permissive filter and show
  // it genuinely contains the dangerous tools — otherwise the assertion above
  // could be passing for an unrelated reason (e.g. the source registry having
  // changed), and would keep passing after the filter was widened.
  const source = createDefaultToolRegistry();
  const permissive = ToolRegistry.fromTools(source.list().filter(() => true));
  const dangerous = permissive.list().filter((tool) => tool.risk !== 'read');
  assert.ok(
    dangerous.length > 0,
    'if the registry had no non-read tools at all, the read-only assertion would be vacuous',
  );
  const permissiveNames = new Set(permissive.list().map((tool) => tool.name));
  assert.ok(permissiveNames.has('write_file'));
  assert.ok(permissiveNames.has('run_command'));
});

test('an unknown expert id resolves to undefined instead of a privileged fallback', () => {
  assert.equal(expertById('no_such_expert'), undefined);
  assert.equal(expertById(CODE_REVIEW_EXPERT_ID)?.id, CODE_REVIEW_EXPERT_ID);
  // The old runner fell back to the LAST profile in the roster — a silent
  // privilege change for any caller that mistyped an id.
  assert.notEqual(allExperts[allExperts.length - 1]!.id, CODE_REVIEW_EXPERT_ID);
});

test('the reviewer is never auto-routed to, even though it shares code_search intent', () => {
  // The router picks the first profile matching an intent. The reviewer shares
  // code_search's intent, so its position in the roster is load-bearing: if it
  // moved ahead of codeSearchExpert, every ordinary search task would be routed
  // to the review profile.
  const board: TaskBoard = {
    id: 'board',
    goal: 'goal',
    title: 'title',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: [{
      id: 'task_1',
      title: '调研一下认证流程',
      detail: '找到并理解登录相关的代码',
      status: 'pending',
      dependsOn: [],
    }],
  };
  const routed = routeTaskToExpert({
    task: board.tasks[0]!,
    board,
    workspaceRoot: '.',
  });
  assert.equal(routed.profile.id, 'code_search');
  assert.notEqual(routed.profile.id, CODE_REVIEW_EXPERT_ID);
});

test('the rubric is the reviewer system prompt, not a duplicate of the task prompt', async () => {
  const { REVIEW_RUBRIC, REVIEW_TASK_PREAMBLE } = await import('../src/review/rubric.js');
  assert.match(codeReviewExpert.systemPrompt, /Review guidelines:/);
  assert.ok(codeReviewExpert.systemPrompt.includes(REVIEW_TASK_PREAMBLE));
  assert.ok(codeReviewExpert.systemPrompt.includes(REVIEW_RUBRIC));
  // The output contract has to reach the model, or the parser has nothing to
  // parse. It lives in the rubric, which is in the system prompt.
  assert.match(codeReviewExpert.systemPrompt, /overall_correctness/);
  assert.match(codeReviewExpert.systemPrompt, /code_location/);
});
