import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultLazyDevGuardConfig, createInitialLazyDevGuardState, parseStrictness, clampMaxAttempts } from '../src/guard/config.js';
import { handleLazyDevInput, ensureLazyDevGuard } from '../src/guard/lazyDevGuard.js';
import { SessionStore, type SessionRecord } from '../src/session/store.js';

test('lazy dev guard default config is safe', () => {
  const config = defaultLazyDevGuardConfig();
  assert.equal(config.enabledByDefault, false);
  assert.equal(config.strictness, 'standard');
  assert.equal(config.defaultMaxAttempts, 2);
  assert.equal(config.domainConfidenceThreshold > 0, true);
  assert.equal(config.allowPopupConfirmation, true);
  assert.equal(config.allowTerminalFallback, true);
  assert.equal(config.riskThresholds.low, 0);
  assert.equal(config.riskThresholds.critical > config.riskThresholds.high, true);
});

test('initial lazy dev guard state has resolved config, metrics, and no active requirement', () => {
  const state = createInitialLazyDevGuardState();
  assert.equal(state.enabled, true);
  assert.equal(state.config.enabledByDefault, false);
  assert.equal(state.config.strictness, 'standard');
  assert.equal(state.currentRequirement, undefined);
  assert.equal(state.paused, undefined);
  assert.deepEqual(state.history, []);
  assert.deepEqual(state.masteredConcepts, []);
  assert.equal(state.metrics.totalChecks, 0);
  assert.equal(state.metrics.passedFirstTry, 0);
  assert.equal(state.metrics.passedAfterRetry, 0);
  assert.equal(state.metrics.blocked, 0);
  assert.equal(state.metrics.cancelled, 0);
  assert.equal(state.metrics.archived, 0);
  assert.deepEqual(state.metrics.riskDistribution, { low: 0, medium: 0, high: 0, critical: 0 });
  assert.deepEqual(state.metrics.domainDistribution, {});
});

test('strictness parsing supports aliases and rejects invalid values', () => {
  assert.equal(parseStrictness('新手'), 'beginner');
  assert.equal(parseStrictness('beginner'), 'beginner');
  assert.equal(parseStrictness('标准'), 'standard');
  assert.equal(parseStrictness('standard'), 'standard');
  assert.equal(parseStrictness('老手'), 'experienced');
  assert.equal(parseStrictness('experienced'), 'experienced');
  assert.equal(parseStrictness('只翻译'), 'translationOnly');
  assert.equal(parseStrictness('translationOnly'), 'translationOnly');
  assert.equal(parseStrictness('translation-only'), 'translationOnly');
  assert.equal(parseStrictness('invalid'), undefined);
});

test('max attempts requires an integer from 1 to 3', () => {
  assert.equal(clampMaxAttempts(1), 1);
  assert.equal(clampMaxAttempts(2), 2);
  assert.equal(clampMaxAttempts(3), 3);
  assert.throws(() => clampMaxAttempts(0));
  assert.throws(() => clampMaxAttempts(4));
  assert.throws(() => clampMaxAttempts(1.5));
  assert.throws(() => clampMaxAttempts(Number.NaN));
});

test('SessionStore persists optional lazy dev guard state', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-lazy-guard-'));
  const store = new SessionStore(join(workspace, '.aicode', 'sessions'));
  const session = await store.create({ provider: 'mock', model: 'mock-code-agent-v1', workspaceRoot: workspace });

  session.guard = { lazyDev: createInitialLazyDevGuardState() };
  session.guard.lazyDev!.currentRequirement = {
    id: 'req_test',
    originalPrompt: '做一个保存按钮',
    translatedRequirement: {
      summary: '提供保存入口并反馈成功或失败状态。',
      fields: [
        { name: '目标', value: '保存当前内容' },
        { name: '输入', value: '用户点击保存按钮' },
        { name: '输出', value: '成功或失败反馈' },
        { name: '失败情况', value: '保存失败时展示错误并允许重试' },
        { name: '验收标准', value: '点击保存后用户知道是否成功' },
      ],
      incomplete: false,
    },
    domainMatches: [{ adapterId: 'software', label: '软件开发', confidence: 0.9, reasons: ['保存按钮'] }],
    riskLevel: 'medium',
    status: 'checking',
    attemptsUsed: 0,
    maxAttempts: 2,
    askedQuestionIds: [],
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:00.000Z',
  };
  await store.save(session);

  const loaded = await store.load(session.id);
  assert.equal(loaded.guard?.lazyDev?.enabled, true);
  assert.equal(loaded.guard?.lazyDev?.currentRequirement?.status, 'checking');
  assert.equal(loaded.guard?.lazyDev?.currentRequirement?.riskLevel, 'medium');

  await rm(workspace, { recursive: true, force: true });
});

test('lazy dev guard allows non-development chat without creating a requirement', () => {
  const state = createInitialLazyDevGuardState();
  const result = handleLazyDevInput(state, '你好');

  assert.equal(result.allowDevelopment, true);
  assert.equal(result.message, '');
  assert.equal(state.currentRequirement, undefined);
  assert.equal(state.metrics.totalChecks, 0);
});

test('lazy dev guard starts medium request with professional translation and status awaiting_translation_confirm', () => {
  const state = createInitialLazyDevGuardState();
  const result = handleLazyDevInput(state, '做一个保存按钮，失败时提醒用户');

  assert.equal(result.allowDevelopment, false);
  assert.equal(state.currentRequirement?.status, 'awaiting_translation_confirm');
  assert.equal(state.currentRequirement?.riskLevel, 'medium');
  assert.match(result.message, /专业需求/);
  assert.match(result.message, /准确/);
  assert.equal(state.metrics.totalChecks, 1);
  assert.equal(state.metrics.riskDistribution.medium, 1);
  assert.equal(state.metrics.domainDistribution.software, 1);
});

