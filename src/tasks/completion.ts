export type TaskCompletionInput = {
  ok: boolean;
  finalAnswer: string;
  hadTerminalFailure: boolean;
  error?: string;
};

export type TaskCompletionResult =
  | { status: 'done'; summary: string }
  | { status: 'blocked'; error: string }
  | { status: 'unclear'; error: string };

/**
 * "done" said in the negative. A model that explains why it is NOT finished
 * used to be marked done because the answer contained the word "done"
 * ("The task is not done yet …"), which ended the task, ran verification
 * against half-finished work, and moved the board on.
 */
const NOT_DONE_PATTERN = /(?:\b(?:not|never)\s+(?:yet\s+)?(?:done|completed?|finished?)\b|\b(?:isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't|didn't)\s+(?:been\s+)?(?:done|completed?|finished?)\b|\bnot\s+complete\b|\bincomplete\b|\bunfinished\b|\bstill\s+(?:need|needs|have|has|working|blocked)\b|\bblocked\b|(?:还没|尚未|没有|未)(?:完成|做完|结束)|(?:不能|无法)完成)/i;

const CHINESE_DONE_PATTERN = /(?:已完成|完成了|做完了|搞定了|已修复|修复完成)/;

const HEDGE_PATTERN = /\b(?:maybe|probably|possibly|might)\b|似乎|可能|大概|应该已/i;

export function detectTaskCompletion(input: TaskCompletionInput): TaskCompletionResult {
  if (input.hadTerminalFailure || input.ok === false) {
    // Prefer the explicit error, then whatever the turn actually said. The old
    // fallback was the bare string 'Task failed', which told the user nothing —
    // the real reason had usually been produced upstream and then dropped here.
    const detail = input.error?.trim() || input.finalAnswer?.trim();
    return {
      status: 'blocked',
      error: detail || '任务失败，但没有返回失败原因。',
    };
  }

  const answer = input.finalAnswer.trim();
  const doneMarker = answer.match(/TASK_DONE:\s*(.+)$/im);
  if (doneMarker) {
    return { status: 'done', summary: doneMarker[1].trim() };
  }

  if (NOT_DONE_PATTERN.test(answer)) {
    return { status: 'unclear', error: 'Task completion was unclear; mark blocked for human review.' };
  }

  // `\b` around the Chinese alternatives never matched (CJK characters are not
  // regex word characters), so "已完成" / "完成了所有步骤" fell through to
  // `unclear` and a board full of completed work stayed pending.
  if (!HEDGE_PATTERN.test(answer) && (/\b(?:done|completed|finished)\b/i.test(answer) || CHINESE_DONE_PATTERN.test(answer))) {
    return { status: 'done', summary: answer.slice(0, 240) };
  }

  return { status: 'unclear', error: 'Task completion was unclear; mark blocked for human review.' };
}
