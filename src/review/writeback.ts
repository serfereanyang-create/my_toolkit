import type { AgentRuntime } from '../agent/agent.js';
import type { ReviewRunResult } from './reviewer.js';
import { priorityLabel } from './parse.js';

/**
 * Write a finished review back into the session's conversation history.
 *
 * Copied from codex's `exit_review_mode` (codex-rs/core/src/tasks/review.rs),
 * which records **two** messages: a `user` message wrapping the findings in a
 * `<user_action>` envelope, and an `assistant` message that is the review text
 * as the user reads it. The pair is what makes the next turn able to act on the
 * findings without any new state: the main agent sees a user message containing
 * the review, exactly as if the user had pasted it in.
 *
 * The `<user_action>` wrapper is load-bearing, not decoration. It marks the
 * message as system-originated so the agent does not mistake the reviewer's
 * prose for the human's own words — codex's own authorization logic keys off
 * that prefix.
 *
 * **Nothing is gated.** The findings are recorded and surfaced; no task is
 * blocked, no status changes, and no fix is attempted. `overall_correctness` is
 * presented and read by no decision logic — the same choice codex makes, and
 * the reason a reviewer's false positive costs the user nothing.
 */

/** Envelope codex uses to mark a system-authored user message. */
export const USER_ACTION_OPEN = '<user_action>';
export const USER_ACTION_CLOSE = '</user_action>';

/**
 * Render the findings block in codex's `format_review_findings_block` shape:
 * a header, then `- title — location` with the body indented beneath.
 */
export function renderFindingsBlock(result: ReviewRunResult): string {
  const { report } = result;
  // A review that never ran has no findings — but it is not a review that found
  // nothing. Without this branch the failure reason (result.error) was dropped on
  // the floor and the recorded user message read "No findings.", i.e. the next
  // turn was told the change was clean because the provider timed out.
  if (!result.ok) {
    return `Review did not run: ${result.error ?? 'no reason was returned.'}`;
  }
  if (report.unparsed) {
    return `Review did not return the structured result the rubric asks for. Raw output:\n\n${report.raw ?? ''}`;
  }
  if (report.findings.length === 0) return 'No findings.';

  const sorted = [...report.findings].sort((a, b) => {
    const pa = a.priority ?? 9;
    const pb = b.priority ?? 9;
    if (pa !== pb) return pa - pb;
    return (a.filePath ?? '').localeCompare(b.filePath ?? '');
  });

  const lines: string[] = [sorted.length > 1 ? 'Full review comments:' : 'Review comment:'];
  for (const finding of sorted) {
    lines.push('');
    const priority = priorityLabel(finding.priority);
    const title = priority ? `[${priority}] ${finding.title}` : finding.title;
    const location = finding.filePath
      ? `${finding.filePath}${finding.lineStart ? `:${finding.lineStart}${finding.lineEnd && finding.lineEnd !== finding.lineStart ? `-${finding.lineEnd}` : ''}` : ''}`
      : '(no location)';
    lines.push(`- ${title} — ${location}`);
    for (const bodyLine of finding.body.split(/\r?\n/)) lines.push(`  ${bodyLine}`);
  }
  return lines.join('\n');
}

/**
 * The `user` message recorded in history: the envelope plus the review content.
 *
 * The context line tells the *next* turn what this is and that acting on it is
 * optional — a review is information, not an instruction, so the agent must not
 * read the findings as a mandate to start editing.
 */
export function renderReviewUserMessage(result: ReviewRunResult): string {
  const explanation = result.report.explanation?.trim() ?? '';
  const parts = [
    result.ok ? explanation : '',
    renderFindingsBlock(result),
    result.warning ? `Review was partial: ${result.warning}` : '',
  ].filter(Boolean);
  const results = parts.join('\n');
  const context = result.ok
    ? '  <context>User initiated a code review. Here is the full review output from the reviewer model. The user may act on one or more of these comments; do not start fixing anything unless they ask.</context>'
    : '  <context>User initiated a code review, but it could not be run. The review below is an error report, not findings — there is nothing to fix from it.</context>';
  return [
    USER_ACTION_OPEN,
    context,
    '  <action>review</action>',
    `  <scope>${result.label}</scope>`,
    '  <results>',
    results,
    '  </results>',
    USER_ACTION_CLOSE,
  ].join('\n');
}

/** The `assistant` message: the review as the user reads it in the transcript. */
export function renderReviewAssistantMessage(result: ReviewRunResult): string {
  if (!result.ok) {
    return `代码审查未能完成：${result.error ?? '没有返回原因。'}\n\n可以重新运行 /review 再试一次。`;
  }
  const sections: string[] = [`代码审查：${result.label}`];
  const explanation = result.report.explanation?.trim();
  if (explanation) sections.push(explanation);
  if (result.report.findings.length > 0 || result.report.unparsed) {
    sections.push(renderFindingsBlock(result));
  } else {
    sections.push('未发现问题。');
  }
  // "No findings" is a claim about what the reviewer saw. If it did not see the
  // whole change, that claim has to be qualified in the message the user reads.
  if (result.warning) sections.push(`注意：${result.warning}`);
  const verdict = result.report.outcome === 'correct'
    ? '补丁正确'
    : result.report.outcome === 'incorrect'
      ? '补丁不正确'
      : undefined;
  if (verdict) sections.push(`总体结论：${verdict}`);
  return sections.join('\n\n');
}

/**
 * Record the review into the session.
 *
 * Returns the two recorded messages so a caller (the desktop bridge) can emit
 * them as events without re-reading the session.
 */
export async function recordReviewInHistory(
  runtime: AgentRuntime,
  result: ReviewRunResult,
): Promise<{ userMessage: string; assistantMessage: string }> {
  const userMessage = renderReviewUserMessage(result);
  const assistantMessage = renderReviewAssistantMessage(result);
  await runtime.sessions.appendMessage(runtime.session, { role: 'user', content: userMessage, name: 'review' });
  await runtime.sessions.appendMessage(runtime.session, { role: 'assistant', content: assistantMessage, name: 'review' });
  return { userMessage, assistantMessage };
}
