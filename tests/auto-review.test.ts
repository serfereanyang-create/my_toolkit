import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTO_REVIEW_DENIAL_LIMIT,
  AUTO_REVIEW_PROMPT,
  AutoReviewGate,
  buildReviewerMessage,
  isReviewable,
  parseReviewVerdict,
} from '../src/safety/autoReview.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import type { ApprovalRequest } from '../src/tools/types.js';

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    tool: 'write_file',
    risk: 'write',
    input: { path: 'note.md', content: 'x' },
    reason: 'interactive approval required',
    message: 'Approve write tool write_file',
    ...overrides,
  };
}

/*
 * The parse is the security boundary. Every ambiguous input must become
 * `abstain` — which sends the decision back to the user — and never `allow`.
 * A reviewer that fails to answer is not a reviewer that approved.
 */
test('parseReviewVerdict never turns a malformed answer into an allow', () => {
  const malformed = [
    '',
    'I think this is fine, go ahead.',
    '{"decision":"maybe"}',
    '{"decision":true}',
    '{"decision":null}',
    '{}',
    '{"risk_level":"low"}',
    'not json at all',
  ];
  for (const text of malformed) {
    const verdict = parseReviewVerdict(text);
    assert.equal(verdict.decision, 'abstain', `must abstain on: ${text}`);
  }
});

test('parseReviewVerdict reads a well-formed allow and deny', () => {
  const allow = parseReviewVerdict('{"decision":"allow","risk_level":"medium","rationale":"工作区内可恢复"}');
  assert.equal(allow.decision, 'allow');
  assert.equal(allow.riskLevel, 'medium');
  assert.equal(allow.rationale, '工作区内可恢复');

  const deny = parseReviewVerdict('{"decision":"deny","risk_level":"critical","rationale":"会泄露凭据"}');
  assert.equal(deny.decision, 'deny');
  assert.equal(deny.riskLevel, 'critical');
});

test('parseReviewVerdict tolerates JSON wrapped in prose', () => {
  const verdict = parseReviewVerdict('我的判断如下：\n{"decision":"allow","risk_level":"low","rationale":"只读"}\n以上。');
  assert.equal(verdict.decision, 'allow');
});

test('parseReviewVerdict defaults the risk level from the decision', () => {
  // A missing risk_level must not become "low" for a denial — that would
  // understate a refusal.
  const deny = parseReviewVerdict('{"decision":"deny"}');
  assert.ok(deny.decision === 'deny');
  assert.equal(deny.riskLevel, 'high');
  const allow = parseReviewVerdict('{"decision":"allow"}');
  assert.ok(allow.decision === 'allow');
  assert.equal(allow.riskLevel, 'low');
});

test('isReviewable excludes read-only actions', () => {
  assert.equal(isReviewable(request({ risk: 'read' })), false);
  assert.equal(isReviewable(request({ risk: 'write' })), true);
  assert.equal(isReviewable(request({ risk: 'shell' })), true);
});

test('the gate stops consulting after the denial limit', () => {
  const gate = new AutoReviewGate();
  const req = request();
  assert.equal(gate.shouldConsult(req, true), true);
  for (let i = 0; i < AUTO_REVIEW_DENIAL_LIMIT; i += 1) {
    assert.equal(gate.shouldConsult(req, true), true, `consult ${i + 1} must be allowed`);
    gate.record({ decision: 'deny', riskLevel: 'high', rationale: 'no' });
  }
  assert.equal(gate.shouldConsult(req, true), false, 'must stop consulting past the limit');
  assert.equal(gate.denialCount, AUTO_REVIEW_DENIAL_LIMIT);
});

test('the gate clears the streak on an allow or an abstain', () => {
  const gate = new AutoReviewGate();
  gate.record({ decision: 'deny', riskLevel: 'high', rationale: 'no' });
  gate.record({ decision: 'deny', riskLevel: 'high', rationale: 'no' });
  assert.equal(gate.denialCount, 2);
  // A functioning reviewer resets the streak: the limit is about a run of
  // refusals, not a lifetime total.
  gate.record({ decision: 'allow', riskLevel: 'low', rationale: 'ok' });
  assert.equal(gate.denialCount, 0);
  gate.record({ decision: 'abstain', reason: 'timeout' });
  assert.equal(gate.denialCount, 0);
});

test('the gate is off when the feature is off', () => {
  const gate = new AutoReviewGate();
  assert.equal(gate.shouldConsult(request(), false), false);
});

test('buildReviewerMessage includes the action and the diff', () => {
  const message = buildReviewerMessage(request({
    diff: { path: 'note.md', originalContent: 'before', modifiedContent: 'after' },
  }), '把 note.md 改一下');
  assert.match(message, /write_file/);
  assert.match(message, /note\.md/);
  assert.match(message, /before/);
  assert.match(message, /after/);
  assert.match(message, /把 note\.md 改一下/);
});

test('the reviewer prompt states the decision rules and the output contract', () => {
  // The parser only understands what this prompt asks for; they must not drift.
  assert.match(AUTO_REVIEW_PROMPT, /"decision": "allow" \| "deny"/);
  assert.match(AUTO_REVIEW_PROMPT, /critical → deny/);
  assert.match(AUTO_REVIEW_PROMPT, /不可信证据/);
});

