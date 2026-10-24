import { describe, expect, it } from 'vitest';
import { formatWorkDuration, turnStatusLabel } from './workProgress';

describe('work progress labels', () => {
  it.each([
    [-500, '0 秒'], [Number.NaN, '0 秒'], [Infinity, '0 秒'],
    [42900, '42 秒'], [65000, '1 分 5 秒'], [3720000, '1 小时 2 分'],
  ])('formats %s milliseconds as %s', (milliseconds, expected) => {
    expect(formatWorkDuration(milliseconds)).toBe(expected);
  });

  it('distinguishes thinking from running steps', () => {
    expect(turnStatusLabel([], true)).toBe('思考中');
    expect(turnStatusLabel([{ status: 'running' }], true)).toBe('执行中');
  });

  it('reports failures instead of claiming the turn completed successfully', () => {
    expect(turnStatusLabel([{ status: 'done' }, { status: 'failed' }], false)).toBe('1 个步骤失败');
  });

  it('does not call a still-running step successful when the turn ended', () => {
    expect(turnStatusLabel([{ status: 'running' }], false)).toBe('已结束 1 个步骤');
  });

  it('summarises completed and empty turns', () => {
    expect(turnStatusLabel([{ status: 'done' }, { status: 'done' }], false)).toBe('已完成 2 个步骤');
    expect(turnStatusLabel([], false)).toBe('本轮已结束');
  });
});
