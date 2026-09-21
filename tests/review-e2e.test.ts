import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createAgentRuntime } from '../src/runtime/createRuntime.js';
import type { AppConfig } from '../src/config/types.js';
import type { Provider, ProviderRequest, ProviderResponse } from '../src/providers/types.js';
import { runReviewCommand } from '../src/cli/repl.js';
import { USER_ACTION_OPEN } from '../src/review/writeback.js';

const run = promisify(execFile);

/*
 * End-to-end `/review`: a real repository, a real sub-session, and a stubbed
 * provider that returns a rubric-shaped report.
 *
 * The provider is stubbed rather than mocked out at a seam above it because the
 * thing under test is the whole path — target resolution, the sub-session, the
 * parser, and the history write-back. Stubbing the provider keeps that path real
 * while making the reviewer's reply deterministic.
 */

const REPORT = JSON.stringify({
  findings: [
    {
      title: '[P1] The retry loop never terminates when the queue is empty',
      body: 'When `pending` is empty the loop condition is evaluated once more and the index runs past the end.',
      confidence_score: 0.85,
      priority: 1,
      code_location: { absolute_file_path: 'src/queue.ts', line_range: { start: 12, end: 14 } },
    },
    {
      title: '[P3] Unused import left behind',
      body: '`readFileSync` is no longer referenced.',
      confidence_score: 0.5,
      priority: 3,
      code_location: { absolute_file_path: 'src/queue.ts', line_range: { start: 1, end: 1 } },
    },
  ],
  overall_correctness: 'patch is incorrect',
  overall_explanation: 'One blocking defect in the retry loop.',
  overall_confidence_score: 0.8,
});

/** A provider that answers every request with the canned report. */
function stubProvider(answer: string): Provider {
  return {
    name: 'mock',
    model: 'stub-reviewer',
    async complete(_request: ProviderRequest): Promise<ProviderResponse> {
      return { actions: [{ type: 'message', content: answer }] };
    },
  } as Provider;
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aicode-review-e2e-'));
  await run('git', ['init', '-b', 'main'], { cwd: dir, windowsHide: true });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, windowsHide: true });
  await run('git', ['config', 'user.name', 'Test'], { cwd: dir, windowsHide: true });
  await writeFile(join(dir, 'a.txt'), 'original\n');
  await run('git', ['add', '.'], { cwd: dir, windowsHide: true });
  await run('git', ['commit', '-m', 'first'], { cwd: dir, windowsHide: true });
  // An uncommitted change for the review to look at.
  await writeFile(join(dir, 'a.txt'), 'original\nplus a new line\n');
  return dir;
}

async function makeRuntime(workspace: string) {
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
  return created;
}

