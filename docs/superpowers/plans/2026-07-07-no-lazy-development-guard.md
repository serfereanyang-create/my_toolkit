# No Lazy Development Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the built-in CLI guard `/不准偷懒开发` so development requests are translated, risk-rated, checked for beginner understanding, and hard-blocked before tool execution when the user has not passed.

**Architecture:** Add a rule-based `guard/` subsystem that owns state, domain/risk analysis, question generation, learning credit, and command behavior. Keep `agent/agent.ts` focused on tool execution; intercept user input in `cli/repl.ts` before `runAgentTurn`. Persist guard state inside `SessionRecord` so resumed sessions keep the same guard policy.

**Tech Stack:** TypeScript, Node.js built-in test runner, existing CLI runtime, existing session JSON persistence, no external LLM dependency, no remote telemetry.

---

## Scope Notes

- The current workspace is not a git repository, so this plan uses verification checkpoints instead of commit steps.
- First implementation is rule-based. LLM-assisted translation/question generation is intentionally excluded.
- The first domain set includes software, electronics/example hardware, content, design, game/interactive, and unknown/general adapters. Software coverage should be strongest for MVP.
- The guard must never rely on prompt text alone. It must block before `runAgentTurn` can call provider or tools.

## File Structure

- Create `cli/src/guard/types.ts`: guard state, requirement, risk, domain, question, metrics, and result types.
- Create `cli/src/guard/config.ts`: default config, safe config updates, Chinese strictness parsing.
- Create `cli/src/guard/domainRegistry.ts`: domain adapters and multi-domain scoring.
- Create `cli/src/guard/rules.ts`: translation, risk scoring, question generation, answer evaluation, learning credit helpers.
- Create `cli/src/guard/lazyDevGuard.ts`: state machine and public guard entry points.
- Create `cli/src/guard/confirm.ts`: popup-capable interface shape and terminal fallback result helpers.
- Modify `cli/src/session/store.ts`: allow optional `guard.lazyDev` state to persist with sessions.
- Modify `cli/src/cli/commands.ts`: add `/不准偷懒开发` command family and help output.
- Modify `cli/src/cli/repl.ts`: intercept prompt and interactive input before `runAgentTurn`.
- Modify `cli/README.md`: document guard usage.
- Create `cli/tests/lazyDevGuard.state.test.ts`: state, persistence, config, and metrics tests.
- Create `cli/tests/lazyDevGuard.rules.test.ts`: domain, risk, translation, question, and learning credit tests.
- Create `cli/tests/lazyDevGuard.commands.test.ts`: slash command tests.
- Create `cli/tests/lazyDevGuard.integration.test.ts`: hard-interception and prompt-mode tests.

---

### Task 1: Guard Types, Defaults, and Session Persistence

**Files:**
- Create: `cli/src/guard/types.ts`
- Create: `cli/src/guard/config.ts`
- Modify: `cli/src/session/store.ts`
- Test: `cli/tests/lazyDevGuard.state.test.ts`

- [ ] **Step 1: Write failing persistence and default-config tests**

Create `cli/tests/lazyDevGuard.state.test.ts` with:

```ts
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultLazyDevGuardConfig, createInitialLazyDevGuardState } from '../src/guard/config.js';
import { SessionStore } from '../src/session/store.js';

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

test('initial lazy dev guard state has metrics and no active requirement', () => {
  const state = createInitialLazyDevGuardState();
  assert.equal(state.enabled, true);
  assert.equal(state.currentRequirement, undefined);
  assert.deepEqual(state.history, []);
  assert.deepEqual(state.masteredConcepts, []);
  assert.equal(state.metrics.totalChecks, 0);
});

test('SessionStore persists optional lazy dev guard state', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-lazy-guard-'));
  const store = new SessionStore(join(workspace, '.aicode', 'sessions'));
  const session = await store.create({ provider: 'mock', model: 'mock-code-agent-v1', workspaceRoot: workspace });

  session.guard = { lazyDev: createInitialLazyDevGuardState() };
  session.guard.lazyDev.currentRequirement = {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd cli && npm test -- --test-name-pattern="lazy dev guard"
```

Expected: TypeScript build fails because `../src/guard/config.js` and guard types do not exist.

- [ ] **Step 3: Create guard types**

Create `cli/src/guard/types.ts`:

```ts
export type LazyDevStrictness = 'beginner' | 'standard' | 'experienced' | 'translationOnly';
export type GuardRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type RequirementStatus = 'translating' | 'awaiting_translation_confirm' | 'checking' | 'passed' | 'blocked' | 'learning' | 'cancelled' | 'archived';

export type ProfessionalRequirementField = {
  name: string;
  value: string;
};

export type ProfessionalRequirement = {
  summary: string;
  fields: ProfessionalRequirementField[];
  incomplete: boolean;
  missingFields?: string[];
};

export type DomainMatch = {
  adapterId: string;
  label: string;
  confidence: number;
  reasons: string[];
};

export type GuardQuestion = {
  id: string;
  prompt: string;
  kind: 'multiple-choice' | 'short-answer' | 'decision';
  concept: string;
  options?: Array<{ label: string; text: string; correct: boolean; explanation: string }>;
  expectedKeywords?: string[];
};

export type BlockedRecovery = {
  learningTasks: string[];
  resumeCondition: 'answer-new-question' | 'explain-in-own-words' | 'rewrite-requirement';
  resumeCommand: '/不准偷懒开发 继续';
};

export type LearningCredit = {
  concept: string;
  passedCount: number;
  lastPassedAt: string;
  domains: string[];
};

export type GuardMetrics = {
  totalChecks: number;
  passedFirstTry: number;
  passedAfterRetry: number;
  blocked: number;
  cancelled: number;
  archived: number;
  riskDistribution: Record<GuardRiskLevel, number>;
  domainDistribution: Record<string, number>;
};

export type LazyDevGuardConfig = {
  enabledByDefault: boolean;
  strictness: LazyDevStrictness;
  defaultMaxAttempts: number;
  domainConfidenceThreshold: number;
  riskThresholds: Record<GuardRiskLevel, number>;
  allowPopupConfirmation: boolean;
  allowTerminalFallback: boolean;
};

export type LazyDevPause = {
  reason: string;
  createdAt: string;
  resumeHint: string;
};

export type LazyDevRequirement = {
  id: string;
  originalPrompt: string;
  translatedRequirement: ProfessionalRequirement;
  domainMatches: DomainMatch[];
  riskLevel: GuardRiskLevel;
  status: RequirementStatus;
  attemptsUsed: number;
  maxAttempts: number;
  askedQuestionIds: string[];
  lastQuestion?: GuardQuestion;
  blockedReason?: string;
  recovery?: BlockedRecovery;
  createdAt: string;
  updatedAt: string;
};

export type LazyDevRequirementSummary = {
  id: string;
  originalPrompt: string;
  status: RequirementStatus;
  riskLevel: GuardRiskLevel;
  domainLabels: string[];
  createdAt: string;
  updatedAt: string;
};

export type LazyDevGuardState = {
  enabled: boolean;
  config: LazyDevGuardConfig;
  paused?: LazyDevPause;
  currentRequirement?: LazyDevRequirement;
  history: LazyDevRequirementSummary[];
  metrics: GuardMetrics;
  masteredConcepts: LearningCredit[];
};
```

- [ ] **Step 4: Create default config and initial state helpers**

Create `cli/src/guard/config.ts`:

