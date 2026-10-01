import { randomUUID } from 'node:crypto';
import type { SessionRecord } from '../session/store.js';
import { createInitialLazyDevGuardState } from './config.js';
import { createDefaultDomainRegistry } from './domainRegistry.js';
import { addLearningCredit, evaluateAnswer, generateQuestion, isDevelopmentRequest, scoreRisk, translateRequirement } from './rules.js';
import type { GuardConfirmationChannel, GuardQuestion, LazyDevGuardState, LazyDevRequirement, LazyDevRequirementSummary } from './types.js';

export type GuardInputResult = {
  allowDevelopment: boolean;
  message: string;
  reason?: string;
  developmentPrompt?: string;
};

export function ensureLazyDevGuard(session: SessionRecord): LazyDevGuardState {
  session.guard ??= {};
  session.guard.lazyDev ??= createInitialLazyDevGuardState();
  return session.guard.lazyDev;
}

/**
 * Async variant used when a confirmation channel is available (desktop popup
 * first, terminal menu as the fallback). The state machine is shared with the
 * sync path: only the translation-confirmation step swaps its input source.
 */
export async function handleLazyDevInputWithChannel(
  state: LazyDevGuardState,
  input: string,
  channel: GuardConfirmationChannel | undefined,
): Promise<GuardInputResult> {
  if (!channel) return handleLazyDevInput(state, input);
  if (!state.enabled || state.paused) return handleLazyDevInput(state, input);
  const current = state.currentRequirement;
  if (current?.status !== 'awaiting_translation_confirm') return handleLazyDevInput(state, input);

  const choice = await channel.confirm({
    title: '需求翻译确认',
    question: '这份专业需求表达准确吗？',
    options: [
      { label: '准确，继续', description: '按此需求进入检查或开发' },
      { label: '补充信息', description: '我会补充更多细节' },
      { label: '重新描述', description: '我会重新描述需求' },
    ],
  });
  // No answer in the popup (timeout / closed): fall through to the sync path
  // so the user still sees the numbered menu and nothing is auto-selected.
  if (!choice) return handleLazyDevInput(state, input);
  return handleTranslationConfirmation(state, choice.selectedLabel);
}

export function handleLazyDevInput(state: LazyDevGuardState, input: string): GuardInputResult {
  if (!state.enabled) return { allowDevelopment: true, message: '' };
  if (state.paused) return { allowDevelopment: true, message: `守门已暂停：${state.paused.reason}` };

  const current = state.currentRequirement;
  if (!current || current.status === 'passed' || current.status === 'archived' || current.status === 'cancelled') {
    if (!isDevelopmentRequest(input)) return { allowDevelopment: true, message: '' };
    return startRequirement(state, input);
  }

  if (current.status === 'awaiting_translation_confirm') return handleTranslationConfirmation(state, input);
  if (current.status === 'checking') return handleAnswer(state, input);
  if (current.status === 'blocked' || current.status === 'learning') {
    return { allowDevelopment: false, message: blockedMessage(current), reason: 'GUARD_ATTEMPT_EXHAUSTED' };
  }

  return { allowDevelopment: false, message: '当前守门状态暂不能继续开发，请使用 /不准偷懒开发 状态 查看。' };
}

export function archiveCurrentRequirement(state: LazyDevGuardState): string {
  const current = state.currentRequirement;
  if (!current) return '当前没有可归档的需求。';

  current.status = 'archived';
  current.updatedAt = nowIso();
  state.metrics.archived += 1;
  state.history.push(toSummary(current));
  state.currentRequirement = undefined;
  return '已归档当前需求；不准偷懒开发仍保持开启。';
}

export function cancelCurrentRequirement(state: LazyDevGuardState): string {
  const current = state.currentRequirement;
  if (!current) return '当前没有可取消的需求。';

  current.status = 'cancelled';
  current.updatedAt = nowIso();
  state.metrics.cancelled += 1;
  state.history.push(toSummary(current));
  state.currentRequirement = undefined;
  return '已取消当前需求；不准偷懒开发仍保持开启。';
}

export function resumeBlockedRequirement(state: LazyDevGuardState): string {
  const current = state.currentRequirement;
  if (!current || (current.status !== 'blocked' && current.status !== 'learning')) return '当前没有学习阻塞需求可继续。';

  current.status = 'checking';
  current.blockedReason = undefined;
  current.recovery = undefined;
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
    maxAttempts: requirementMaxAttempts(state),
    askedQuestionIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  state.currentRequirement = requirement;
  state.metrics.totalChecks += 1;
  state.metrics.riskDistribution[risk.level] += 1;
  for (const domain of domains) {
    state.metrics.domainDistribution[domain.adapterId] = (state.metrics.domainDistribution[domain.adapterId] ?? 0) + 1;
  }

  return { allowDevelopment: false, message: formatTranslation(requirement) };
}

