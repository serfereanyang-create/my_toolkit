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
    return { status: 'blocked', error: input.error ?? input.finalAnswer ?? 'Task failed' };
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