```ts
import type { GuardMetrics, LazyDevGuardConfig, LazyDevGuardState, LazyDevStrictness } from './types.js';

export function defaultLazyDevGuardConfig(): LazyDevGuardConfig {
  return {
    enabledByDefault: false,
    strictness: 'standard',
    defaultMaxAttempts: 2,
    domainConfidenceThreshold: 0.45,
    riskThresholds: {
      low: 0,
      medium: 30,
      high: 65,
      critical: 90,
    },
    allowPopupConfirmation: true,
    allowTerminalFallback: true,
  };
}

export function createInitialLazyDevGuardState(config: Partial<LazyDevGuardConfig> = {}): LazyDevGuardState {
  return {
    enabled: true,
    config: { ...defaultLazyDevGuardConfig(), ...config },
    history: [],
    metrics: createEmptyGuardMetrics(),
    masteredConcepts: [],
  };
}

export function createEmptyGuardMetrics(): GuardMetrics {
  return {
    totalChecks: 0,
    passedFirstTry: 0,
    passedAfterRetry: 0,
    blocked: 0,
    cancelled: 0,
    archived: 0,
    riskDistribution: { low: 0, medium: 0, high: 0, critical: 0 },
    domainDistribution: {},
  };
}

export function parseStrictness(value: string): LazyDevStrictness | undefined {
  const normalized = value.trim().toLowerCase();
  if (['新手', 'beginner'].includes(normalized)) return 'beginner';
  if (['标准', 'standard'].includes(normalized)) return 'standard';
  if (['老手', 'experienced'].includes(normalized)) return 'experienced';
  if (['只翻译', 'translationonly', 'translation-only'].includes(normalized)) return 'translationOnly';
  return undefined;
}

export function clampMaxAttempts(value: number) {
  if (!Number.isInteger(value)) throw new Error('最大补答次数必须是整数');
  if (value < 1 || value > 3) throw new Error('最大补答次数必须在 1 到 3 之间');
  return value;
}
```

- [ ] **Step 5: Extend session type**

Modify `cli/src/session/store.ts` by importing the guard type and extending `SessionRecord`:

```ts
import type { LazyDevGuardState } from '../guard/types.js';
```

Add this field to `SessionRecord`:

```ts
guard?: {
  lazyDev?: LazyDevGuardState;
};
```

- [ ] **Step 6: Run state tests**

Run:

```bash
cd cli && npm test -- --test-name-pattern="lazy dev guard"
```

Expected: the new state tests pass, or later guard-rule imports are the only missing pieces if subsequent test files already exist.

- [ ] **Step 7: Verification checkpoint**

Run:

```bash
cd cli && npm run typecheck
```

Expected: PASS.

---

### Task 2: Domain Registry, Risk Scoring, and Translation Rules

**Files:**
- Create: `cli/src/guard/domainRegistry.ts`
- Create: `cli/src/guard/rules.ts`
- Test: `cli/tests/lazyDevGuard.rules.test.ts`

- [ ] **Step 1: Write failing domain and risk tests**

Create `cli/tests/lazyDevGuard.rules.test.ts` with:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultDomainRegistry } from '../src/guard/domainRegistry.js';
import { addLearningCredit, evaluateAnswer, generateQuestion, scoreRisk, translateRequirement } from '../src/guard/rules.js';

test('domain registry detects software and mixed electronics request', () => {
  const registry = createDefaultDomainRegistry();
  const matches = registry.resolve('做一个能采集温度数据的网页，保存历史曲线', { recentDomains: [] });
  assert.ok(matches.some((match) => match.adapterId === 'software'));
  assert.ok(matches.some((match) => match.adapterId === 'electronics'));
});

test('translation fills the general requirement skeleton', () => {
  const registry = createDefaultDomainRegistry();
  const matches = registry.resolve('做一个保存按钮，失败时要提醒用户', { recentDomains: [] });
  const translated = translateRequirement('做一个保存按钮，失败时要提醒用户', matches);
  assert.equal(translated.incomplete, false);
  assert.match(translated.summary, /保存/);
  assert.ok(translated.fields.some((field) => field.name === '目标'));
  assert.ok(translated.fields.some((field) => field.name === '失败情况'));
  assert.ok(translated.fields.some((field) => field.name === '验收标准'));
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
  assert.equal(question.kind === 'decision' || question.kind === 'multiple-choice', true);
  assert.match(question.prompt, /失败|保存|用户/);
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
  const updated = addLearningCredit(credits, 'failure-feedback', ['software'], '2026-07-07T00:01:00.000Z');
  assert.equal(updated[0]?.concept, 'failure-feedback');
  assert.equal(updated[0]?.passedCount, 2);
});
```

- [ ] **Step 2: Run rules tests to verify failure**

Run:

```bash
cd cli && npm test -- --test-name-pattern="domain registry|translation|risk scoring|question generation|answer evaluation|learning credit"
```

Expected: build fails because `domainRegistry.ts` and `rules.ts` do not exist.

- [ ] **Step 3: Implement domain registry**

Create `cli/src/guard/domainRegistry.ts`:

```ts
import type { DomainMatch } from './types.js';

export type GuardContext = {
  recentDomains: string[];
};

export type DomainAdapter = {
  id: string;
  label: string;
  keywords: string[];
  intentPatterns: string[];
  requirementFields: string[];
  beginnerConcepts: string[];
  questionStrategies: string[];
  maxAttemptsOverride?: number;
};

export class DomainRegistry {
  private readonly adapters: DomainAdapter[] = [];

  register(adapter: DomainAdapter) {
    this.adapters.push(adapter);
  }

  resolve(text: string, context: GuardContext): DomainMatch[] {
    const lower = text.toLowerCase();
    const matches = this.adapters
      .map((adapter) => {
        let score = 0;
        const reasons: string[] = [];
        for (const keyword of adapter.keywords) {
          if (lower.includes(keyword.toLowerCase())) {
            score += 18;
            reasons.push(keyword);
          }
        }
        for (const pattern of adapter.intentPatterns) {
          if (new RegExp(pattern, 'i').test(text)) {
            score += 22;
            reasons.push(pattern);
          }
        }
        if (context.recentDomains.includes(adapter.id)) score += 8;
        return { adapterId: adapter.id, label: adapter.label, confidence: Math.min(score / 100, 1), reasons };
      })
      .filter((match) => match.confidence >= 0.2)
      .sort((a, b) => b.confidence - a.confidence);

    return matches.length > 0 ? matches : [{ adapterId: 'general', label: '通用需求', confidence: 0.25, reasons: ['fallback'] }];
  }

  getAll() {
    return [...this.adapters];
  }
}

