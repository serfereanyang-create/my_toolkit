import { randomUUID } from 'node:crypto';
import type { AgentRuntime } from '../agent/agent.js';
import { CODE_REVIEW_EXPERT_ID } from '../experts/profiles.js';
import { runSubAgent } from '../subagent/runner.js';
import type { ReviewOutcome, ParsedReview } from './parse.js';
import { parseReviewOutput, priorityLabel } from './parse.js';
import { REVIEW_TASK_PREAMBLE } from './rubric.js';
import type { ResolvedTarget } from './target.js';

/**
 * Run a code review as a separate read-only sub-session.
 *
 * The isolation is the point, and it is borrowed wholesale from codex's review
 * mode (codex-rs/core/src/tasks/review.rs): a *separate* session, a *read-only*
 * toolset, a rubric as its standing instruction, and a report that gates
 * nothing. A reviewer that runs inside the main conversation inherits the main
 * conversation's framing — it has already seen the plan, the reasoning, and the
 * author's intent, and it reviews the story rather than the diff. A fresh
 * session sees only the change and the criteria.
 *
 * **Purely informational.** There is no completion gate, no retry, no state
 * change. `overall_correctness` is surfaced to the user and read by no decision
 * logic — the same choice codex makes. A review that could block work would
 * make the reviewer's false positives the user's problem.
 *
 * The read-only-ness rests entirely on `codeReviewExpert.toolFilter`, because
 * `runSubAgent` hardcodes `confirm: () => Promise.resolve(true)` — the reviewer
 * can never be stopped by an approval prompt, so it must not be offered a tool
 * that needs one.
 */

export type ReviewRunResult = {
  ok: boolean;
  /** The reviewer's parsed report. `unparsed` marks a reply that did not match. */
  report: ParsedReview;
  /** What was reviewed, for the record. */
  label: string;
  sessionId: string;
  durationMs: number;
  steps: number;
  /** Set when the review did not complete — the reason, never a silent empty report. */
  error?: string;
};

/**
 * Cap on the diff pasted into the reviewer's prompt.
 *
 * The reviewer has read tools and can fetch more, so a large change is not a
 * failure; but an unbounded prompt would blow the context before the review
 * starts. `resolveReviewTarget` reports truncation in the prompt so the
 * reviewer knows to go read the rest.
 */
export const REVIEW_DIFF_CHARS_IN_PROMPT = 120_000;

/** Build the reviewer's task prompt: what to look at, plus the diff. */
export function buildReviewPrompt(target: ResolvedTarget): string {
  const diff = target.diff.length > REVIEW_DIFF_CHARS_IN_PROMPT
    ? `${target.diff.slice(0, REVIEW_DIFF_CHARS_IN_PROMPT)}\n\n[diff 过长，已截断。请用 git_diff / read_file 自行查看其余部分。]`
    : target.diff;

  const sections = [
    REVIEW_TASK_PREAMBLE,
    '',
    '## 审查范围',
    target.label,
    target.files.length > 0
      ? `涉及文件（共 ${target.files.length} 个）：\n${target.files.slice(0, 200).map((f) => `- ${f}`).join('\n')}`
      : '（没有文件路径）',
  ];

  if (target.truncated) {
    sections.push(
      '',
      `注意：下面的 diff 已被截断（完整长度 ${target.fullLength ?? '未知'} 字符）。`,
      '不要对未看到的部分下结论；需要时用工具自行查看。',
    );
  }

  sections.push(
    '',
    '## 改动内容（diff）',
    '```diff',
    diff,
    '```',
    '',
    '按 rubric 的 output schema 输出 JSON，不要包裹在 markdown 代码块里，不要输出 JSON 之外的文字。',
  );

  return sections.join('\n');
}

/**
 * Run the review.
 *
 * Errors are returned rather than thrown: a review that could not run is a
 * result the caller has to report to the user, and throwing would tempt a
 * caller into treating it as "no findings".
 */
