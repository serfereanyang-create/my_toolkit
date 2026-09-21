import { describe, expect, it } from 'vitest';
import { appReducer, initialState } from './state';
import type { AgentEvent, ChatItem } from '../types';

/*
 * The `review_report` event carries a finished /review to the renderer.
 *
 * What these pin: the three outcomes must stay distinguishable. A review that
 * found nothing, a review whose reply could not be parsed, and a review that
 * failed are three different facts about the code, and the reducer is where the
 * difference is decided — if it collapses them here, no component downstream
 * can recover it.
 */

// The event arrives off the wire, so it is only as well-typed as the CLI's
// emit. Typing it as a partial AgentEvent keeps the test honest about that
// while still checking the reducer's handling of every field.
type ReviewEventInput = Partial<AgentEvent> & { type: 'review_report' };

function reduce(event: ReviewEventInput) {
  return appReducer(initialState, { type: 'agent/event', event: event as AgentEvent });
}

function reviewRow(event: ReviewEventInput): Extract<ChatItem, { kind: 'review' }> {
  const row = reduce(event).chat.find((item): item is Extract<ChatItem, { kind: 'review' }> => item.kind === 'review');
  if (!row) throw new Error('no review row was recorded');
  return row;
}

describe('review_report', () => {
  it('records a findings row', () => {
    const row = reviewRow({
      type: 'review_report',
      label: '未提交的改动',
      ok: true,
      outcome: 'incorrect',
      explanation: 'One defect.',
      durationMs: 4200,
      findings: [
        { title: 'Off by one', body: 'Runs past the end.', priority: 1, confidenceScore: 0.9, filePath: 'src/a.ts', lineStart: 10, lineEnd: 12 },
        { title: 'Unused import', body: 'Unreferenced.', priority: 3, filePath: 'src/a.ts', lineStart: 1 },
      ],
    });
    expect(row.label).toBe('未提交的改动');
    expect(row.ok).toBe(true);
    expect(row.outcome).toBe('incorrect');
    expect(row.durationMs).toBe(4200);
    expect(row.findings).toHaveLength(2);
    expect(row.findings[0]).toMatchObject({ title: 'Off by one', priority: 1, filePath: 'src/a.ts', lineStart: 10, lineEnd: 12 });
  });

  it('keeps a missing priority missing instead of defaulting it', () => {
    const row = reviewRow({
      type: 'review_report',
      label: 'x',
      ok: true,
      findings: [{ title: 'Unrated', body: 'No priority given.' }],
    });
    expect(row.findings[0]!.priority).toBeUndefined();
  });

  it('marks an unparsed review so the UI cannot read it as clean', () => {
    const row = reviewRow({ type: 'review_report', label: 'x', ok: true, unparsed: true, findings: [] });
    expect(row.unparsed).toBe(true);
    expect(row.findings).toEqual([]);
  });

  it('carries the failure reason on a failed review', () => {
    const row = reviewRow({ type: 'review_report', label: '相对 main', ok: false, error: '找不到提交：deadbee', findings: [] });
    expect(row.ok).toBe(false);
    expect(row.error).toBe('找不到提交：deadbee');
  });

  it('logs a failed review at error level with its reason', () => {
    const state = reduce({ type: 'review_report', label: 'x', ok: false, error: 'git 不可用', findings: [] });
    const entry = state.workLog.find((item) => item.title === '代码审查失败');
    expect(entry).toBeDefined();
    expect(entry!.detail).toBe('git 不可用');
    expect(entry!.type).toBe('error');
  });

  it('never leaves a failed review without a reason in the log', () => {
    // Same rule as every other failure: no unexplained errors.
    const state = reduce({ type: 'review_report', label: 'x', ok: false, findings: [] });
    const entry = state.workLog.find((item) => item.title === '代码审查失败');
    expect(entry!.detail).toBe('没有返回原因。');
  });

  it('logs the finding counts by priority', () => {
    const state = reduce({
      type: 'review_report',
      label: '未提交的改动',
      ok: true,
      findings: [
        { title: 'a', body: '', priority: 0 },
        { title: 'b', body: '', priority: 2 },
        { title: 'c', body: '', priority: 2 },
        { title: 'd', body: '' },
      ],
    });
    const entry = state.workLog.find((item) => item.title?.startsWith('代码审查完成'));
    expect(entry).toBeDefined();
    expect(entry!.detail).toContain('P0 1');
    expect(entry!.detail).toContain('P2 2');
    expect(entry!.detail).toContain('未分级 1');
  });

  it('says 未发现问题 only for a real empty result', () => {
    const clean = reduce({ type: 'review_report', label: 'x', ok: true, findings: [], outcome: 'correct' });
    expect(clean.workLog.find((item) => item.title?.startsWith('代码审查完成'))!.detail).toBe('未发现问题');

    const unparsed = reduce({ type: 'review_report', label: 'x', ok: true, unparsed: true, findings: [] });
    expect(unparsed.workLog.find((item) => item.title?.startsWith('代码审查完成'))!.detail).toBe('审查返回的内容不是结构化结果');
  });

  it('drops malformed findings rather than rendering empty rows', () => {
    const row = reviewRow({
      type: 'review_report',
      label: 'x',
      ok: true,
      findings: [null, 'not an object', {}, { title: '' }, { title: 'Real', body: 'ok' }],
    });
    expect(row.findings).toHaveLength(1);
    expect(row.findings[0]!.title).toBe('Real');
  });

  it('treats a missing findings array as no findings, not as a crash', () => {
    const row = reviewRow({ type: 'review_report', label: 'x', ok: true });
    expect(row.findings).toEqual([]);
    // `ok` defaults to true only because the event said nothing — an explicit
    // ok:false is what marks a failure, and it is checked above.
    expect(row.ok).toBe(true);
  });

  it('normalizes an unrecognized outcome to unknown', () => {
    expect(reviewRow({ type: 'review_report', label: 'x', ok: true, findings: [], outcome: 'maybe' }).outcome).toBe('unknown');
    expect(reviewRow({ type: 'review_report', label: 'x', ok: true, findings: [], outcome: 'correct' }).outcome).toBe('correct');
  });
});