export function createDefaultDomainRegistry() {
  const registry = new DomainRegistry();
  registry.register({
    id: 'software',
    label: '软件开发',
    keywords: ['网页', '按钮', '前端', '后端', '数据库', '接口', 'api', '保存', '登录', '组件', '页面', '代码'],
    intentPatterns: ['做一个', '实现', '开发', '修复', '添加', '修改'],
    requirementFields: ['前端表现', '数据流', '接口或存储', '失败反馈', '测试点'],
    beginnerConcepts: ['input-output', 'failure-feedback', 'persistence', 'acceptance-criteria'],
    questionStrategies: ['decision', 'multiple-choice'],
  });
  registry.register({
    id: 'electronics',
    label: '电子信息',
    keywords: ['传感器', '采集', '温度', '电压', '滤波', '串口', '通信', '采样', '嵌入式'],
    intentPatterns: ['采集', '测量', '控制', '通信'],
    requirementFields: ['采集对象', '接口', '精度', '时序', '可靠性'],
    beginnerConcepts: ['sampling', 'signal-noise', 'interface'],
    questionStrategies: ['decision'],
  });
  registry.register({
    id: 'content',
    label: '内容创作',
    keywords: ['文章', '视频', '脚本', '文案', '海报', '标题'],
    intentPatterns: ['写一篇', '生成', '改写'],
    requirementFields: ['受众', '风格', '素材', '结构', '交付格式'],
    beginnerConcepts: ['audience', 'style', 'structure'],
    questionStrategies: ['short-answer'],
  });
  registry.register({
    id: 'design',
    label: '设计与视觉',
    keywords: ['布局', '颜色', '动效', '界面', '图标', '视觉'],
    intentPatterns: ['设计', '美化', '排版'],
    requirementFields: ['场景', '布局', '色彩', '可访问性', '交付格式'],
    beginnerConcepts: ['layout', 'contrast', 'user-flow'],
    questionStrategies: ['decision'],
  });
  registry.register({
    id: 'game',
    label: '游戏或互动',
    keywords: ['游戏', '玩家', '关卡', '得分', '规则', '互动'],
    intentPatterns: ['做个.*游戏', '设计.*玩法'],
    requirementFields: ['玩家目标', '规则', '反馈', '失败条件', '平衡性'],
    beginnerConcepts: ['feedback-loop', 'rules', 'state'],
    questionStrategies: ['decision'],
  });
  return registry;
}
```

- [ ] **Step 4: Implement rules**

Create `cli/src/guard/rules.ts`:

```ts
import type { DomainMatch, GuardQuestion, GuardRiskLevel, LearningCredit, ProfessionalRequirement } from './types.js';

export function translateRequirement(prompt: string, domains: DomainMatch[]): ProfessionalRequirement {
  const goal = inferGoal(prompt);
  const input = prompt.includes('点击') || prompt.includes('按钮') ? '用户触发界面操作' : '用户提供的需求和上下文';
  const output = inferOutput(prompt);
  const failure = inferFailure(prompt);
  const acceptance = inferAcceptance(prompt);
  const fields = [
    { name: '目标', value: goal },
    { name: '使用者或对象', value: '当前 CLI 用户或目标功能的最终使用者' },
    { name: '输入', value: input },
    { name: '处理过程', value: inferProcess(prompt, domains) },
    { name: '输出', value: output },
    { name: '约束', value: inferConstraints(prompt) },
    { name: '失败情况', value: failure },
    { name: '验收标准', value: acceptance },
  ];
  const missingFields = fields.filter((field) => field.value.length < 4).map((field) => field.name);
  return {
    summary: `${goal}；输出应体现：${output}`,
    fields,
    incomplete: missingFields.length > 0,
    missingFields: missingFields.length > 0 ? missingFields : undefined,
  };
}

export function scoreRisk(prompt: string, domains: DomainMatch[]): { level: GuardRiskLevel; score: number; reasons: string[] } {
  const lower = prompt.toLowerCase();
  let score = 10;
  const reasons: string[] = [];
  const add = (points: number, reason: string) => {
    score += points;
    reasons.push(reason);
  };
  if (/hello world|demo|示例|文案|只读|解释/.test(lower)) add(-8, 'low-impact-demo-or-readonly');
  if (/保存|写入|修改|添加|实现|按钮|页面|组件/.test(lower)) add(28, 'modifies-feature-or-files');
  if (/数据库|迁移|认证|权限|支付|批量|token|密钥/.test(lower)) add(55, 'sensitive-system-area');
  if (/删除|覆盖|生产|线上|不可逆|格式化|清空/.test(lower)) add(88, 'critical-or-irreversible');
  if (domains.some((domain) => domain.adapterId === 'electronics')) add(12, 'hardware-or-signal-context');
  const bounded = Math.max(0, Math.min(score, 100));
  if (bounded >= 90) return { level: 'critical', score: bounded, reasons };
  if (bounded >= 65) return { level: 'high', score: bounded, reasons };
  if (bounded >= 30) return { level: 'medium', score: bounded, reasons };
  return { level: 'low', score: bounded, reasons };
}

export function generateQuestion(input: { prompt: string; concept: string; riskLevel: GuardRiskLevel; askedQuestionIds: string[] }): GuardQuestion {
  const baseId = `${input.concept}-${input.riskLevel}`;
  const variant = input.askedQuestionIds.includes(`${baseId}-decision`) ? 'multiple' : 'decision';
  if (variant === 'decision') {
    return {
      id: `${baseId}-decision`,
      kind: 'decision',
      concept: input.concept,
      prompt: decisionPrompt(input.prompt, input.riskLevel),
      expectedKeywords: ['用户', '失败', '提示', '重试', '数据', '原因'],
    };
  }
  return {
    id: `${baseId}-multiple`,
    kind: 'multiple-choice',
    concept: input.concept,
    prompt: '如果保存失败，界面应该怎么告诉用户，为什么不能只在控制台报错？',
    options: [
      { label: 'A', text: '因为用户看不到控制台，需要界面反馈并保留可重试路径', correct: true, explanation: '正确。用户需要看到失败原因和下一步动作。' },
      { label: 'B', text: '因为控制台会自动保存数据', correct: false, explanation: '错误。控制台不会自动保存数据，也不是用户反馈通道。' },
      { label: 'C', text: '因为按钮颜色会变好看', correct: false, explanation: '错误。颜色不是失败处理和数据可靠性的核心。' },
      { label: 'D', text: '因为前端不需要处理失败', correct: false, explanation: '错误。前端必须给用户可理解的失败反馈。' },
    ],
  };
}

export function evaluateAnswer(question: GuardQuestion, answer: string): { passed: boolean; explanation: string } {
  const normalized = answer.trim().toLowerCase();
  if (/假装|直接写|别问|跳过|不管/.test(normalized)) {
    return { passed: false, explanation: '不能绕过守门。答案没有说明失败、用户反馈或取舍。' };
  }
  if (question.kind === 'multiple-choice') {
    const selected = normalized.slice(0, 1).toUpperCase();
    const option = question.options?.find((item) => item.label === selected);
    return option?.correct ? { passed: true, explanation: option.explanation } : { passed: false, explanation: option?.explanation ?? '请选择一个有效选项。' };
  }
  const keywords = question.expectedKeywords ?? [];
  const hitCount = keywords.filter((keyword) => normalized.includes(keyword.toLowerCase())).length;
  return hitCount >= 2
    ? { passed: true, explanation: '回答说明了关键取舍，可以继续。' }
    : { passed: false, explanation: '回答没有说明用户看到什么、失败后如何处理，或为什么这样设计。' };
}

export function addLearningCredit(credits: LearningCredit[], concept: string, domains: string[], now: string): LearningCredit[] {
  const existing = credits.find((credit) => credit.concept === concept);
  if (!existing) return [...credits, { concept, domains, passedCount: 1, lastPassedAt: now }];
  return credits.map((credit) =>
    credit.concept === concept
      ? { ...credit, passedCount: credit.passedCount + 1, lastPassedAt: now, domains: Array.from(new Set([...credit.domains, ...domains])) }
      : credit,
  );
}

function inferGoal(prompt: string) {
  if (prompt.includes('保存')) return '让用户能够保存当前内容';
  if (prompt.includes('采集')) return '采集并呈现目标数据';
  if (/hello world/i.test(prompt)) return '创建一个最小可运行示例';
  return `实现用户描述的目标：${prompt.slice(0, 60)}`;
}

