import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REVIEW_DIFF_CHARS_IN_PROMPT, assessTruncation, buildReviewPrompt, summarizeReview, type ReviewRunResult } from '../src/review/reviewer.js';
import { renderReviewAssistantMessage, renderReviewUserMessage, USER_ACTION_OPEN } from '../src/review/writeback.js';

/*
 * What the user and the next turn are told about a review.
 *
 * The audit found two ways a review lied by omission:
 *   - a diff cut by the PROMPT cap (120k, lower than the resolver's 200k) was
 *     never reported anywhere the user could see, so "未发现问题" read as "the
 *     whole change is clean";
 *   - a review that never ran rendered as "No findings." in the user message
 *     recorded into history, because the renderer read `report.findings` and
 *     dropped `result.error`.
 */

function result(overrides: Partial<ReviewRunResult> = {}): ReviewRunResult {
  return {
    ok: true,
    report: { findings: [], outcome: 'correct' },
    label: '未提交的改动',
    sessionId: 'sub_1',
    durationMs: 10,
    steps: 3,
    ...overrides,
  };
}

function target(diff: string, extra: { truncated?: boolean; fullLength?: number } = {}) {
  return { target: { kind: 'uncommitted' as const }, label: '未提交的改动', diff, files: ['a.ts'], ...extra };
}

test('a diff under both caps produces no warning', () => {
  const resolved = target('diff --git a/a.ts b/a.ts\n+ok\n');
  assert.equal(assessTruncation(resolved), undefined);
  assert.equal(result().warning, undefined);
  assert.ok(!buildReviewPrompt(resolved).includes('截断'));
});

test('a resolver-truncated diff yields a user-facing warning naming both lengths', () => {
  const resolved = target('x'.repeat(200), { truncated: true, fullLength: 5000 });
  const warning = assessTruncation(resolved);
  assert.ok(warning);
  assert.match(warning!, /前 200 个字符/);
  assert.match(warning!, /完整 5000 个/);
  assert.match(warning!, /「未发现问题」只对已看过的部分成立/);
  assert.match(buildReviewPrompt(resolved), /已被截断/);
});

test('a diff cut by the prompt cap — not the resolver cap — is reported too', () => {
  // The resolver cap defaults to 200k; the prompt cap is 120k. Everything between
  // the two used to be cut silently.
  const diff = 'y'.repeat(REVIEW_DIFF_CHARS_IN_PROMPT + 1000);
  const resolved = target(diff);
  assert.equal(resolved.truncated, undefined, 'fixture: the resolver did not truncate');
  const warning = assessTruncation(resolved);
  assert.ok(warning, 'the prompt cap must not be silent');
  assert.match(warning!, new RegExp(`前 ${REVIEW_DIFF_CHARS_IN_PROMPT} 个字符`));
  assert.match(warning!, new RegExp(`完整 ${diff.length} 个`));

  const prompt = buildReviewPrompt(resolved);
  assert.ok(!prompt.includes(diff), 'fixture: the full diff must not fit under the prompt cap');
  assert.match(prompt, /只贴出了前 120000 个字符/);
});

test('the warning survives every rendering of the result', () => {
  const partial = result({
    warning: '本次审查只看到了改动的前 100 个字符（完整 5000 个），其余部分没有被审查。',
  });
  assert.match(summarizeReview(partial), /注意：.*前 100 个字符/);
  assert.match(renderReviewAssistantMessage(partial), /未发现问题。[\s\S]*注意：/);
  assert.match(renderReviewUserMessage(partial), /Review was partial/);
});

test('a review that could not run is recorded as an error, never as "No findings."', () => {
  const failed = result({
    ok: false,
    sessionId: '',
    steps: 0,
    error: '审查未能运行：provider 超时',
  });
  const user = renderReviewUserMessage(failed);
  assert.ok(user.startsWith(USER_ACTION_OPEN));
  assert.match(user, /provider 超时/);
  assert.doesNotMatch(user, /No findings\./);
  assert.match(user, /could not be run/);
  // The explanation is the reviewer's verdict about a review that never happened.
  assert.match(renderReviewAssistantMessage(failed), /代码审查未能完成：审查未能运行：provider 超时/);
});

test('an unparsed reply is still "not a clean review" when rendered', () => {
  const unparsed = result({ report: { findings: [], outcome: 'unknown', unparsed: true, raw: 'garbage' } });
  const user = renderReviewUserMessage(unparsed);
  assert.match(user, /did not return the structured result/);
  assert.match(user, /garbage/);
  assert.doesNotMatch(renderReviewAssistantMessage(unparsed), /未发现问题/);
  assert.match(summarizeReview(unparsed), /不是结构化结果/);
});

test('a successful empty review still says so plainly', () => {
  const empty = result();
  assert.match(renderReviewUserMessage(empty), /No findings\./);
  assert.match(renderReviewAssistantMessage(empty), /未发现问题/);
});