export async function runCodeReview(options: {
  runtime: AgentRuntime;
  target: ResolvedTarget;
  /** Override for tests. */
  id?: string;
}): Promise<ReviewRunResult> {
  const { runtime, target } = options;
  const t0 = Date.now();
  const id = options.id ?? `review_${randomUUID().slice(0, 8)}`;

  let result;
  try {
    result = await runSubAgent(
      {
        id,
        goal: buildReviewPrompt(target),
        // Short label for the progress panel and 子智能体目录. The goal above is
        // the whole diff, which must not be used as a display label (it would
        // flood the panel and get persisted into the desktop's run records).
        label: `代码审查：${target.label}`,
        expert: CODE_REVIEW_EXPERT_ID,
        // The rubric is NOT passed here: it is the expert profile's system
        // prompt (the codex arrangement — rubric.md loaded verbatim as the
        // system prompt). Passing it again as context would duplicate 9KB in
        // every review request.
        // A review is a bounded read-and-report job. A segment budget is not a
        // work cap (rollover continues in a fresh segment), but a reviewer that
        // needs four segments is looping rather than reviewing.
        maxSteps: 30,
      },
      runtime,
      new Map(),
      undefined,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      report: { findings: [], outcome: 'unknown' },
      label: target.label,
      sessionId: '',
      durationMs: Date.now() - t0,
      steps: 0,
      error: `审查未能运行：${message}`,
    };
  }

  if (!result.ok) {
    return {
      ok: false,
      report: { findings: [], outcome: 'unknown' },
      label: target.label,
      sessionId: result.sessionId,
      durationMs: result.durationMs,
      steps: result.steps,
      error: result.answer || '审查未能运行，但没有返回原因。',
    };
  }

  return {
    ok: true,
    report: parseReviewOutput(result.answer),
    label: target.label,
    sessionId: result.sessionId,
    durationMs: result.durationMs,
    steps: result.steps,
  };
}

/** One-line summary for the terminal and the desktop notification. */
export function summarizeReview(result: ReviewRunResult): string {
  if (!result.ok) return result.error ?? '审查未能运行。';
  const { report } = result;
  if (report.unparsed) {
    return `审查已完成，但返回的不是结构化结果（${result.label}）。原始输出已保留。`;
  }
  if (report.findings.length === 0) {
    const verdict = result.report.outcome === 'correct' ? '未发现问题' : '未返回任何发现';
    return `审查完成（${result.label}）：${verdict}。`;
  }
  const counts = new Map<string, number>();
  for (const finding of report.findings) {
    const label = priorityLabel(finding.priority) ?? '未分级';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = ['P0', 'P1', 'P2', 'P3', '未分级']
    .filter((label) => counts.has(label))
    .map((label) => `${label} ${counts.get(label)}`);
  return `审查完成（${result.label}）：发现 ${report.findings.length} 个问题（${parts.join('，')}）。`;
}

/** Markdown rendering of a review, for the terminal and for session history. */
export function renderReviewMarkdown(result: ReviewRunResult): string {
  const lines: string[] = [`## 代码审查：${result.label}`, ''];

  if (!result.ok) {
    lines.push(`审查未能运行：${result.error ?? '没有返回原因。'}`);
    return lines.join('\n');
  }

  const { report } = result;
  if (report.unparsed) {
    lines.push('审查返回的内容不是 rubric 规定的结构化结果，因此无法逐条呈现。原始输出如下：', '', '```', report.raw ?? '', '```');
    return lines.join('\n');
  }

  if (report.findings.length === 0) {
    lines.push('未发现问题。');
  } else {
    // Sorted by priority, then by file — a report the user reads top-down, so
    // the worst thing must not be buried under the order the model emitted.
    const sorted = [...report.findings].sort((a, b) => {
      const pa = a.priority ?? 9;
      const pb = b.priority ?? 9;
      if (pa !== pb) return pa - pb;
      return (a.filePath ?? '').localeCompare(b.filePath ?? '');
    });
    for (const finding of sorted) {
      const label = priorityLabel(finding.priority) ?? '—';
      const where = finding.filePath
        ? ` · \`${finding.filePath}${finding.lineStart ? `:${finding.lineStart}` : ''}\``
        : '';
      const confidence = finding.confidenceScore !== undefined
        ? ` · 置信度 ${(finding.confidenceScore * 100).toFixed(0)}%`
        : '';
      lines.push(`- **[${label}]** ${finding.title}${where}${confidence}`);
      if (finding.body) lines.push(`  ${finding.body.replace(/\n+/g, ' ')}`);
    }
  }

  const verdict = report.outcome === 'correct'
    ? '补丁正确'
    : report.outcome === 'incorrect'
      ? '补丁不正确'
      : '未给出总体结论';
  lines.push('', `总体结论：${verdict}${report.explanation ? ` —— ${report.explanation}` : ''}`);
  return lines.join('\n');
}

export type { ReviewOutcome };