function inferOutput(prompt: string) {
  if (prompt.includes('保存')) return '保存成功或失败的明确反馈';
  if (prompt.includes('网页')) return '用户可见的网页功能';
  return '可验证的结果或成品';
}

function inferFailure(prompt: string) {
  if (prompt.includes('失败')) return '按用户要求展示失败原因和下一步动作';
  if (prompt.includes('保存')) return '保存失败时提示原因，并保留重试路径';
  return '执行失败时说明原因，不静默失败';
}

function inferAcceptance(prompt: string) {
  if (prompt.includes('保存')) return '用户触发保存后能确认成功或失败';
  return '用户能按描述验证功能是否完成';
}

function inferProcess(prompt: string, domains: DomainMatch[]) {
  const labels = domains.map((domain) => domain.label).join('、') || '通用需求';
  return `按${labels}的字段拆解并实现最小可验证流程：${prompt.slice(0, 40)}`;
}

function inferConstraints(prompt: string) {
  if (prompt.includes('生产') || prompt.includes('线上')) return '涉及生产环境，必须二次确认并保留回滚思路';
  return '保持改动最小、可验证、失败可解释';
}

function decisionPrompt(prompt: string, riskLevel: GuardRiskLevel) {
  if (riskLevel === 'critical') return `这个需求可能产生不可逆影响。你希望如何确认、备份或回滚？请结合“${prompt}”回答。`;
  if (prompt.includes('保存')) return '如果保存失败，你希望用户还能重新点击保存吗？为什么？';
  return `请说明这个需求失败时用户会看到什么，以及你为什么这样设计。需求：${prompt}`;
}
```

- [ ] **Step 5: Run rules tests**

Run:

```bash
cd cli && npm test -- --test-name-pattern="domain registry|translation|risk scoring|question generation|answer evaluation|learning credit"
```

Expected: PASS.

- [ ] **Step 6: Verification checkpoint**

Run:

```bash
cd cli && npm run typecheck
```

Expected: PASS.

---

### Task 3: LazyDevGuard State Machine

**Files:**
- Create: `cli/src/guard/lazyDevGuard.ts`
- Test: `cli/tests/lazyDevGuard.state.test.ts`
- Test: `cli/tests/lazyDevGuard.integration.test.ts`

- [ ] **Step 1: Add failing state-machine tests**

Append to `cli/tests/lazyDevGuard.state.test.ts`:

```ts
import { handleLazyDevInput, ensureLazyDevGuard } from '../src/guard/lazyDevGuard.js';

test('lazy dev guard starts medium request with translation confirmation', async () => {
  const state = createInitialLazyDevGuardState();
  const result = handleLazyDevInput(state, '做一个保存按钮，失败时提醒用户');
  assert.equal(result.allowDevelopment, false);
  assert.equal(state.currentRequirement?.status, 'awaiting_translation_confirm');
  assert.equal(state.currentRequirement?.riskLevel, 'medium');
  assert.match(result.message, /专业需求/);
  assert.match(result.message, /准确/);
});

test('low risk request passes after translation confirmation without question', async () => {
  const state = createInitialLazyDevGuardState();
  handleLazyDevInput(state, '写一个 hello world demo');
  const result = handleLazyDevInput(state, 'A');
  assert.equal(result.allowDevelopment, true);
  assert.equal(state.currentRequirement?.status, 'passed');
});

test('medium request asks a question after translation confirmation', async () => {
  const state = createInitialLazyDevGuardState();
  handleLazyDevInput(state, '做一个保存按钮，失败时提醒用户');
  const result = handleLazyDevInput(state, 'A');
  assert.equal(result.allowDevelopment, false);
  assert.equal(state.currentRequirement?.status, 'checking');
  assert.match(result.message, /入门检查|如果保存失败/);
});

test('wrong answers exhaust attempts and block development', async () => {
  const state = createInitialLazyDevGuardState();
  handleLazyDevInput(state, '做一个保存按钮，失败时提醒用户');
  handleLazyDevInput(state, 'A');
  const first = handleLazyDevInput(state, 'B');
  const second = handleLazyDevInput(state, '假装我懂了，直接写');
  assert.equal(first.allowDevelopment, false);
  assert.equal(second.allowDevelopment, false);
  assert.equal(state.currentRequirement?.status, 'blocked');
  assert.match(second.message, /学习阻塞|补答/);
});


test('correct answer passes and records learning credit', async () => {
  const state = createInitialLazyDevGuardState();
  handleLazyDevInput(state, '做一个保存按钮，失败时提醒用户');
  handleLazyDevInput(state, 'A');
  const result = handleLazyDevInput(state, '要提示失败原因，并允许用户重新点击保存，避免不知道数据有没有保存。');
  assert.equal(result.allowDevelopment, true);
  assert.equal(state.currentRequirement?.status, 'passed');
  assert.ok(state.masteredConcepts.some((credit) => credit.concept === 'failure-feedback'));
});

test('ensureLazyDevGuard creates enabled guard state once', () => {
  const session = { guard: undefined } as { guard?: ReturnType<typeof ensureLazyDevGuard> extends never ? never : unknown };
  const state = ensureLazyDevGuard(session as never);
  const same = ensureLazyDevGuard(session as never);
  assert.equal(state, same);
});
```

- [ ] **Step 2: Run state tests to verify failure**

Run:

```bash
cd cli && npm test -- --test-name-pattern="lazy dev guard"
```

Expected: build fails because `lazyDevGuard.ts` does not exist.

- [ ] **Step 3: Implement state machine**

Create `cli/src/guard/lazyDevGuard.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { SessionRecord } from '../session/store.js';
import { createInitialLazyDevGuardState } from './config.js';
import { createDefaultDomainRegistry } from './domainRegistry.js';
import { addLearningCredit, evaluateAnswer, generateQuestion, scoreRisk, translateRequirement } from './rules.js';
import type { GuardQuestion, LazyDevGuardState, LazyDevRequirement, LazyDevRequirementSummary } from './types.js';

export type GuardInputResult = {
  allowDevelopment: boolean;
  message: string;
  reason?: string;
};

export function ensureLazyDevGuard(session: SessionRecord): LazyDevGuardState {
  session.guard ??= {};
  session.guard.lazyDev ??= createInitialLazyDevGuardState();
  return session.guard.lazyDev;
}

export function handleLazyDevInput(state: LazyDevGuardState, input: string): GuardInputResult {
  if (!state.enabled) return { allowDevelopment: true, message: '' };
  if (state.paused) return { allowDevelopment: true, message: `守门已暂停：${state.paused.reason}` };

  const current = state.currentRequirement;
  if (!current || ['passed', 'archived', 'cancelled'].includes(current.status)) {
    return startRequirement(state, input);
  }
  if (current.status === 'awaiting_translation_confirm') return handleTranslationConfirmation(state, input);
  if (current.status === 'checking') return handleAnswer(state, input);
  if (current.status === 'blocked' || current.status === 'learning') {
    return { allowDevelopment: false, message: blockedMessage(current), reason: 'GUARD_ATTEMPT_EXHAUSTED' };
  }
  return { allowDevelopment: false, message: '当前守门状态暂不能继续开发，请使用 /不准偷懒开发 状态 查看。' };
}

export function archiveCurrentRequirement(state: LazyDevGuardState) {
  const current = state.currentRequirement;
  if (!current) return '当前没有可归档的需求。';
  current.status = 'archived';
  current.updatedAt = nowIso();
  state.metrics.archived += 1;
  state.history.push(toSummary(current));
  state.currentRequirement = undefined;
  return '已归档当前需求；不准偷懒开发仍保持开启。';
}

