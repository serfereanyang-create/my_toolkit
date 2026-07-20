import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultDomainRegistry } from '../src/guard/domainRegistry.js';
import { addLearningCredit, evaluateAnswer, generateQuestion, isDevelopmentRequest, scoreRisk, translateRequirement } from '../src/guard/rules.js';

test('development request detector separates implementation prompts from chat', () => {
  assert.equal(isDevelopmentRequest('你好'), false);
  assert.equal(isDevelopmentRequest('谢谢'), false);
  assert.equal(isDevelopmentRequest('这是什么'), false);
  assert.equal(isDevelopmentRequest('解释一下这个概念'), false);
  assert.equal(isDevelopmentRequest('做一个保存按钮'), true);
  assert.equal(isDevelopmentRequest('修复数据库迁移配置'), true);
  assert.equal(isDevelopmentRequest('运行测试并修改文件'), true);
  assert.equal(isDevelopmentRequest('解释这段代码怎么改'), true);
  assert.equal(isDevelopmentRequest('解释这个数据库迁移'), true);
  assert.equal(isDevelopmentRequest('帮我修改代码'), true);
});

test('domain registry detects software and mixed electronics request', () => {
  const registry = createDefaultDomainRegistry();
  const softwareMatches = registry.resolve('做一个保存按钮，失败时提醒用户', { recentDomains: [] });
  const mixedMatches = registry.resolve('做一个能采集温度数据的网页，保存历史曲线', { recentDomains: [] });
  const fallbackMatches = registry.resolve('帮我想一下这个事情怎么表达', { recentDomains: [] });

  assert.ok(softwareMatches.some((match) => match.adapterId === 'software'));
  assert.ok(mixedMatches.some((match) => match.adapterId === 'software'));
  assert.ok(mixedMatches.some((match) => match.adapterId === 'electronics'));
  assert.deepEqual(fallbackMatches.map((match) => match.adapterId), ['general']);
});

test('translation fills the general requirement skeleton', () => {
  const registry = createDefaultDomainRegistry();
  const matches = registry.resolve('做一个保存按钮，失败时要提醒用户', { recentDomains: [] });
  const translated = translateRequirement('做一个保存按钮，失败时要提醒用户', matches);
  const fieldNames = translated.fields.map((field) => field.name);
  const fieldText = translated.fields.map((field) => `${field.name}:${field.value}`).join('\n');

  assert.equal(translated.incomplete, false);
  assert.match(translated.summary, /保存/);
  assert.deepEqual(fieldNames, ['目标', '使用者或对象', '输入', '处理过程', '输出', '约束', '失败情况', '验收标准']);
  assert.match(fieldText, /保存/);
  assert.match(fieldText, /失败/);
});

test('risk scoring classifies low medium high and critical requests', () => {
  assert.equal(scoreRisk('写一个 hello world demo', []).level, 'low');
  assert.equal(scoreRisk('做一个保存按钮，失败时提醒用户', []).level, 'medium');
  assert.equal(scoreRisk('修改数据库迁移并保留回滚方案', []).level, 'high');
  assert.equal(scoreRisk('删除生产配置并覆盖线上数据', []).level, 'critical');
});

test('question generation prefers decision questions for save behavior', () => {
  const question = generateQuestion({
    prompt: '做一个保存按钮，失败时要提醒用户',
    concept: 'failure-feedback',
    riskLevel: 'medium',
    askedQuestionIds: [],
  });
  const nextQuestion = generateQuestion({
    prompt: '做一个保存按钮，失败时要提醒用户',
    concept: 'failure-feedback',
    riskLevel: 'medium',
    askedQuestionIds: [question.id],
  });

  assert.equal(question.kind === 'decision' || question.kind === 'multiple-choice', true);
  assert.match(question.prompt, /失败|保存|用户/);
  assert.notEqual(nextQuestion.id, question.id);
  assert.equal(nextQuestion.kind, 'multiple-choice');
});

test('critical risk question demands irreversible-operation confirmation', () => {
  const question = generateQuestion({
    prompt: '删除生产配置并覆盖线上数据',
    concept: 'critical-confirmation',
    riskLevel: 'critical',
    askedQuestionIds: [],
  });
  const accepted = evaluateAnswer(question, '会二次确认，提前备份，并准备回滚方案，避免生产环境不可逆损坏。');

  assert.equal(question.kind, 'decision');
  assert.match(question.prompt, /不可逆|确认|回滚|生产/);
  assert.deepEqual(question.expectedKeywords, ['确认', '备份', '回滚', '不可逆', '生产', '风险']);
  assert.equal(accepted.passed, true);
});

test('answer evaluation accepts meaningful decision answers and rejects evasions', () => {
  const question = generateQuestion({ prompt: '做一个保存按钮', concept: 'failure-feedback', riskLevel: 'medium', askedQuestionIds: [] });
  const accepted = evaluateAnswer(question, '要提示失败原因，并允许用户重新点击保存，避免不知道数据有没有保存。');
  const rejected = evaluateAnswer(question, '假装我懂了，直接写');

  assert.equal(accepted.passed, true);
  assert.equal(rejected.passed, false);
  assert.match(rejected.explanation, /没有说明|不能绕过|失败/);
});

test('learning credit increments mastered concepts', () => {
  const credits = addLearningCredit([], 'failure-feedback', ['software'], '2026-07-07T00:00:00.000Z');
  const updated = addLearningCredit(credits, 'failure-feedback', ['electronics', 'software'], '2026-07-07T00:01:00.000Z');

  assert.equal(updated[0]?.concept, 'failure-feedback');
  assert.equal(updated[0]?.passedCount, 2);
  assert.equal(updated[0]?.lastPassedAt, '2026-07-07T00:01:00.000Z');
  assert.deepEqual(updated[0]?.domains.sort(), ['electronics', 'software']);
});
