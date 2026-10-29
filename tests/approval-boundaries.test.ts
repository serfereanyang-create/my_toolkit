import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DesktopApprovalBroker } from '../src/cli/approvalBroker.js';
import { decideApproval } from '../src/safety/policy.js';
import type { ApprovalRequest } from '../src/tools/types.js';
import { mulberry32 } from './approval-random.js';


function writeRequest(path: string, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    tool: 'write_file',
    risk: 'write',
    input: { path, content: 'x' },
    reason: 'interactive approval required',
    message: 'allow write?',
    ...overrides,
  };
}

function makeBroker(timeoutMs = 0) {
  const events: Array<Record<string, unknown>> = [];
  const broker = new DesktopApprovalBroker('session-1', { emit: (event) => events.push(event), timeoutMs });
  const approvals = () => events.filter((event) => event.type === 'approval_needed');
  return { broker, events, approvals };
}

/** Real timeout; the broker unrefs its timer, so the test keeps the loop alive. */
async function withTimeout<T>(ms: number, work: (resolve: (value: T) => void) => void): Promise<T> {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    return await new Promise<T>((resolve) => {
      const timer = setTimeout(() => resolve('__timeout__' as T), ms);
      work((value) => { clearTimeout(timer); resolve(value); });
    });
  } finally {
    clearInterval(keepAlive);
  }
}

/*
 * 1. Key granularity.
 *
 * `risk:tool:dir` could not tell `npm test` from `npm publish` (shell is never
 * cached) nor `src/a.ts` from `src/config.ts` (same dir). The widened key adds
 * the basename and, when the request carries the bytes, their length.
 */
test('a session allow for one file does not pre-approve a different file in the same directory', async () => {
  const { broker, approvals } = makeBroker();
  const first = broker.confirm('?', writeRequest('src/a.ts', { input: { path: 'src/a.ts', content: 'hello' } }));
  broker.resolve(broker.lastRequestId(), 'allow_session');
  assert.equal(await first, 'allow_session');

  const sibling = broker.confirm('?', writeRequest('src/config.ts', { input: { path: 'src/config.ts', content: 'secret' } }));
  assert.equal(approvals().length, 2, 'a different file in the same folder must be asked about');
  broker.resolve(broker.lastRequestId(), 'deny');
  assert.equal(await sibling, false);
});

test('repeated writes of the same path with the same bytes are cached', async () => {
  const { broker, approvals } = makeBroker();
  const request = writeRequest('src/a.ts', { input: { path: 'src/a.ts', content: 'same' } });
  const first = broker.confirm('?', request);
  broker.resolve(broker.lastRequestId(), 'allow_session');
  assert.equal(await first, 'allow_session');
  assert.equal(await broker.confirm('?', request), true);
  assert.equal(approvals().length, 1, 'identical content is the same decision');
});

test('the same path with different bytes re-prompts (a cached yes is not a blanket yes)', async () => {
  const { broker, approvals } = makeBroker();
  const first = broker.confirm('?', writeRequest('src/a.ts', { input: { path: 'src/a.ts', content: 'short' } }));
  broker.resolve(broker.lastRequestId(), 'allow_session');
  await first;
  const larger = broker.confirm('?', writeRequest('src/a.ts', { input: { path: 'src/a.ts', content: 'x'.repeat(400) } }));
  assert.equal(approvals().length, 2, 'a much larger payload to the same file is a different approval');
  broker.resolve(broker.lastRequestId(), 'deny');
  assert.equal(await larger, false);
});

test('from/to tools key on the destination, not on the tool alone', async () => {
  const { broker, approvals } = makeBroker();
  const copy = (to: string): ApprovalRequest => ({
    tool: 'copy_file',
    risk: 'write',
    input: { from: 'src/a.ts', to },
    reason: 'interactive approval required',
    message: '?',
  });
  const first = broker.confirm('?', copy('docs/a.ts'));
  broker.resolve(broker.lastRequestId(), 'allow_session');
  await first;
  const other = broker.confirm('?', copy('tmp/backup.ts'));
  assert.equal(approvals().length, 2, 'a copy to a different directory must be asked about');
  broker.resolve(broker.lastRequestId(), 'deny');
  assert.equal(await other, false);
});

test('shell is never cached, so one allow_session cannot cover a later command', async () => {
  const { broker, approvals } = makeBroker();
  const shell = (command: string): ApprovalRequest => ({
    tool: 'run_command',
    risk: 'shell',
    input: { command },
    reason: 'interactive approval required',
    message: '?',
  });
  const first = broker.confirm('?', shell('npm test'));
  broker.resolve(broker.lastRequestId(), 'allow_session');
  assert.equal(await first, 'allow_session');
  const publish = broker.confirm('?', shell('npm publish --access public'));
  assert.equal(approvals().length, 2, 'shell must always re-prompt');
  broker.resolve(broker.lastRequestId(), 'deny');
  assert.equal(await publish, false);
});

test('destructive requests are never answered from, nor stored into, the cache', async () => {
  const { broker, approvals } = makeBroker();
  const destructive: ApprovalRequest = {
    tool: 'git_restore',
    risk: 'write',
    input: { paths: ['src/a.ts'] },
    reason: 'destructive tool requires explicit confirmation',
    message: '?',
  };
  const first = broker.confirm('?', destructive);
  broker.resolve(broker.lastRequestId(), 'allow_session');
  await first;
  const second = broker.confirm('?', destructive);
  assert.equal(approvals().length, 2, 'a destructive yes must not be cached');
  broker.resolve(broker.lastRequestId(), 'deny');
  assert.equal(await second, false);
});