export function cancelCurrentRequirement(state: LazyDevGuardState) {
  const current = state.currentRequirement;
  if (!current) return '当前没有可取消的需求。';
  current.status = 'cancelled';
  current.updatedAt = nowIso();
  state.metrics.cancelled += 1;
  state.history.push(toSummary(current));
  state.currentRequirement = undefined;
  return '已取消当前需求；不准偷懒开发仍保持开启。';
}

export function resumeBlockedRequirement(state: LazyDevGuardState) {
  const current = state.currentRequirement;
  if (!current || (current.status !== 'blocked' && current.status !== 'learning')) return '当前没有学习阻塞需求可继续。';
  current.status = 'checking';
  current.lastQuestion = nextQuestion(current);
  current.askedQuestionIds.push(current.lastQuestion.id);
  current.updatedAt = nowIso();
  return formatQuestion(current.lastQuestion, '继续检查');
}

function startRequirement(state: LazyDevGuardState, input: string): GuardInputResult {
  const registry = createDefaultDomainRegistry();
  const domains = registry.resolve(input, { recentDomains: recentDomains(state) });
  const translatedRequirement = translateRequirement(input, domains);
  const risk = scoreRisk(input, domains);
  const timestamp = nowIso();
  const requirement: LazyDevRequirement = {
    id: `req_${randomUUID().slice(0, 8)}`,
    originalPrompt: input,
    translatedRequirement,
    domainMatches: domains,
    riskLevel: risk.level,
    status: 'awaiting_translation_confirm',
    attemptsUsed: 0,
    maxAttempts: state.config.defaultMaxAttempts,
    askedQuestionIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  state.currentRequirement = requirement;
  state.metrics.totalChecks += 1;
  state.metrics.riskDistribution[risk.level] += 1;
  for (const domain of domains) state.metrics.domainDistribution[domain.adapterId] = (state.metrics.domainDistribution[domain.adapterId] ?? 0) + 1;
  return { allowDevelopment: false, message: formatTranslation(requirement) };
}

function handleTranslationConfirmation(state: LazyDevGuardState, input: string): GuardInputResult {
  const current = state.currentRequirement;
  if (!current) return { allowDevelopment: false, message: '没有待确认的需求。' };
  const normalized = input.trim().toUpperCase();
  if (normalized === 'B' || input.includes('补充')) {
    current.translatedRequirement.summary += `；用户补充：${input}`;
    current.updatedAt = nowIso();
    return { allowDevelopment: false, message: formatTranslation(current) };
  }
  if (normalized === 'C' || input.includes('不准确')) {
    state.currentRequirement = undefined;
    return { allowDevelopment: false, message: '请重新描述你的需求，我会重新翻译。', reason: 'GUARD_TRANSLATION_REJECTED' };
  }
  if (current.riskLevel === 'low' && !current.translatedRequirement.incomplete) {
    current.status = 'passed';
    current.updatedAt = nowIso();
    state.metrics.passedFirstTry += 1;
    return { allowDevelopment: true, message: '低风险需求已完成翻译确认，可以继续开发。' };
  }
  current.status = 'checking';
  current.lastQuestion = nextQuestion(current);
  current.askedQuestionIds.push(current.lastQuestion.id);
  current.updatedAt = nowIso();
  return { allowDevelopment: false, message: formatQuestion(current.lastQuestion, '入门检查') };
}

function handleAnswer(state: LazyDevGuardState, input: string): GuardInputResult {
  const current = state.currentRequirement;
  const question = current?.lastQuestion;
  if (!current || !question) return { allowDevelopment: false, message: '没有待回答的检查题。' };
  const result = evaluateAnswer(question, input);
  if (result.passed) {
    current.status = 'passed';
    current.updatedAt = nowIso();
    if (current.attemptsUsed === 0) state.metrics.passedFirstTry += 1;
    else state.metrics.passedAfterRetry += 1;
    state.masteredConcepts = addLearningCredit(state.masteredConcepts, question.concept, current.domainMatches.map((domain) => domain.adapterId), nowIso());
    return { allowDevelopment: true, message: `通过。${result.explanation}` };
  }
  current.attemptsUsed += 1;
  if (current.attemptsUsed >= current.maxAttempts) {
    current.status = 'blocked';
    current.blockedReason = result.explanation;
    current.recovery = {
      learningTasks: ['用自己的话说明目标、输入、输出、失败情况和验收标准', '解释失败时用户应该看到什么以及为什么', '重新提交更清楚的需求或使用 /不准偷懒开发 继续'],
      resumeCondition: 'answer-new-question',
      resumeCommand: '/不准偷懒开发 继续',
    };
    state.metrics.blocked += 1;
    return { allowDevelopment: false, message: blockedMessage(current), reason: 'GUARD_ATTEMPT_EXHAUSTED' };
  }
  current.lastQuestion = nextQuestion(current);
  current.askedQuestionIds.push(current.lastQuestion.id);
  current.updatedAt = nowIso();
  return { allowDevelopment: false, message: `${result.explanation}\n补答机会：${current.maxAttempts - current.attemptsUsed} 次。\n\n${formatQuestion(current.lastQuestion, '新的检查题')}` };
}

function nextQuestion(requirement: LazyDevRequirement): GuardQuestion {
  return generateQuestion({
    prompt: requirement.originalPrompt,
    concept: requirement.originalPrompt.includes('保存') ? 'failure-feedback' : 'acceptance-criteria',
    riskLevel: requirement.riskLevel,
    askedQuestionIds: requirement.askedQuestionIds,
  });
}

function formatTranslation(requirement: LazyDevRequirement) {
  const fields = requirement.translatedRequirement.fields.map((field) => `- ${field.name}：${field.value}`).join('\n');
  const domains = requirement.domainMatches.map((domain) => `${domain.label} ${(domain.confidence * 100).toFixed(0)}%`).join('、');
  return [`专业需求转换：`, `领域：${domains}`, `风险：${requirement.riskLevel}`, `摘要：${requirement.translatedRequirement.summary}`, fields, ``, `这是否准确？`, `A. 准确，继续检查`, `B. 基本准确，但我要补充`, `C. 不准确，我重新描述`].join('\n');
}

function formatQuestion(question: GuardQuestion, title: string) {
  const options = question.options?.map((option) => `${option.label}. ${option.text}`).join('\n');
  return [`${title}：`, question.prompt, options].filter(Boolean).join('\n');
}

function blockedMessage(requirement: LazyDevRequirement) {
  const tasks = requirement.recovery?.learningTasks.map((task, index) => `${index + 1}. ${task}`).join('\n') ?? '1. 重新说明需求目标、输入、输出和失败情况';
  return [`本轮需求停止开发。`, `学习阻塞原因：${requirement.blockedReason ?? '未通过入门检查'}`, `建议先补足：`, tasks, `恢复命令：/不准偷懒开发 继续`].join('\n');
}

function recentDomains(state: LazyDevGuardState) {
  return state.history.flatMap((item) => item.domainLabels).slice(-3);
}

function toSummary(requirement: LazyDevRequirement): LazyDevRequirementSummary {
  return {
    id: requirement.id,
    originalPrompt: requirement.originalPrompt,
    status: requirement.status,
    riskLevel: requirement.riskLevel,
    domainLabels: requirement.domainMatches.map((domain) => domain.adapterId),
    createdAt: requirement.createdAt,
    updatedAt: requirement.updatedAt,
  };
}

function nowIso() {
  return new Date().toISOString();
}
```

- [ ] **Step 4: Run state-machine tests**

Run:

```bash
cd cli && npm test -- --test-name-pattern="lazy dev guard"
```

Expected: PASS for state-machine tests.

- [ ] **Step 5: Verification checkpoint**

Run:

```bash
cd cli && npm run typecheck
```

Expected: PASS.

---

### Task 4: Slash Commands for `/不准偷懒开发`

**Files:**
- Modify: `cli/src/cli/commands.ts`
- Test: `cli/tests/lazyDevGuard.commands.test.ts`

- [ ] **Step 1: Write failing command tests**

Create `cli/tests/lazyDevGuard.commands.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handleSlashCommand } from '../src/cli/commands.js';
import type { AppConfig } from '../src/config/types.js';
import { createMockProvider } from '../src/providers/mock.js';
import { SessionStore } from '../src/session/store.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';