test('/review runs a review and records it in session history', async () => {
  const workspace = await makeRepo();
  const { runtime, close } = await makeRuntime(workspace);
  try {
    runtime.provider = stubProvider(REPORT);
    const result = await runReviewCommand(runtime, '');

    // A review that reports defects SUCCEEDED. Marking it failed would raise an
    // error banner for a review that did exactly its job.
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.producedActivity, true, 'a review that ran is activity, even with no findings');

    // Two messages, in codex's order: a system-authored user message carrying
    // the findings, then the assistant message the user reads.
    const messages = runtime.session.messages;
    const recorded = messages.filter((message) => message.name === 'review');
    assert.equal(recorded.length, 2, 'the review must be written back as a user+assistant pair');
    assert.equal(recorded[0]!.role, 'user');
    assert.equal(recorded[1]!.role, 'assistant');

    // The envelope is what marks it as system-originated, so the next turn does
    // not read the reviewer's prose as the human's own words.
    assert.ok(recorded[0]!.content.startsWith(USER_ACTION_OPEN));
    assert.match(recorded[0]!.content, /<action>review<\/action>/);
    assert.match(recorded[0]!.content, /retry loop never terminates/);
    // Both findings reached history, not just the first.
    assert.match(recorded[0]!.content, /Unused import/);

    assert.match(recorded[1]!.content, /代码审查/);
    assert.match(recorded[1]!.content, /retry loop never terminates/);
    assert.match(recorded[1]!.content, /补丁不正确/);

    // The reviewer's findings are information, not an order: the recorded
    // context must tell the next turn not to start fixing things unasked.
    assert.match(recorded[0]!.content, /do not start fixing anything unless they ask/i);
  } finally {
    await close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a review reports the diff it was asked about', async () => {
  const workspace = await makeRepo();
  const { runtime, close } = await makeRuntime(workspace);
  try {
    let seenPrompt = '';
    runtime.provider = {
      name: 'mock',
      model: 'stub-reviewer',
      async complete(request: ProviderRequest): Promise<ProviderResponse> {
        // Capture the reviewer's prompt — the diff has to reach it, or the
        // review is being run against nothing.
        seenPrompt = request.messages.map((message) => message.content).join('\n');
        return { actions: [{ type: 'message', content: REPORT }] };
      },
    } as Provider;
    await runReviewCommand(runtime, '');
    assert.match(seenPrompt, /plus a new line/, 'the uncommitted change must be in the reviewer prompt');
    assert.match(seenPrompt, /未提交的改动/, 'the prompt must say what is being reviewed');
  } finally {
    await close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a reviewer that does not return the schema is not reported as a clean review', async () => {
  const workspace = await makeRepo();
  const { runtime, close } = await makeRuntime(workspace);
  try {
    runtime.provider = stubProvider('I looked at the diff and it seems fine.');
    const result = await runReviewCommand(runtime, '');
    assert.equal(result.ok, true);

    const assistant = runtime.session.messages.filter((m) => m.name === 'review' && m.role === 'assistant')[0]!;
    // The distinction the user must be able to see: a review whose output could
    // not be read is NOT a review that found nothing.
    assert.match(assistant.content, /did not return the structured result|没有结构化|不是 rubric/);
    assert.ok(!/^未发现问题。$/m.test(assistant.content), 'must not claim no findings');
  } finally {
    await close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('an unresolvable target fails with a reason and records nothing', async () => {
  const workspace = await makeRepo();
  const { runtime, close } = await makeRuntime(workspace);
  try {
    const result = await runReviewCommand(runtime, 'commit deadbee');
    assert.equal(result.ok, false);
    assert.ok(result.reason, 'a failed review must carry a reason');
    assert.match(result.reason!, /deadbee/);
    assert.equal(runtime.session.messages.filter((m) => m.name === 'review').length, 0);
  } finally {
    await close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('the review run is labelled with the target, not with the whole diff', async () => {
  const workspace = await makeRepo();
  const { runtime, close } = await makeRuntime(workspace);
  try {
    runtime.provider = stubProvider(REPORT);
    const labels: string[] = [];
    const goals: string[] = [];
    runtime.subagentEmit = (payload) => {
      labels.push(payload.goal);
      if (payload.phase === 'started') goals.push(payload.goal);
    };
    await runReviewCommand(runtime, '');
    assert.ok(labels.length > 0, 'the review must surface itself as a subagent run');

    // The label is what the progress panel and 子智能体目录 show, and it is
    // persisted by the desktop. Using the full prompt would put the entire diff
    // there — the reviewer's goal is thousands of characters.
    for (const label of labels) {
      assert.ok(label.length < 120, `label too long (${label.length}): ${label.slice(0, 80)}`);
      assert.ok(!label.includes('```diff'), 'the diff must not be in the label');
      assert.ok(!label.includes('plus a new line'), 'the diff content must not be in the label');
    }
    assert.match(labels[0]!, /代码审查/);
  } finally {
    await close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('/review base reviews the branch diff and labels it', async () => {
  const workspace = await makeRepo();
  const { runtime, close } = await makeRuntime(workspace);
  try {
    await run('git', ['checkout', '-b', 'feature'], { cwd: workspace, windowsHide: true });
    await writeFile(join(workspace, 'b.txt'), 'feature work\n');
    await run('git', ['add', '.'], { cwd: workspace, windowsHide: true });
    await run('git', ['commit', '-m', 'feature'], { cwd: workspace, windowsHide: true });

    let seenPrompt = '';
    runtime.provider = {
      name: 'mock',
      model: 'stub-reviewer',
      async complete(request: ProviderRequest): Promise<ProviderResponse> {
        seenPrompt = request.messages.map((message) => message.content).join('\n');
        return { actions: [{ type: 'message', content: REPORT }] };
      },
    } as Provider;

    const result = await runReviewCommand(runtime, 'base main');
    assert.equal(result.ok, true, result.reason);
    assert.match(seenPrompt, /合并基点|main/, 'the base comparison must be described');
    assert.match(seenPrompt, /feature work/, 'the branch diff must reach the reviewer');
  } finally {
    await close();
    await rm(workspace, { recursive: true, force: true });
  }
});
