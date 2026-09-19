/**
 * reviewLoop.ts — 规划者/执行者/评审者协作回路（LangGraph supervisor 风格）。
 *
 * 一段任务：执行者产出 → 评审者按验收标准打分 → 未达标则带反馈重试，
 * 最多 N 轮。每轮记录评审意见，最终返回最优产出与迭代轨迹。
 * 评审由模型给出的结构化 JSON verdict 驱动；无模型时退化为一次执行。
 */

export interface ReviewVerdict {
  /** 0-100 质量分 */
  score: number;
  /** 是否达标（可发布） */
  approved: boolean;
  /** 具体改进意见 */
  issues: string[];
  /** 一句话总评 */
  summary: string;
}

export interface LoopRound {
  index: number;
  candidate: string;
  verdict: ReviewVerdict;
}

export interface ReviewLoopResult {
  best: string;
  rounds: LoopRound[];
  approved: boolean;
  finalScore: number;
  iterations: number;
}

export interface ReviewLoopOptions {
  /** 最大轮数（含首轮），默认 3 */
  maxRounds?: number;
  /** 达标分数线，默认 80 */
  approvalThreshold?: number;
}

/** 解析评审者返回的 JSON verdict；无法解析时返回 null（调用方决定退化）。 */
export function parseVerdict(reviewText: string): ReviewVerdict | null {
  const start = reviewText.indexOf('{');
  const end = reviewText.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(reviewText.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const score = typeof raw.score === 'number' && Number.isFinite(raw.score) ? Math.max(0, Math.min(100, Math.round(raw.score))) : null;
  if (score === null) return null;
  const approved = raw.approved === true;
  const issues = Array.isArray(raw.issues) ? (raw.issues as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  const summary = typeof raw.summary === 'string' ? raw.summary : '';
  return { score, approved, issues, summary };
}

/** 构造给评审者的提示（要求严格 JSON 输出）。 */
export function buildReviewerPrompt(candidate: string, acceptance: string[]): string {
  const checklist = acceptance.length > 0
    ? acceptance.map((a) => `- ${a}`).join('\n')
    : '- 正确性、完整性、边界处理';
  return [
    '你是严格的代码/产出评审者。按下列验收点审查候选内容，输出一个 JSON 对象（不要输出其它文字）：',
    '{ "score": 0-100, "approved": true|false, "issues": ["..."], "summary": "一句话" }',
    'approved 仅当 score >= 80 且无阻断性问题时为 true。',
    '',
    `验收点：\n${checklist}`,
    '',
    '--- 候选内容 ---',
    candidate,
  ].join('\n');
}

/** 把评审意见拼成给执行者的改进提示。 */
export function buildRevisePrompt(originalTask: string, candidate: string, verdict: ReviewVerdict): string {
  const issues = verdict.issues.length > 0 ? verdict.issues.map((i) => `- ${i}`).join('\n') : '- （评审未给明细，综合提升质量）';
  return [
    originalTask,
    '',
    '上一版产出未通过评审，请按以下意见改进后重新输出完整结果：',
    issues,
    `评审总评：${verdict.summary || '（无）'}（得分 ${verdict.score}）`,
    '',
    '--- 上一版产出 ---',
    candidate,
  ].join('\n');
}

/** 一轮"执行→评审→（未达标）修订→再审"回路。生成函数由调用方注入（可测）。 */
export async function runReviewLoop(params: {
  task: string;
  acceptance: string[];
  generate: (prompt: string, round: number) => Promise<string>;
  review: (candidate: string) => Promise<ReviewVerdict | null>;
  options?: ReviewLoopOptions;
}): Promise<ReviewLoopResult> {
  const maxRounds = Math.max(1, Math.min(5, params.options?.maxRounds ?? 3));
  const threshold = params.options?.approvalThreshold ?? 80;

  const rounds: LoopRound[] = [];
  let currentPrompt = params.task;
  let best: { candidate: string; verdict: ReviewVerdict } | null = null;

  for (let round = 0; round < maxRounds; round += 1) {
    const candidate = await params.generate(currentPrompt, round);
    const verdict = await params.review(candidate);
    if (!verdict) {
      // 评审不可用（无模型/解析失败）：诚实返回首轮产出，标注未评审。
      const unreviewed: ReviewVerdict = { score: 0, approved: false, issues: ['评审未返回有效结论'], summary: '未评审' };
      rounds.push({ index: round, candidate, verdict: unreviewed });
      if (!best) best = { candidate, verdict: unreviewed };
      return finish(best, rounds, false, rounds.length);
    }
    rounds.push({ index: round, candidate, verdict });
    if (!best || verdict.score > best.verdict.score) best = { candidate, verdict };
    if (verdict.approved || verdict.score >= threshold) {
      return finish(best, rounds, true, round + 1);
    }
    currentPrompt = buildRevisePrompt(params.task, candidate, verdict);
  }
  // 循环至少执行一轮，best 必被赋值；守卫只为类型收窄。
  if (!best) {
    return { best: '', rounds, approved: false, finalScore: 0, iterations: 0 };
  }
  return finish(best, rounds, false, maxRounds);
}

function finish(
  best: { candidate: string; verdict: ReviewVerdict },
  rounds: LoopRound[],
  approved: boolean,
  iterations: number,
): ReviewLoopResult {
  return {
    best: best.candidate,
    rounds,
    approved,
    finalScore: best.verdict.score,
    iterations,
  };
}