async function commandFixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-lazy-command-'));
  const config: AppConfig = {
    provider: 'mock',
    model: 'mock-code-agent-v1',
    approval: 'auto',
    workspaceRoot: workspace,
    sessionDir: join(workspace, '.aicode', 'sessions'),
    maxSteps: 10,
    noBanner: true,
    configPath: join(workspace, '.aicode.json'),
  };
  const provider = createMockProvider(config.model);
  const sessions = new SessionStore(config.sessionDir);
  const session = await sessions.create({ provider: provider.name, model: provider.model, workspaceRoot: workspace });
  return { workspace, config, provider, sessions, session, tools: createDefaultToolRegistry() };
}

test('/help lists no-lazy-development command', async () => {
  const fixture = await commandFixture();
  const output = await handleSlashCommand({ line: '/help', ...fixture });
  assert.match(output, /\/不准偷懒开发/);
  await rm(fixture.workspace, { recursive: true, force: true });
});

test('/不准偷懒开发 enables guard', async () => {
  const fixture = await commandFixture();
  const output = await handleSlashCommand({ line: '/不准偷懒开发', ...fixture });
  assert.match(output, /已开启/);
  assert.equal(fixture.session.guard?.lazyDev?.enabled, true);
  await rm(fixture.workspace, { recursive: true, force: true });
});

test('/不准偷懒开发 状态 reports risk and metrics', async () => {
  const fixture = await commandFixture();
  await handleSlashCommand({ line: '/不准偷懒开发', ...fixture });
  const output = await handleSlashCommand({ line: '/不准偷懒开发 状态', ...fixture });
  assert.match(output, /状态/);
  assert.match(output, /强度/);
  assert.match(output, /检查次数/);
  await rm(fixture.workspace, { recursive: true, force: true });
});

test('/不准偷懒开发 设置 最大补答次数 updates config', async () => {
  const fixture = await commandFixture();
  await handleSlashCommand({ line: '/不准偷懒开发', ...fixture });
  const output = await handleSlashCommand({ line: '/不准偷懒开发 设置 最大补答次数 3', ...fixture });
  assert.match(output, /最大补答次数.*3/);
  assert.equal(fixture.session.guard?.lazyDev?.config.defaultMaxAttempts, 3);
  await rm(fixture.workspace, { recursive: true, force: true });
});