function handleTranslationConfirmation(state: LazyDevGuardState, input: string): GuardInputResult {
  const current = state.currentRequirement;
  if (!current) return { allowDevelopment: false, message: '没有待确认的需求。' };

  const normalized = input.trim().toUpperCase();
  if (normalized === 'B' || input.includes('补充')) {
    current.translatedRequirement.summary = `${current.translatedRequirement.summary}；用户补充：${input}`;
    current.updatedAt = nowIso();
    return { allowDevelopment: false, message: formatTranslation(current) };
  }

  if (normalized === 'C' || input.includes('不准确') || input.includes('重新描述')) {
    state.currentRequirement = undefined;
    return { allowDevelopment: false, message: '请重新描述你的需求，我会重新翻译。', reason: 'GUARD_TRANSLATION_REJECTED' };
  }

  if (normalized === 'A' || input.includes('准确') || input.includes('确认')) {
    if (passesAfterTranslation(state, current)) {
      current.status = 'passed';
      current.updatedAt = nowIso();
      state.metrics.passedFirstTry += 1;
      return { allowDevelopment: true, message: '需求已完成翻译确认，可以继续开发。', developmentPrompt: current.originalPrompt };
    }

    current.status = 'checking';
    current.lastQuestion = nextQuestion(current);
    current.askedQuestionIds.push(current.lastQuestion.id);
    current.updatedAt = nowIso();
    return { allowDevelopment: false, message: formatQuestion(current.lastQuestion, '入门检查') };
  }

  return { allowDevelopment: false, message: `${formatTranslation(current)}\n\n请回复 A、B 或 C。` };
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
    state.masteredConcepts = addLearningCredit(
      state.masteredConcepts,
      question.concept,
      current.domainMatches.map((domain) => domain.adapterId),
      current.updatedAt,
    );
    return { allowDevelopment: true, message: `通过。${result.explanation}`, developmentPrompt: current.originalPrompt };
  }

  current.attemptsUsed += 1;
  current.updatedAt = nowIso();
  if (current.attemptsUsed >= current.maxAttempts) {
    current.status = 'blocked';
    current.blockedReason = result.explanation;
    current.recovery = {
      learningTasks: [
        '用自己的话说明目标、输入、输出、失败情况和验收标准',
        '解释失败时用户应该看到什么以及为什么',
        '重新提交更清楚的需求或使用 /不准偷懒开发 继续',
      ],
      resumeCondition: 'answer-new-question',
      resumeCommand: '/不准偷懒开发 继续',
    };
    state.metrics.blocked += 1;
    return { allowDevelopment: false, message: blockedMessage(current), reason: 'GUARD_ATTEMPT_EXHAUSTED' };
  }

  current.lastQuestion = nextQuestion(current);
  current.askedQuestionIds.push(current.lastQuestion.id);
  current.updatedAt = nowIso();
  return {
    allowDevelopment: false,
    message: `${result.explanation}\n补答机会：${current.maxAttempts - current.attemptsUsed} 次。\n\n${formatQuestion(current.lastQuestion, '新的检查题')}`,
  };
}

function nextQuestion(requirement: LazyDevRequirement): GuardQuestion {
  return generateQuestion({
    prompt: requirement.originalPrompt,
    concept: questionConcept(requirement),
    riskLevel: requirement.riskLevel,
    askedQuestionIds: requirement.askedQuestionIds,
  });
}

function passesAfterTranslation(state: LazyDevGuardState, requirement: LazyDevRequirement): boolean {
  if (requirement.riskLevel === 'critical') return false;
  if (state.config.strictness === 'translationOnly') return true;
  if (state.config.strictness === 'experienced' && requirement.riskLevel === 'medium') return true;
  return requirement.riskLevel === 'low' && !requirement.translatedRequirement.incomplete;
}

function requirementMaxAttempts(state: LazyDevGuardState): number {
  return state.config.strictness === 'beginner' ? 3 : state.config.defaultMaxAttempts;
}

function questionConcept(requirement: LazyDevRequirement): string {
  if (requirement.riskLevel === 'critical') return 'critical-confirmation';
  return requirement.originalPrompt.includes('保存') ? 'failure-feedback' : 'acceptance-criteria';
}

function formatTranslation(requirement: LazyDevRequirement): string {
  const fields = requirement.translatedRequirement.fields.map((field) => `- ${field.name}：${field.value}`).join('\n');
  const domains = requirement.domainMatches.map((domain) => `${domain.label} ${(domain.confidence * 100).toFixed(0)}%`).join('、');
  return [
    '专业需求转换：',
    `领域：${domains}`,
    `风险：${requirement.riskLevel}`,
    `摘要：${requirement.translatedRequirement.summary}`,
    fields,
    '',
    '这是否准确？',
    'A. 准确，继续检查',
    'B. 基本准确，但我要补充',
    'C. 不准确，我重新描述',
  ].join('\n');
}

function formatQuestion(question: GuardQuestion, title: string): string {
  const options = question.options?.map((option) => `${option.label}. ${option.text}`).join('\n');
  return [`${title}：`, question.prompt, options].filter(Boolean).join('\n');
}

function blockedMessage(requirement: LazyDevRequirement): string {
  const tasks = requirement.recovery?.learningTasks.map((task, index) => `${index + 1}. ${task}`).join('\n') ?? '1. 重新说明需求目标、输入、输出和失败情况';
  return ['本轮需求停止开发。', `学习阻塞原因：${requirement.blockedReason ?? '未通过入门检查'}`, '建议先补足：', tasks, '恢复命令：/不准偷懒开发 继续'].join('\n');
}

function recentDomains(state: LazyDevGuardState): string[] {
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

function nowIso(): string {
  return new Date().toISOString();
}
