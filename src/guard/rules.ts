import type { DomainMatch, GuardQuestion, GuardRiskLevel, LearningCredit, ProfessionalRequirement } from './types.js';

const DEVELOPMENT_REQUEST_PATTERN =
  /做一个|写一个|实现|开发|修复|添加|新增|修改|改一下|保存按钮|网页|页面|组件|代码|数据库|删除|覆盖|迁移|配置|运行|文件|脚本|接口|api|bug|test|测试|build|部署|重构|安装|生成/iu;

export function isDevelopmentRequest(input: string): boolean {
  return DEVELOPMENT_REQUEST_PATTERN.test(input.trim());
}

export function translateRequirement(prompt: string, domains: DomainMatch[]): ProfessionalRequirement {
  const goal = inferGoal(prompt);
  const output = inferOutput(prompt);
  const fields = [
    { name: '目标', value: goal },
    { name: '使用者或对象', value: '当前 CLI 用户或目标功能的最终使用者' },
    { name: '输入', value: inferInput(prompt) },
    { name: '处理过程', value: inferProcess(prompt, domains) },
    { name: '输出', value: output },
    { name: '约束', value: inferConstraints(prompt) },
    { name: '失败情况', value: inferFailure(prompt) },
    { name: '验收标准', value: inferAcceptance(prompt) },
  ];
  const missingFields = fields.filter((field) => field.value.trim().length < 4).map((field) => field.name);

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
  const add = (points: number, reason: string): void => {
    score += points;
    reasons.push(reason);
  };

  if (/hello world|demo|示例|文案|只读|解释/.test(lower)) add(-8, 'low-impact-demo-or-readonly');
  if (/保存|写入|修改|添加|实现|按钮|页面|组件/.test(lower)) add(28, 'modifies-feature-or-files');
  if (/数据库|迁移|认证|权限|支付|批量|token|密钥/.test(lower)) add(45, 'sensitive-system-area');
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

  if (!input.askedQuestionIds.includes(`${baseId}-decision`)) {
    return {
      id: `${baseId}-decision`,
      kind: 'decision',
      concept: input.concept,
      prompt: decisionPrompt(input.prompt, input.riskLevel),
      expectedKeywords: input.riskLevel === 'critical' ? ['确认', '备份', '回滚', '不可逆', '生产', '风险'] : ['用户', '失败', '提示', '重试', '数据', '原因'],
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
    return option?.correct
      ? { passed: true, explanation: option.explanation }
      : { passed: false, explanation: option?.explanation ?? '请选择一个有效选项。' };
  }

  const keywords = question.expectedKeywords ?? [];
  const hitCount = keywords.filter((keyword) => normalized.includes(keyword.toLowerCase())).length;
  return hitCount >= 2
    ? { passed: true, explanation: '回答说明了关键取舍，可以继续。' }
    : { passed: false, explanation: '回答没有说明用户看到什么、失败后如何处理，或为什么这样设计。' };
}

export function addLearningCredit(credits: LearningCredit[], concept: string, domains: string[], now: string): LearningCredit[] {
  const existing = credits.find((credit) => credit.concept === concept);
  if (!existing) return [...credits, { concept, passedCount: 1, lastPassedAt: now, domains: Array.from(new Set(domains)) }];

  return credits.map((credit) =>
    credit.concept === concept
      ? {
          ...credit,
          passedCount: credit.passedCount + 1,
          lastPassedAt: now,
          domains: Array.from(new Set([...credit.domains, ...domains])),
        }
      : credit,
  );
}

function inferGoal(prompt: string): string {
  if (prompt.includes('保存')) return '让用户能够保存当前内容';
  if (prompt.includes('采集')) return '采集并呈现目标数据';
  if (/hello world/i.test(prompt)) return '创建一个最小可运行示例';
  return `实现用户描述的目标：${prompt.slice(0, 60)}`;
}

function inferInput(prompt: string): string {
  if (prompt.includes('点击') || prompt.includes('按钮')) return '用户触发界面操作';
  if (prompt.includes('采集') || prompt.includes('温度')) return '传感器或外部数据源提供的测量数据';
  return '用户提供的需求和上下文';
}

function inferOutput(prompt: string): string {
  if (prompt.includes('保存')) return '保存成功或失败的明确反馈';
  if (prompt.includes('网页')) return '用户可见的网页功能';
  if (prompt.includes('曲线')) return '可查看的历史曲线或数据展示';
  return '可验证的结果或成品';
}

function inferFailure(prompt: string): string {
  if (prompt.includes('失败')) return '按用户要求展示失败原因和下一步动作';
  if (prompt.includes('保存')) return '保存失败时提示原因，并保留重试路径';
  return '执行失败时说明原因，不静默失败';
}

function inferAcceptance(prompt: string): string {
  if (prompt.includes('保存')) return '用户触发保存后能确认成功或失败';
  if (prompt.includes('采集')) return '能看到采集结果，并能识别异常或无数据状态';
  return '用户能按描述验证功能是否完成';
}

function inferProcess(prompt: string, domains: DomainMatch[]): string {
  const labels = domains.map((domain) => domain.label).join('、') || '通用需求';
  return `按${labels}的字段拆解并实现最小可验证流程：${prompt.slice(0, 40)}`;
}

function inferConstraints(prompt: string): string {
  if (prompt.includes('生产') || prompt.includes('线上')) return '涉及生产环境，必须二次确认并保留回滚思路';
  if (prompt.includes('数据库') || prompt.includes('迁移')) return '涉及持久化结构，必须保留回滚和验证思路';
  return '保持改动最小、可验证、失败可解释';
}

function decisionPrompt(prompt: string, riskLevel: GuardRiskLevel): string {
  if (riskLevel === 'critical') return `这个需求可能产生不可逆影响，尤其可能影响生产环境。请说明你会如何二次确认、提前备份，并准备回滚方案；请结合“${prompt}”回答。`;
  if (prompt.includes('保存')) return '如果保存失败，你希望用户还能重新点击保存吗？为什么？';
  return `请说明这个需求失败时用户会看到什么，以及你为什么这样设计。需求：${prompt}`;
}