test('/不准偷懒开发 归档 and 取消 keep guard enabled', async () => {
  const fixture = await commandFixture();
  await handleSlashCommand({ line: '/不准偷懒开发', ...fixture });
  fixture.session.guard!.lazyDev!.currentRequirement = {
    id: 'req_command',
    originalPrompt: '做一个保存按钮',
    translatedRequirement: { summary: '保存', fields: [], incomplete: false },
    domainMatches: [],
    riskLevel: 'medium',
    status: 'checking',
    attemptsUsed: 0,
    maxAttempts: 2,
    askedQuestionIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const output = await handleSlashCommand({ line: '/不准偷懒开发 归档', ...fixture });
  assert.match(output, /已归档/);
  assert.equal(fixture.session.guard?.lazyDev?.enabled, true);
  await rm(fixture.workspace, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run command tests to verify failure**

Run:

```bash
cd cli && npm test -- --test-name-pattern="不准偷懒开发|no-lazy-development command"
```

Expected: tests fail because commands do not exist.

- [ ] **Step 3: Modify help and command dispatcher**

Modify `cli/src/cli/commands.ts`:

Add imports:

```ts
import { clampMaxAttempts, createInitialLazyDevGuardState, parseStrictness } from '../guard/config.js';
import { archiveCurrentRequirement, cancelCurrentRequirement, ensureLazyDevGuard, resumeBlockedRequirement } from '../guard/lazyDevGuard.js';
```

Update `/help` output by adding:

```ts
'/不准偷懒开发       开启学习守门模式',
'/不准偷懒开发 状态  查看守门状态',
```

Before the `default` case, add:

```ts
    default:
      if (command.startsWith('/不准偷懒开发')) return handleLazyDevCommand(command, options);
      return `Unknown command: ${command}. Try /help.`;
```

Add helper below `handleSlashCommand`:

```ts
async function handleLazyDevCommand(command: string, options: Parameters<typeof handleSlashCommand>[0]) {
  const parts = command.split(/\s+/).filter(Boolean);
  const subcommand = parts[1];
  const state = ensureLazyDevGuard(options.session);

  if (!subcommand) {
    options.session.guard ??= {};
    options.session.guard.lazyDev = state ?? createInitialLazyDevGuardState();
    await options.sessions.save(options.session);
    return ['已开启：不准偷懒开发。', '开发请求会先转换为专业需求，并进行风险分级和入门理解检查。', '输入 /不准偷懒开发 状态 查看当前状态。'].join('\n');
  }

  if (subcommand === '状态') {
    const current = state.currentRequirement;
    return [
      `状态：${state.enabled ? '开启' : '关闭'}`,
      `强度：${state.config.strictness}`,
      `当前需求：${current ? `${current.status} / ${current.riskLevel}` : '无'}`,
      `剩余补答：${current ? Math.max(current.maxAttempts - current.attemptsUsed, 0) : '-'}`,
      `检查次数：${state.metrics.totalChecks}`,
      `阻塞次数：${state.metrics.blocked}`,
    ].join('\n');
  }

  if (subcommand === '继续') {
    const output = resumeBlockedRequirement(state);
    await options.sessions.save(options.session);
    return output;
  }

  if (subcommand === '归档') {
    const output = archiveCurrentRequirement(state);
    await options.sessions.save(options.session);
    return output;
  }

  if (subcommand === '取消') {
    const output = cancelCurrentRequirement(state);
    await options.sessions.save(options.session);
    return output;
  }

  if (subcommand === '暂停') {
    state.paused = { reason: parts.slice(2).join(' ') || '用户选择临时暂停', createdAt: new Date().toISOString(), resumeHint: '使用 /不准偷懒开发 继续 或 /不准偷懒开发 状态 查看' };
    await options.sessions.save(options.session);
    return `已暂停不准偷懒开发：${state.paused.reason}`;
  }

  if (subcommand === '关闭') {
    if (state.currentRequirement && !['passed', 'archived', 'cancelled'].includes(state.currentRequirement.status)) {
      return '不能关闭：当前存在活跃且未通过的需求。请先通过、归档、取消或暂停。';
    }
    state.enabled = false;
    await options.sessions.save(options.session);
    return '已关闭不准偷懒开发。本次关闭已记录在 session 中。';
  }

  if (subcommand === '设置') {
    const key = parts[2];
    const value = parts[3];
    if (key === '强度' && value) {
      const strictness = parseStrictness(value);
      if (!strictness) return '未知强度。可选：新手、标准、老手、只翻译。';
      if (state.currentRequirement && !['passed', 'archived', 'cancelled'].includes(state.currentRequirement.status)) return '当前有活跃未通过需求，不能降低或更改强度。';
      state.config.strictness = strictness;
      await options.sessions.save(options.session);
      return `已设置强度：${strictness}`;
    }
    if (key === '最大补答次数' && value) {
      state.config.defaultMaxAttempts = clampMaxAttempts(Number(value));
      await options.sessions.save(options.session);
      return `已设置最大补答次数：${state.config.defaultMaxAttempts}`;
    }
    return '设置格式：/不准偷懒开发 设置 强度 标准 或 /不准偷懒开发 设置 最大补答次数 2';
  }

  return '未知不准偷懒开发命令。可用：状态、继续、归档、取消、暂停、关闭、设置。';
}
```

- [ ] **Step 4: Run command tests**

Run:

```bash
cd cli && npm test -- --test-name-pattern="不准偷懒开发|no-lazy-development command"
```

Expected: PASS.

- [ ] **Step 5: Verification checkpoint**

Run:

```bash
cd cli && npm run typecheck
```

Expected: PASS.

---

### Task 5: Runtime Hard Interception in Prompt and REPL Modes

**Files:**
- Modify: `cli/src/cli/repl.ts`
- Test: `cli/tests/lazyDevGuard.integration.test.ts`

- [ ] **Step 1: Write failing integration tests**

Create `cli/tests/lazyDevGuard.integration.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runPromptMode } from '../src/cli/repl.js';
import type { AppConfig } from '../src/config/types.js';
import { createInitialLazyDevGuardState } from '../src/guard/config.js';
import { createMockProvider } from '../src/providers/mock.js';
import { SessionStore } from '../src/session/store.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { TerminalUI } from '../src/ui/terminal.js';

async function runtimeFixture(prompt = '做一个保存按钮，失败时提醒用户') {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-lazy-integration-'));
  const config: AppConfig = {
    provider: 'mock',
    model: 'mock-code-agent-v1',
    approval: 'auto',
    workspaceRoot: workspace,
    sessionDir: join(workspace, '.aicode', 'sessions'),
    prompt,
    maxSteps: 10,
    noBanner: true,
    quiet: true,
    configPath: join(workspace, '.aicode.json'),
  };
  const provider = createMockProvider(config.model);
  const sessions = new SessionStore(config.sessionDir);
  const session = await sessions.create({ provider: provider.name, model: provider.model, workspaceRoot: workspace });
  session.guard = { lazyDev: createInitialLazyDevGuardState() };
  return { workspace, runtime: { config, provider, tools: createDefaultToolRegistry(), sessions, session, ui: new TerminalUI(true) } };
}

test('prompt mode guard blocks development before provider and tools', async () => {
  const fixture = await runtimeFixture();
  const result = await runPromptMode(fixture.runtime, '做一个保存按钮，失败时提醒用户');
  assert.equal(result.ok, true);
  assert.equal(fixture.runtime.session.toolCalls.length, 0);
  assert.equal(fixture.runtime.session.finalAnswers.length, 0);
  assert.equal(fixture.runtime.session.guard?.lazyDev?.currentRequirement?.status, 'awaiting_translation_confirm');
  await rm(fixture.workspace, { recursive: true, force: true });
});

test('prompt mode enters development after low-risk translation confirmation', async () => {
  const fixture = await runtimeFixture('写一个 hello world demo');
  await runPromptMode(fixture.runtime, '写一个 hello world demo');
  const result = await runPromptMode(fixture.runtime, 'A');
  assert.equal(result.ok, true);
  assert.equal(fixture.runtime.session.guard?.lazyDev?.currentRequirement?.status, 'passed');
  await rm(fixture.workspace, { recursive: true, force: true });
});

test('prompt mode does not call tools after wrong guard answer', async () => {
  const fixture = await runtimeFixture();
  await runPromptMode(fixture.runtime, '做一个保存按钮，失败时提醒用户');
  await runPromptMode(fixture.runtime, 'A');
  const result = await runPromptMode(fixture.runtime, 'B');
  assert.equal(result.ok, true);
  assert.equal(fixture.runtime.session.toolCalls.length, 0);
  assert.equal(fixture.runtime.session.guard?.lazyDev?.currentRequirement?.status, 'checking');
  await rm(fixture.workspace, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run integration tests to verify failure**

Run:

```bash
cd cli && npm test -- --test-name-pattern="prompt mode guard|wrong guard answer"
```

Expected: tests fail because `runPromptMode` still calls `runAgentTurn` directly.

- [ ] **Step 3: Intercept non-slash input in `runPromptMode` and `runRepl`**

Modify `cli/src/cli/repl.ts`:

Add import:

```ts
import { handleLazyDevInput } from '../guard/lazyDevGuard.js';
```

Add helper:

```ts
async function runGuardedAgentTurn(runtime: AgentRuntime, line: string): Promise<AgentTurnResult> {
  const guard = runtime.session.guard?.lazyDev;
  if (guard?.enabled) {
    const guardResult = handleLazyDevInput(guard, line);
    if (guardResult.message) runtime.ui.info(guardResult.message);
    await runtime.sessions.save(runtime.session);
    if (!guardResult.allowDevelopment) return { ok: true, session: runtime.session, reason: guardResult.reason };
  }
  return runAgentTurn(runtime, line);
}
```

Change `runPromptMode` final line from:

```ts
  return runAgentTurn(runtime, prompt);
```

to:

```ts
  return runGuardedAgentTurn(runtime, prompt);
```

Change the REPL loop line from:

```ts
      await runAgentTurn(interactiveRuntime, line);
```

to:

```ts
      await runGuardedAgentTurn(interactiveRuntime, line);
```

- [ ] **Step 4: Run integration tests**

Run:

```bash
cd cli && npm test -- --test-name-pattern="prompt mode guard|wrong guard answer"
```

Expected: PASS.

- [ ] **Step 5: Run smoke test to verify existing behavior when guard is disabled**

Run:

```bash
cd cli && npm run smoke
```

Expected: PASS. The smoke test should still call tools because guard is not enabled by default.

---

### Task 6: Confirmation Fallback, Critical Risk, and Close/Pause Behavior

**Files:**
- Create: `cli/src/guard/confirm.ts`
- Modify: `cli/src/cli/commands.ts`
- Modify: `cli/src/guard/lazyDevGuard.ts`
- Test: `cli/tests/lazyDevGuard.commands.test.ts`
- Test: `cli/tests/lazyDevGuard.rules.test.ts`

- [ ] **Step 1: Add failing critical-risk and close tests**

Append to `cli/tests/lazyDevGuard.rules.test.ts`:

```ts
test('critical risk question demands irreversible-operation confirmation', () => {
  const question = generateQuestion({
    prompt: '删除生产配置并覆盖线上数据',
    concept: 'critical-confirmation',
    riskLevel: 'critical',
    askedQuestionIds: [],
  });
  assert.equal(question.kind, 'decision');
  assert.match(question.prompt, /不可逆|确认|回滚|生产/);
});
```

Append to `cli/tests/lazyDevGuard.commands.test.ts`:

```ts
test('/不准偷懒开发 关闭 refuses active unchecked requirement', async () => {
  const fixture = await commandFixture();
  await handleSlashCommand({ line: '/不准偷懒开发', ...fixture });
  fixture.session.guard!.lazyDev!.currentRequirement = {
    id: 'req_active',
    originalPrompt: '删除生产配置',
    translatedRequirement: { summary: '删除生产配置', fields: [], incomplete: false },
    domainMatches: [],
    riskLevel: 'critical',
    status: 'checking',
    attemptsUsed: 0,
    maxAttempts: 2,
    askedQuestionIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const output = await handleSlashCommand({ line: '/不准偷懒开发 关闭', ...fixture });
  assert.match(output, /不能关闭/);
  assert.equal(fixture.session.guard?.lazyDev?.enabled, true);
  await rm(fixture.workspace, { recursive: true, force: true });
});

test('/不准偷懒开发 暂停 records reason', async () => {
  const fixture = await commandFixture();
  await handleSlashCommand({ line: '/不准偷懒开发', ...fixture });
  const output = await handleSlashCommand({ line: '/不准偷懒开发 暂停 非开发闲聊', ...fixture });
  assert.match(output, /已暂停/);
  assert.equal(fixture.session.guard?.lazyDev?.paused?.reason, '非开发闲聊');
  await rm(fixture.workspace, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run targeted tests**

Run:

```bash
cd cli && npm test -- --test-name-pattern="critical risk|关闭 refuses|暂停 records"
```

Expected: close/pause tests may pass from Task 4; critical wording may fail until question generation is adjusted.

- [ ] **Step 3: Add confirm interface helper**

Create `cli/src/guard/confirm.ts`:

```ts
export type GuardConfirmationOption = {
  label: string;
  description: string;
};

export type GuardConfirmationRequest = {
  title: string;
  question: string;
  options: GuardConfirmationOption[];
};

export type GuardConfirmationResult = {
  selectedLabel: string;
  source: 'popup' | 'terminal';
};

export function formatTerminalOptions(request: GuardConfirmationRequest) {
  return [
    request.title,
    request.question,
    ...request.options.map((option, index) => `${index + 1}. ${option.label}：${option.description}`),
  ].join('\n');
}
```

- [ ] **Step 4: Ensure critical prompt wording is explicit**

In `cli/src/guard/rules.ts`, make sure `decisionPrompt()` critical branch returns:

```ts
if (riskLevel === 'critical') return `这个需求可能产生不可逆影响。你希望如何确认、备份或回滚？请结合“${prompt}”回答。`;
```

- [ ] **Step 5: Run tests**

Run:

```bash
cd cli && npm test -- --test-name-pattern="critical risk|关闭 refuses|暂停 records"
```

Expected: PASS.

- [ ] **Step 6: Verification checkpoint**

Run:

```bash
cd cli && npm run typecheck
```

Expected: PASS.

---

### Task 7: README, Full Regression, and Audit Update

**Files:**
- Modify: `cli/README.md`
- Modify: `cli/src/audit/checks.ts`
- Test: existing full test suite

- [ ] **Step 1: Update README slash command list**

Modify `cli/README.md` under `## Slash Commands` to include:

```md
- `/不准偷懒开发` - enable the built-in learning guard for development requests
- `/不准偷懒开发 状态` - show guard status, risk, attempts, and metrics
- `/不准偷懒开发 继续` - resume a blocked learning check
- `/不准偷懒开发 归档` - archive the current guarded requirement
- `/不准偷懒开发 取消` - cancel the current guarded requirement
- `/不准偷懒开发 暂停` - temporarily pause the guard for non-development work
- `/不准偷懒开发 设置 ...` - adjust session guard strictness and retry count
```

Add a short section after Slash Commands:

```md
## 不准偷懒开发

`/不准偷懒开发` enables a session-level guard. When enabled, development requests are translated into professional requirements, assigned a risk level, and may require an entry-level understanding check before the main agent can call tools.

The guard is rule-based in the MVP. It persists in the session file, blocks before tool execution, and cannot be bypassed by prompt wording such as “just write it”. Low-risk requests only require translation confirmation; medium and higher risk requests require checks, and critical requests require extra confirmation.
```

- [ ] **Step 2: Update audit checks**

Open `cli/src/audit/checks.ts` and add checks that verify these strings/files exist:

```ts
checkFile('src/guard/types.ts');
checkFile('src/guard/lazyDevGuard.ts');
checkFile('src/guard/rules.ts');
checkFile('src/guard/domainRegistry.ts');
checkIncludes('src/cli/commands.ts', '/不准偷懒开发');
checkIncludes('src/cli/repl.ts', 'handleLazyDevInput');
checkIncludes('README.md', '不准偷懒开发');
```

Use the existing helper names in `checks.ts`; if the file uses different helper names, add equivalent checks following the local pattern.

- [ ] **Step 3: Run full typecheck**

Run:

```bash
cd cli && npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run full test suite**

Run:

```bash
cd cli && npm test
```

Expected: PASS.

- [ ] **Step 5: Run smoke test**

Run:

```bash
cd cli && npm run smoke
```

Expected: PASS. Existing mock-provider smoke behavior remains unchanged when guard is not enabled.

- [ ] **Step 6: Run audit**

Run:

```bash
cd cli && npm run audit:100
```

Expected: PASS. If audit count or wording changes, update only guard-related checks and do not weaken existing checks.

- [ ] **Step 7: Manual CLI sanity check**

Run:

```bash
cd cli && npm run build && node dist/src/index.js --provider mock --approval auto --session-dir .aicode-guard-manual/sessions --prompt "/不准偷懒开发"
```

Expected output includes `已开启：不准偷懒开发`.

Then copy the printed session id or inspect `.aicode-guard-manual/sessions`, and run:

```bash
cd cli && node dist/src/index.js --provider mock --approval auto --session-dir .aicode-guard-manual/sessions --resume <SESSION_ID> --prompt "做一个保存按钮，失败时提醒用户"
```

Expected output includes `专业需求转换` and no tool call logs.

---

## Self-Review

### Spec Coverage

- Runtime hard interception: Task 5 intercepts before `runAgentTurn`.
- Session state: Task 1 extends `SessionRecord` and tests persistence.
- Commands: Task 4 implements `/不准偷懒开发` command family.
- Translation: Task 2 implements rule-based professional requirement translation.
- Domain generalization: Task 2 implements `DomainRegistry` and multiple adapters.
- Risk levels: Task 2 and Task 6 implement low/medium/high/critical behavior and tests.
- Decision questions: Task 2 generates decision questions and evaluates short answers.
- Learning credit: Task 2 and Task 3 record `masteredConcepts`.
- Blocking behavior: Task 3 blocks after exhausted attempts; Task 5 proves no tool calls happen while blocked/checking.
- Prompt mode: Task 5 covers prompt mode interception.
- Close/pause/restore commands: Task 4 and Task 6 cover status, continue, archive, cancel, pause, close, settings.
- README and audit: Task 7 updates docs and audit checks.

### Placeholder Scan

This plan intentionally avoids placeholder instructions. Every created file has concrete code snippets, and every verification step has a specific command and expected result.

### Type Consistency

The plan consistently uses `LazyDevGuardState`, `LazyDevRequirement`, `GuardRiskLevel`, `LearningCredit`, `handleLazyDevInput`, `ensureLazyDevGuard`, `archiveCurrentRequirement`, `cancelCurrentRequirement`, and `resumeBlockedRequirement` across tests and implementation tasks.
