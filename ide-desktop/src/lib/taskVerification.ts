import type { TaskVerificationAttempt } from '../types';

export const verificationLabels: Record<TaskVerificationAttempt['status'], string> = {
  running: '验证中', passed: '验证通过', failed: '验证失败', skipped: '验证未执行', cancelled: '验证已中断', incomplete: '验证不完整',
};
export const verificationCheckLabels = { typecheck: '类型检查', test: '测试', build: '构建', configuration: '项目配置' };
const checkStatuses = new Set(['running', 'passed', 'failed', 'skipped', 'cancelled']);

function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

export function taskVerification(value: unknown): TaskVerificationAttempt[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((attempt, index) => {
    if (!record(attempt) || typeof attempt.status !== 'string' || !Object.hasOwn(verificationLabels, attempt.status)) return [];
    const results: TaskVerificationAttempt['results'] = !Array.isArray(attempt.results) ? [] : attempt.results.flatMap(check => {
      if (!record(check) || typeof check.name !== 'string' || !Object.hasOwn(verificationCheckLabels, check.name) || typeof check.status !== 'string' || !checkStatuses.has(check.status)) return [];
      return [{
        name: check.name as TaskVerificationAttempt['results'][number]['name'],
        status: check.status as TaskVerificationAttempt['results'][number]['status'],
        command: typeof check.command === 'string' ? check.command : check.name,
        durationMs: typeof check.durationMs === 'number' && Number.isFinite(check.durationMs) ? Math.max(0, check.durationMs) : 0,
        output: typeof check.output === 'string' ? check.output : '',
        ...(check.exitCode === null || typeof check.exitCode === 'number' && Number.isFinite(check.exitCode) ? { exitCode: check.exitCode } : {}),
        ...(typeof check.reason === 'string' ? { reason: check.reason } : {}),
      }];
    });
    let status = attempt.status as TaskVerificationAttempt['status'];
    if (status === 'passed') {
      if (results.some(check => check.status === 'failed')) status = 'failed';
      else if (!results.some(check => check.status === 'passed')) status = 'incomplete';
    }
    return [{ id: typeof attempt.id === 'string' ? attempt.id : `legacy-${index}`, phase: attempt.phase === 'repair' ? 'repair' : 'initial', status, startedAt: typeof attempt.startedAt === 'string' ? attempt.startedAt : '', ...(typeof attempt.finishedAt === 'string' ? { finishedAt: attempt.finishedAt } : {}), summary: typeof attempt.summary === 'string' ? attempt.summary : '', results }];
  });
}

export function taskResultText(value: string): string {
  return value.replace(/\s*\[(?:verified(?: after repair)?|verification skipped)\]\s*$/i, '');
}
