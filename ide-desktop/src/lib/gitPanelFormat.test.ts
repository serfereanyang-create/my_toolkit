import { describe, expect, it } from 'vitest';
import {
  formatGoalElapsed, taskProgress, stageProgress, computeStages, gitChangedFileCount,
} from './gitPanelFormat';

describe('gitChangedFileCount', () => {
  it('counts a partially staged file once alongside untracked paths', () => {
    expect(gitChangedFileCount({ ok: true, staged: [{ path: 'auth.ts', index: 'M', working: 'M' }], unstaged: [{ path: 'auth.ts', index: 'M', working: 'M' }], untracked: ['new.ts'] })).toBe(2);
  });
  it('handles missing file groups and an unavailable status', () => {
    expect(gitChangedFileCount({ ok: true })).toBe(0);
    expect(gitChangedFileCount(null)).toBe(0);
  });
});

describe('formatGoalElapsed', () => {
  it('formats sub-minute durations as seconds only', () => {
    expect(formatGoalElapsed(0)).toBe('0秒');
    expect(formatGoalElapsed(50_000)).toBe('50秒');
    expect(formatGoalElapsed(59_999)).toBe('59秒');
  });
  it('formats minutes and seconds without the hour unit', () => {
    expect(formatGoalElapsed(60_000)).toBe('1分 0秒');
    expect(formatGoalElapsed(38 * 60_000 + 50_000)).toBe('38分 50秒');
  });
  it('formats hours minutes seconds like the Codex goal timer', () => {
    expect(formatGoalElapsed(6 * 3600_000 + 38 * 60_000 + 50_000)).toBe('6小时 38分 50秒');
    expect(formatGoalElapsed(3600_000)).toBe('1小时 0分 0秒');
  });
  it('clamps negative and non-finite input to zero', () => {
    expect(formatGoalElapsed(-5000)).toBe('0秒');
    expect(formatGoalElapsed(Number.NaN)).toBe('0秒');
  });
});

describe('taskProgress', () => {
  it('counts done and skipped as finished', () => {
    const p = taskProgress([
      { status: 'done' }, { status: 'skipped' }, { status: 'pending' }, { status: 'in_progress' },
    ]);
    expect(p.done).toBe(2);
    expect(p.total).toBe(4);
    expect(p.label).toBe('2/4');
  });
  it('handles empty lists', () => {
    expect(taskProgress([]).label).toBe('0/0');
  });
});

describe('stageProgress', () => {
  it('renders the same n/m label', () => {
    expect(stageProgress([{ status: 'done' }, { status: 'blocked' }])).toBe('1/2');
  });
});

describe('computeStages', () => {
  const t = (id: string, dependsOn: string[] = []): { id: string; title: string; status: string; dependsOn: string[] } => ({
    id, title: id, status: 'pending', dependsOn,
  });

  it('puts independent tasks in stage 1', () => {
    const stages = computeStages([t('a'), t('b')]);
    expect(stages).toHaveLength(1);
    expect(stages[0].stage).toBe(1);
    expect(stages[0].tasks.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('bumps dependents one stage deeper than their parents', () => {
    const stages = computeStages([t('a'), t('b', ['a']), t('c', ['b'])]);
    expect(stages.map((s) => s.stage)).toEqual([1, 2, 3]);
  });

  it('caps stage depth at 4', () => {
    const chain = [t('a'), t('b', ['a']), t('c', ['b']), t('d', ['c']), t('e', ['d'])];
    const stages = computeStages(chain);
    expect(stages[stages.length - 1].stage).toBe(4);
    // d and e collapse into stage 4 together
    expect(stages[stages.length - 1].tasks.map((x) => x.id)).toEqual(['d', 'e']);
  });

  it('survives dependency cycles without infinite recursion', () => {
    const stages = computeStages([t('a', ['b']), t('b', ['a'])]);
    expect(stages.length).toBeGreaterThan(0);
  });

  it('treats unknown dependency ids as no parent (stage 1)', () => {
    const stages = computeStages([t('a', ['ghost'])]);
    expect(stages[0].stage).toBe(1);
  });
});