/*
 * 2. Timeout and late/out-of-order replies.
 */
test('a timed-out approval denies and a late reply for it cannot answer the next request', async () => {
  const { broker, events, approvals } = makeBroker(15);
  const outcome = await withTimeout<'denied' | 'other'>(2000, (resolve) => {
    void broker.confirm('?', writeRequest('src/a.ts')).then((decision) => resolve(decision === false ? 'denied' : 'other'));
  });
  assert.equal(outcome, 'denied');
  const staleId = broker.lastRequestId();
  assert.equal(broker.pendingCount, 0);

  // A new request arrives; the stale id must not touch it.
  const next = broker.confirm('?', writeRequest('src/b.ts'));
  const nextId = broker.lastRequestId();
  assert.notEqual(nextId, staleId);
  assert.equal(broker.resolve(staleId, 'allow_once'), undefined);
  assert.ok(events.some((event) => event.type === 'error' && String(event.message).includes(staleId)), 'a late reply is reported, not applied');
  assert.equal(broker.pendingCount, 1, 'the new request is still pending');
  broker.resolve(nextId, 'deny');
  assert.equal(await next, false);
  assert.equal(approvals().length, 2);
});

test('out-of-order replies settle the request each id names (randomized)', async () => {
  const random = mulberry32(0x5eed);
  for (let round = 0; round < 40; round += 1) {
    const { broker } = makeBroker();
    const count = 2 + Math.floor(random() * 5);
    const ids: string[] = [];
    const decisions = ['allow_once', 'deny', 'allow_once', 'deny', 'allow_once'] as const;
    const expected = new Map<string, boolean>();
    const pending: Array<Promise<unknown>> = [];
    for (let index = 0; index < count; index += 1) {
      pending.push(broker.confirm('?', writeRequest(`src/f${round}-${index}.ts`)));
      const id = broker.lastRequestId();
      ids.push(id);
      expected.set(id, decisions[index % decisions.length] === 'allow_once');
    }
    // Shuffle replies with the same PRNG so a wrong index mapping would show.
    const order = [...ids];
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    for (const id of order) broker.resolve(id, expected.get(id) ? 'allow_once' : 'deny');
    const results = await Promise.all(pending);
    results.forEach((result, index) => {
      assert.equal(result, expected.get(ids[index]), `round ${round} request ${index}`);
    });
    assert.equal(broker.pendingCount, 0);
  }
});

test('a malformed decision is refused and the request stays pending', async () => {
  const { broker, events } = makeBroker();
  const pending = broker.confirm('?', writeRequest('src/a.ts'));
  // The bridge validates first, but the broker must not read an unknown string
  // as allow_session: `'DENY'` used to become the most permissive answer.
  broker.resolve(broker.lastRequestId(), 'DENY' as unknown as 'deny');
  assert.equal(broker.pendingCount, 1, 'an invalid decision must not settle the request');
  assert.ok(
    events.some((event) => event.type === 'error' && String(event.message).includes('Invalid approval decision')),
    'the refusal is reported',
  );
  broker.resolve(broker.lastRequestId(), 'deny');
  assert.equal(await pending, false);
});

test('denyAll denies in-flight requests and the next request is still asked about', async () => {
  const { broker, approvals } = makeBroker();
  const first = broker.confirm('?', writeRequest('src/a.ts'));
  broker.denyAll('cancel');
  assert.equal(await first, false);
  const second = broker.confirm('?', writeRequest('src/a.ts'));
  assert.equal(approvals().length, 2, 'cancel must not suspend future prompts (the bridge resumes per turn)');
  broker.resolve(broker.lastRequestId(), 'allow_once');
  assert.equal(await second, true);
});

/*
 * `git checkout <commit-ish> -- <paths>` is a working-tree discard.
 *
 * The first version of the shell-git rule only recognised a LEADING `--`
 * (`git checkout -- .`), so restoring a path from a commit — which overwrites
 * uncommitted edits just the same — came back as an ordinary auto-mode command
 * and ran with no prompt in auto + 任意应用.
 */
test('restoring a path from a commit is a destructive shell git discard', () => {
  const decisions = [
    'git checkout HEAD -- src/app.ts',
    'git checkout HEAD~1 -- src/app.ts',
    'git checkout main -- .',
    'git checkout -- src/a.ts src/b.ts',
  ].map((command) => ({
    command,
    decision: decideApproval({ workspaceRoot: 'C:\\proj', mode: 'auto', computerAnyApp: true, risk: 'shell', command }),
  }));

  for (const { command, decision } of decisions) {
    assert.equal(decision.needsPrompt, true, `${command} must be confirmed`);
    assert.match(decision.reason, /destructive/i, `${command} must carry the destructive marker`);
  }
});

test('branch switches and staged-only restores stay non-destructive', () => {
  const harmless = [
    'git checkout main',
    'git checkout -b feature',
    'git checkout --detach',
    'git checkout --ours conflict.ts',
    'git restore --staged foo.ts',
  ];
  for (const command of harmless) {
    const decision = decideApproval({ workspaceRoot: 'C:\\proj', mode: 'auto', computerAnyApp: true, risk: 'shell', command });
    assert.equal(decision.needsPrompt, false, `${command} must not prompt in auto mode: ${decision.reason}`);
  }
});
