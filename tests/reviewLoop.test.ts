import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVerdict,
  buildReviewerPrompt,
  buildRevisePrompt,
  runReviewLoop,
  type ReviewVerdict,
} from '../src/subagent/reviewLoop.js';

test('parseVerdict extracts JSON verdict from noisy text', () => {
  const v = parseVerdict('评审如下：\n{"score": 92, "approved": true, "issues": [], "summary": "很好"}\n完毕');
  assert.ok(v);
  assert.equal(v.score, 92);
  assert.equal(v.approved, true);
  assert.equal(v.summary, '很好');
});

test('parseVerdict rejects garbage and clamps score', () => {
  assert.equal(parseVerdict('没有 JSON'), null);
  assert.equal(parseVerdict('{ broken'), null);
  const v = parseVerdict('{"score": 150, "approved": false}');
  assert.ok(v);
  assert.equal(v.score, 100, 'score 钳制到 0-100');
});

test('buildReviewerPrompt demands strict JSON and lists acceptance', () => {
  const prompt = buildReviewerPrompt('candidate code', ['覆盖边界', '无回归']);
  assert.ok(prompt.includes('"score"'));
  assert.ok(prompt.includes('覆盖边界'));
  assert.ok(prompt.includes('candidate code'));
});

test('buildRevisePrompt carries issues and previous candidate', () => {
  const verdict: ReviewVerdict = { score: 40, approved: false, issues: ['缺少空值处理'], summary: '不完整' };
  const prompt = buildRevisePrompt('原始任务', '上一版', verdict);
  assert.ok(prompt.includes('缺少空值处理'));
  assert.ok(prompt.includes('上一版'));
  assert.ok(prompt.startsWith('原始任务'));
});

test('runReviewLoop stops early when approved', async () => {
  let generateCalls = 0;
  const result = await runReviewLoop({
    task: 't',
    acceptance: [],
    generate: async () => {
      generateCalls += 1;
      return `v${generateCalls}`;
    },
    review: async () => ({ score: 95, approved: true, issues: [], summary: 'ok' }),
  });
  assert.equal(generateCalls, 1);
  assert.equal(result.approved, true);
  assert.equal(result.iterations, 1);
  assert.equal(result.best, 'v1');
});

test('runReviewLoop revises until threshold then returns best', async () => {
  const verdicts: ReviewVerdict[] = [
    { score: 50, approved: false, issues: ['缺测试'], summary: 'no' },
    { score: 85, approved: false, issues: [], summary: 'better' },
  ];
  let round = 0;
  const result = await runReviewLoop({
    task: 't',
    acceptance: ['有测试'],
    generate: async (prompt) => {
      round += 1;
      assert.ok(round <= 3);
      return round === 1 ? 'first' : `revised:${prompt.length > 0}`;
    },
    review: async () => verdicts.shift()!,
    options: { maxRounds: 3 },
  });
  assert.equal(result.iterations, 2);
  assert.equal(result.approved, true, '85 >= 默认阈值 80');
  assert.equal(result.finalScore, 85);
});

test('runReviewLoop returns first candidate when review unavailable', async () => {
  const result = await runReviewLoop({
    task: 't',
    acceptance: [],
    generate: async () => 'only',
    review: async () => null,
  });
  assert.equal(result.best, 'only');
  assert.equal(result.approved, false);
  assert.equal(result.iterations, 1);
  assert.match(result.rounds[0]!.verdict.issues[0]!, /评审未返回/);
});

test('runReviewLoop exhausts rounds and keeps best-scoring candidate', async () => {
  const scores = [30, 70, 55];
  let i = 0;
  const result = await runReviewLoop({
    task: 't',
    acceptance: [],
    generate: async () => `c${i}`,
    review: async () => ({ score: scores[i++]!, approved: false, issues: ['x'], summary: '' }),
    options: { maxRounds: 3 },
  });
  assert.equal(result.iterations, 3);
  assert.equal(result.approved, false);
  assert.equal(result.finalScore, 70);
  assert.equal(result.best, 'c1', '保留最高分轮次');
});
