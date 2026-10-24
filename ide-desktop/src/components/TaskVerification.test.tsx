import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskVerification } from './TaskVerification';
import { TaskBoardCard } from './TaskBoardCard';
import { taskVerification, taskResultText } from '../lib/taskVerification';
import type { TaskVerificationAttempt, TaskBoard } from '../types';

function attempt(status: TaskVerificationAttempt['status']): TaskVerificationAttempt {
  return { id: status, phase: status === 'passed' ? 'repair' : 'initial', status, startedAt: '2026-10-23T00:00:00Z', results: [{ name: 'test', command: 'npm test', status: status === 'incomplete' ? 'skipped' : status, durationMs: 1234, output: `${status} output`, exitCode: status === 'passed' ? 0 : 1 }], summary: status };
}

describe('task verification evidence', () => {
  it('keeps original failure and repaired success in separate readable attempts', () => {
    const markup = renderToStaticMarkup(createElement(TaskVerification, { attempts: [attempt('failed'), attempt('passed')] }));
    expect(markup).toContain('验证失败'); expect(markup).toContain('验证通过');
    expect(markup).toContain('failed output'); expect(markup).toContain('passed output');
    expect(markup).toContain('退出码 0'); expect(markup).toContain('npm test'); expect(markup).toContain('1.23');
  });
  it('shows skip, cancellation and incomplete states without claiming a pass', () => {
    for (const status of ['skipped', 'cancelled', 'incomplete'] as const) {
      const markup = renderToStaticMarkup(createElement(TaskVerification, { attempts: [attempt(status)] }));
      expect(markup).not.toContain('验证通过'); expect(markup).toContain(status === 'skipped' ? '没有实际执行' : status === 'cancelled' ? '验证已中断' : '验证不完整');
    }
  });
  it('ignores corrupt payloads and downgrades claimed passes without actual evidence', () => {
    expect(taskVerification([null, 'wrong', { status: 'invented' }])).toEqual([]);
    expect(taskVerification([{ status: 'passed', results: [] }])[0].status).toBe('incomplete');
    expect(taskVerification([{ ...attempt('passed'), results: [{ ...attempt('failed').results[0] }] }])[0].status).toBe('failed');
    expect(taskVerification([{ status: 'failed', results: [null, { name: 'test', status: 'failed', output: 12, durationMs: -1 }] }])[0].results[0]).toMatchObject({ output: '', durationMs: 0 });
  });
  it('shows missing legacy evidence and removes old technical result suffixes', () => {
    const board: TaskBoard = { id: 'legacy', title: 'Legacy', goal: 'Legacy', status: 'completed', runtimeMode: 'idle', activeTaskId: 'task_1', tasks: [{ id: 'task_1', title: 'Task', status: 'done', dependsOn: [], resultSummary: 'candidate [verified]' }] };
    const markup = renderToStaticMarkup(createElement(TaskBoardCard, { board, onAction() {} }));
    expect(markup).toContain('验证未记录'); expect(markup).not.toContain('[verified]');
    expect(taskResultText('candidate [verification skipped]')).toBe('candidate');
  });
  it('renders logs as text so command output cannot inject markup', () => {
    const report = attempt('failed'); report.results[0].output = '<script>window.injected = true</script>';
    const markup = renderToStaticMarkup(createElement(TaskVerification, { attempts: [report] }));
    expect(markup).toContain('&lt;script&gt;'); expect(markup).not.toContain('<script>');
  });
});