/*
 * The load-bearing safety property: the reviewer is consulted only after the
 * policy layer's hard-deny branch, so a blocked command stays blocked no matter
 * what the reviewer answers. These tests drive the real registry with an
 * auto-reviewer that says "allow" and assert the call is still refused.
 */
test('a blocked destructive command is refused even when the reviewer allows it', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-review-block-'));
  try {
    const registry = createDefaultToolRegistry();
    const result = await registry.execute('run_command', { command: 'rm -rf /', timeoutMs: 1000, background: false }, {
      workspaceRoot: workspace,
      approval: 'ask',
      confirm: async () => true,
      autoReview: async () => ({ decision: 'allow', riskLevel: 'low', rationale: '审核员被说服了' }),
    });
    assert.equal(result.ok, false, 'the reviewer must not be able to revive a blocked command');
    assert.match(result.output, /blocked destructive command pattern/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('deny mode is not overridable by the reviewer', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-review-deny-'));
  try {
    const registry = createDefaultToolRegistry();
    let consulted = false;
    const result = await registry.execute('write_file', { path: 'x.md', content: 'hi' }, {
      workspaceRoot: workspace,
      approval: 'deny',
      confirm: async () => true,
      autoReview: async () => { consulted = true; return { decision: 'allow', riskLevel: 'low', rationale: 'ok' }; },
    });
    assert.equal(result.ok, false);
    assert.equal(consulted, false, 'the reviewer must not even be consulted for a hard-denied action');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('an allow verdict runs the action without prompting the user', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-review-allow-'));
  try {
    const registry = createDefaultToolRegistry();
    let prompted = false;
    const result = await registry.execute('write_file', { path: 'note.md', content: 'written' }, {
      workspaceRoot: workspace,
      approval: 'ask',
      confirm: async () => { prompted = true; return true; },
      autoReview: async () => ({ decision: 'allow', riskLevel: 'medium', rationale: '工作区内可恢复' }),
    });
    assert.equal(result.ok, true);
    assert.equal(prompted, false, 'an allowed action must not reach the user prompt');
    assert.equal(await readFile(join(workspace, 'note.md'), 'utf8'), 'written');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a deny verdict blocks the action and writes nothing', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-review-deny2-'));
  try {
    const registry = createDefaultToolRegistry();
    let prompted = false;
    const result = await registry.execute('write_file', { path: 'note.md', content: 'nope' }, {
      workspaceRoot: workspace,
      approval: 'ask',
      confirm: async () => { prompted = true; return true; },
      autoReview: async () => ({ decision: 'deny', riskLevel: 'high', rationale: '作用范围过大' }),
    });
    assert.equal(result.ok, false);
    assert.equal(prompted, false);
    assert.match(result.output, /自动审核拒绝/);
    assert.match(result.output, /作用范围过大/);
    const landed = await readFile(join(workspace, 'note.md'), 'utf8').then(() => true, () => false);
    assert.equal(landed, false, 'a denied action must not touch the disk');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('an abstain falls back to asking the user', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-review-abstain-'));
  try {
    const registry = createDefaultToolRegistry();
    let prompted = false;
    const result = await registry.execute('write_file', { path: 'note.md', content: 'via user' }, {
      workspaceRoot: workspace,
      approval: 'ask',
      confirm: async () => { prompted = true; return true; },
      autoReview: async () => ({ decision: 'abstain', reason: '审核超时' }),
    });
    assert.equal(result.ok, true);
    assert.equal(prompted, true, 'abstain must fall back to the user prompt');
    assert.equal(await readFile(join(workspace, 'note.md'), 'utf8'), 'via user');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('the reviewer receives the real diff before anything is written', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-review-diff-'));
  try {
    await writeFile(join(workspace, 'note.md'), 'before\n', 'utf8');
    const registry = createDefaultToolRegistry();
    let seen: ApprovalRequest | undefined;
    await registry.execute('write_file', { path: 'note.md', content: 'after\n' }, {
      workspaceRoot: workspace,
      approval: 'ask',
      confirm: async () => false,
      autoReview: async (req) => { seen = req; return { decision: 'deny', riskLevel: 'high', rationale: 'x' }; },
    });
    assert.ok(seen, 'the reviewer must be handed the request');
    assert.equal(seen.diff?.originalContent, 'before\n');
    assert.equal(seen.diff?.modifiedContent, 'after\n');
    // Denied by review: the file must still hold its original content.
    assert.equal(await readFile(join(workspace, 'note.md'), 'utf8'), 'before\n');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('no reviewer configured leaves the prompt path untouched', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-review-off-'));
  try {
    const registry = createDefaultToolRegistry();
    let prompted = false;
    const result = await registry.execute('write_file', { path: 'note.md', content: 'normal' }, {
      workspaceRoot: workspace,
      approval: 'ask',
      confirm: async () => { prompted = true; return true; },
    });
    assert.equal(result.ok, true);
    assert.equal(prompted, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
