import { randomUUID } from 'node:crypto';
import type { TaskItem, TaskVerificationAttempt } from './types.js';
import { runVerifySuite, type VerifyRunner } from './verify.js';

export async function verifyTask(options: {
  task: TaskItem;
  phase: TaskVerificationAttempt['phase'];
  workspaceRoot: string;
  signal?: AbortSignal;
  runner?: VerifyRunner;
  env?: NodeJS.ProcessEnv;
  onUpdate: () => Promise<void>;
}) {
  const attempt: TaskVerificationAttempt = { id: randomUUID(), phase: options.phase, status: 'running', startedAt: new Date().toISOString(), summary: 'Verification in progress', results: [] };
  options.task.verification = [...(options.task.verification ?? []), attempt];
  await options.onUpdate();
  try {
    const result = await runVerifySuite({
      workspaceRoot: options.workspaceRoot, signal: options.signal, runner: options.runner, env: options.env,
      onProgress: async results => { attempt.results = results; await options.onUpdate(); },
    });
    attempt.results = result.results;
    attempt.summary = result.summary;
    attempt.status = result.ok ? result.results.some(check => check.status === 'passed') ? 'passed' : 'skipped' : 'failed';
    attempt.finishedAt = new Date().toISOString();
    await options.onUpdate();
    return result;
  } catch (error) {
    const cancelled = options.signal?.aborted || (error instanceof Error && error.name === 'AgentCancelledError');
    attempt.status = cancelled ? 'cancelled' : 'failed';
    attempt.summary = cancelled ? 'Verification cancelled' : `Verification error: ${error instanceof Error ? error.message : String(error)}`;
    attempt.finishedAt = new Date().toISOString();
    attempt.results = attempt.results.map(check => check.status === 'running' ? { ...check, status: cancelled ? 'cancelled' : 'failed', reason: attempt.summary } : check);
    await options.onUpdate();
    throw error;
  }
}