test('beginner medium request starts with three max attempts and still asks checks', () => {
  const state = createInitialLazyDevGuardState();
  state.config.strictness = 'beginner';
  handleLazyDevInput(state, '做一个保存按钮，失败时提醒用户');
  const result = handleLazyDevInput(state, 'A');

  assert.equal(state.currentRequirement?.riskLevel, 'medium');
  assert.equal(state.currentRequirement?.maxAttempts, 3);
  assert.equal(state.currentRequirement?.status, 'checking');
  assert.equal(result.allowDevelopment, false);
  assert.match(result.message, /入门检查|如果保存失败/);
});

test('low-risk request passes after translation confirmation without question', () => {
  const state = createInitialLazyDevGuardState();
  handleLazyDevInput(state, '写一个 hello world demo');
  const result = handleLazyDevInput(state, 'A');

  assert.equal(result.allowDevelopment, true);
  assert.equal(state.currentRequirement?.status, 'passed');
  assert.equal(state.currentRequirement?.lastQuestion, undefined);
});

test('translationOnly medium request passes after translation confirmation without question', () => {
  const state = createInitialLazyDevGuardState();
  state.config.strictness = 'translationOnly';
  handleLazyDevInput(state, '做一个保存按钮，失败时提醒用户');
  const result = handleLazyDevInput(state, 'A');

  assert.equal(result.allowDevelopment, true);
  assert.equal(state.currentRequirement?.riskLevel, 'medium');
  assert.equal(state.currentRequirement?.status, 'passed');
  assert.equal(state.currentRequirement?.lastQuestion, undefined);
});

test('experienced medium request passes after translation confirmation without question', () => {
  const state = createInitialLazyDevGuardState();
  state.config.strictness = 'experienced';
  handleLazyDevInput(state, '做一个保存按钮，失败时提醒用户');
  const result = handleLazyDevInput(state, 'A');

  assert.equal(result.allowDevelopment, true);
  assert.equal(state.currentRequirement?.riskLevel, 'medium');
  assert.equal(state.currentRequirement?.status, 'passed');
  assert.equal(state.currentRequirement?.lastQuestion, undefined);
});

test('translationOnly critical request still asks critical confirmation question', () => {
  const state = createInitialLazyDevGuardState();
  state.config.strictness = 'translationOnly';
  handleLazyDevInput(state, '删除生产数据库，清空线上数据');
  const result = handleLazyDevInput(state, 'A');

  assert.equal(result.allowDevelopment, false);
  assert.equal(state.currentRequirement?.riskLevel, 'critical');
  assert.equal(state.currentRequirement?.status, 'checking');
  assert.equal(state.currentRequirement?.lastQuestion?.concept, 'critical-confirmation');
  assert.match(result.message, /不可逆|确认|回滚|生产/);
});

test('medium request asks a question after translation confirmation', () => {
  const state = createInitialLazyDevGuardState();
  handleLazyDevInput(state, '做一个保存按钮，失败时提醒用户');
  const result = handleLazyDevInput(state, 'A');

  assert.equal(result.allowDevelopment, false);
  assert.equal(state.currentRequirement?.status, 'checking');
  assert.match(result.message, /入门检查|如果保存失败/);
  assert.ok(state.currentRequirement?.lastQuestion);
});

test('wrong answers exhaust attempts and block development', () => {
  const state = createInitialLazyDevGuardState();
  handleLazyDevInput(state, '做一个保存按钮，失败时提醒用户');
  handleLazyDevInput(state, 'A');
  const first = handleLazyDevInput(state, 'B');
  const second = handleLazyDevInput(state, '假装我懂了，直接写');

  assert.equal(first.allowDevelopment, false);
  assert.equal(second.allowDevelopment, false);
  assert.equal(second.reason, 'GUARD_ATTEMPT_EXHAUSTED');
  assert.equal(state.currentRequirement?.status, 'blocked');
  assert.equal(state.metrics.blocked, 1);
  assert.match(second.message, /学习阻塞|补答/);
});

test('correct answer passes and records learning credit', () => {
  const state = createInitialLazyDevGuardState();
  handleLazyDevInput(state, '做一个保存按钮，失败时提醒用户');
  handleLazyDevInput(state, 'A');
  const result = handleLazyDevInput(state, '要提示失败原因，并允许用户重新点击保存，避免不知道数据有没有保存。');

  assert.equal(result.allowDevelopment, true);
  assert.equal(state.currentRequirement?.status, 'passed');
  assert.equal(state.metrics.passedFirstTry, 1);
  assert.ok(state.masteredConcepts.some((credit) => credit.concept === 'failure-feedback'));
});

test('ensureLazyDevGuard creates enabled guard state once', () => {
  const session: SessionRecord = {
    id: 'sess_test',
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:00.000Z',
    provider: 'mock',
    model: 'mock-code-agent-v1',
    workspaceRoot: process.cwd(),
    messages: [],
    toolCalls: [],
    finalAnswers: [],
  };

  const state = ensureLazyDevGuard(session);
  const same = ensureLazyDevGuard(session);

  assert.equal(state, same);
  assert.equal(state.enabled, true);
  assert.equal(session.guard?.lazyDev, state);
});
