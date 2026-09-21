import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseReviewOutput,
  priorityLabel,
  stripPriorityTag,
  REVIEW_RAW_CHARS,
} from '../src/review/parse.js';

/*
 * The reviewer is a language model, so its JSON is not a contract it can be
 * held to. These cases pin the two ways that can go wrong: a reply that is not
 * the schema must be reported as unparsed (never as "no findings"), and a reply
 * that IS the schema but is surrounded by other JSON must still be read.
 */

const VALID = JSON.stringify({
  findings: [
    {
      title: '[P1] Off-by-one in the retry loop',
      body: 'The loop runs one past the end when the list is empty.',
      confidence_score: 0.9,
      priority: 1,
      code_location: { absolute_file_path: 'C:/repo/src/a.ts', line_range: { start: 10, end: 12 } },
    },
  ],
  overall_correctness: 'patch is incorrect',
  overall_explanation: 'One defect found.',
  overall_confidence_score: 0.8,
});

test('a well-formed report parses into findings with their locations', () => {
  const report = parseReviewOutput(VALID);
  assert.equal(report.unparsed, undefined);
  assert.equal(report.findings.length, 1);
  const finding = report.findings[0]!;
  assert.equal(finding.title, 'Off-by-one in the retry loop');
  assert.equal(finding.priority, 1);
  assert.equal(finding.confidenceScore, 0.9);
  assert.equal(finding.filePath, 'C:/repo/src/a.ts');
  assert.equal(finding.lineStart, 10);
  assert.equal(finding.lineEnd, 12);
  assert.equal(report.outcome, 'incorrect');
  assert.equal(report.explanation, 'One defect found.');
});

test('a reply that is not the schema is marked unparsed, not reported as clean', () => {
  const replies = [
    '',
    'I reviewed the change and it looks fine to me.',
    '{"findings": "none"}',
    '{"not_findings": []}',
    '[]',
    '```json\n{"findings": [}\n```',
  ];
  for (const reply of replies) {
    const report = parseReviewOutput(reply);
    assert.equal(report.unparsed, true, `expected unparsed for: ${reply.slice(0, 40)}`);
    assert.equal(report.findings.length, 0);
    // The distinction that matters: an unparsed review must be distinguishable
    // from a review that ran and found nothing. The caller keys the UI off this.
    assert.equal(report.outcome, 'unknown');
  }
});

test('an empty findings array IS a clean review, not a parse failure', () => {
  const report = parseReviewOutput(JSON.stringify({
    findings: [],
    overall_correctness: 'patch is correct',
    overall_explanation: 'No issues.',
  }));
  assert.equal(report.unparsed, undefined);
  assert.equal(report.findings.length, 0);
  assert.equal(report.outcome, 'correct');
});

/*
 * A reviewer reading a diff routinely quotes JSON — the code under review may
 * itself contain a config object or a test fixture. A naive "first { to last }"
 * scan would splice the quoted object and the report together and fail to
 * parse both. Balanced extraction must pick the report out.
 */
test('the report is found even when the reply also quotes other JSON', () => {
  const quoted = '```json\n{"name":"pkg","version":"1.0.0"}\n```';
  const report = parseReviewOutput(`Here is the config I found:\n\n${quoted}\n\nAnd my review:\n\n${VALID}\n`);
  assert.equal(report.unparsed, undefined);
  assert.equal(report.findings.length, 1);
  assert.equal(report.outcome, 'incorrect');
});

test('nested code_location survives extraction', () => {
  // Two nested levels: findings[0].code_location.line_range. A depth-blind
  // scanner stops at the first `}` and truncates the object.
  const report = parseReviewOutput(`review:\n${VALID}`);
  assert.equal(report.findings[0]!.lineEnd, 12);
});

test('a finding with no title or body is dropped rather than rendered empty', () => {
  const report = parseReviewOutput(JSON.stringify({
    findings: [{ priority: 1 }, { title: 'Real one', body: 'x' }],
    overall_correctness: 'patch is incorrect',
  }));
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0]!.title, 'Real one');
});

test('priority and confidence are clamped to their ranges', () => {
  const report = parseReviewOutput(JSON.stringify({
    findings: [
      { title: 'a', body: 'a', priority: 99, confidence_score: 4 },
      { title: 'b', body: 'b', priority: -3, confidence_score: -1 },
    ],
    overall_correctness: 'patch is incorrect',
  }));
  assert.equal(report.findings[0]!.priority, 3);
  assert.equal(report.findings[0]!.confidenceScore, 1);
  assert.equal(report.findings[1]!.priority, 0);
  assert.equal(report.findings[1]!.confidenceScore, 0);
});

test('a missing priority stays undefined instead of defaulting to a level', () => {
  const report = parseReviewOutput(JSON.stringify({
    findings: [{ title: 'a', body: 'b' }],
    overall_correctness: 'patch is incorrect',
  }));
  // Undefined is not P0 and not P3 — the UI shows 未分级 rather than inventing
  // a severity the reviewer never stated.
  assert.equal(report.findings[0]!.priority, undefined);
});

test('the [Pn] tag is read from the title when the numeric field is absent', () => {
  const report = parseReviewOutput(JSON.stringify({
    findings: [{ title: '[P2] Missing null check', body: 'b' }],
    overall_correctness: 'patch is incorrect',
  }));
  assert.equal(report.findings[0]!.priority, 2);
  assert.equal(report.findings[0]!.title, 'Missing null check');
});

test('the numeric priority field wins over the title tag', () => {
  const report = parseReviewOutput(JSON.stringify({
    findings: [{ title: '[P0] Something', body: 'b', priority: 2 }],
    overall_correctness: 'patch is incorrect',
  }));
  assert.equal(report.findings[0]!.priority, 2);
  assert.equal(report.findings[0]!.title, 'Something');
});

test('an unparsed reply keeps its raw text for the user, bounded', () => {
  const long = `not json at all ${'x'.repeat(REVIEW_RAW_CHARS + 500)}`;
  const report = parseReviewOutput(long);
  assert.equal(report.unparsed, true);
  assert.ok(report.raw);
  assert.ok(report.raw!.length < long.length);
  assert.match(report.raw!, /已截断/);
});

test('overall_correctness is read tolerantly but incorrect wins over correct', () => {
  assert.equal(parseReviewOutput(JSON.stringify({ findings: [], overall_correctness: 'patch is correct' })).outcome, 'correct');
  assert.equal(parseReviewOutput(JSON.stringify({ findings: [], overall_correctness: 'Patch is Incorrect.' })).outcome, 'incorrect');
  assert.equal(parseReviewOutput(JSON.stringify({ findings: [], overall_correctness: 'unclear' })).outcome, 'unknown');
  assert.equal(parseReviewOutput(JSON.stringify({ findings: [] })).outcome, 'unknown');
});

test('stripPriorityTag leaves an untagged title alone', () => {
  assert.deepEqual(stripPriorityTag('Fix the thing'), { title: 'Fix the thing' });
  assert.deepEqual(stripPriorityTag('[P3] Fix the thing'), { title: 'Fix the thing', priority: 3 });
  // Not a priority tag — P4 is outside the scale, so it is part of the title.
  assert.deepEqual(stripPriorityTag('[P4] Fix the thing'), { title: '[P4] Fix the thing' });
});

test('priorityLabel maps 0-3 and refuses anything else', () => {
  assert.equal(priorityLabel(0), 'P0');
  assert.equal(priorityLabel(3), 'P3');
  assert.equal(priorityLabel(undefined), undefined);
  assert.equal(priorityLabel(Number.NaN), undefined);
});
