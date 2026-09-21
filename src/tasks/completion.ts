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

  if (/\b(done|completed|finished|已完成|完成了)\b/i.test(answer) && !/\b(maybe|probably|似乎|可能)\b/i.test(answer)) {
    return { status: 'done', summary: answer.slice(0, 240) };
  }

  return { status: 'unclear', error: 'Task completion was unclear; mark blocked for human review.' };
}
