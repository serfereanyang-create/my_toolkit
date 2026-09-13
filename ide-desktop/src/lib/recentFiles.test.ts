import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearRecent,
  forgetRecent,
  formatAgo,
  loadRecent,
  normalizePath,
  rankRecent,
  recentLabel,
  touchRecent,
  type RecentFile,
} from './recentFiles';

// localStorage shim for the node test environment.
const memory = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => { memory.set(k, v); },
  removeItem: (k: string) => { memory.delete(k); },
};

beforeEach(() => {
  memory.clear();
});

describe('normalizePath', () => {
  it('converts backslashes and collapses doubles', () => {
    expect(normalizePath('C:\\a\\b.ts')).toBe('C:/a/b.ts');
    expect(normalizePath('a//b')).toBe('a/b');
  });
});

describe('touchRecent', () => {
  it('adds new files to the front', () => {
    const out = touchRecent('/proj', 'C:/x/a.ts');
    expect(out[0].path).toBe('C:/x/a.ts');
    expect(out[0].opens).toBe(1);
  });

  it('bumps opens and moves re-opened files to the front', () => {
    touchRecent('/proj', 'a.ts');
    touchRecent('/proj', 'b.ts');
    const out = touchRecent('/proj', 'a.ts');
    expect(out[0].path).toBe('a.ts');
    expect(out[0].opens).toBe(2);
    expect(out[1].path).toBe('b.ts');
  });

  it('caps the list at 30 entries', () => {
    for (let i = 0; i < 40; i += 1) touchRecent('/proj', `f${i}.ts`);
    const list = loadRecent('/proj');
    expect(list.length).toBe(30);
    // Oldest first-added entries evicted; last added kept.
    expect(list[0].path).toBe('f39.ts');
  });

  it('namespaces by workspace root', () => {
    touchRecent('/proj-a', 'only-a.ts');
    expect(loadRecent('/proj-b')).toEqual([]);
  });

  it('ignores empty roots', () => {
    expect(touchRecent('', 'x.ts')).toEqual([]);
    expect(loadRecent('')).toEqual([]);
  });
});

describe('loadRecent', () => {
  it('drops malformed stored rows', () => {
    memory.set('zcode.recent:/p', JSON.stringify([{ path: 'good.ts', lastOpenedAt: 1, opens: 1 }, { nope: true }, null, 42]));
    const list = loadRecent('/p');
    expect(list.map((f) => f.path)).toEqual(['good.ts']);
  });

  it('survives garbage in storage', () => {
    memory.set('zcode.recent:/p', '{{{broken');
    expect(loadRecent('/p')).toEqual([]);
  });
});

describe('forget / clear', () => {
  it('removes a single entry', () => {
    touchRecent('/p', 'keep.ts');
    touchRecent('/p', 'drop.ts');
    const out = forgetRecent('/p', 'drop.ts');
    expect(out.map((f) => f.path)).toEqual(['keep.ts']);
  });

  it('clear empties the workspace list', () => {
    touchRecent('/p', 'x.ts');
    clearRecent('/p');
    expect(loadRecent('/p')).toEqual([]);
  });
});

describe('rankRecent', () => {
  const now = Date.now();
  const mk = (path: string, opens: number, ageDays: number): RecentFile => ({
    path, opens, lastOpenedAt: now - ageDays * 86_400_000,
  });

  it('prefers fresh single-open over stale heavy use', () => {
    const ranked = rankRecent([mk('stale.ts', 50, 30), mk('fresh.ts', 1, 0)], now);
    expect(ranked[0].path).toBe('fresh.ts');
  });

  it('prefers heavy recent over light recent', () => {
    const ranked = rankRecent([mk('light.ts', 1, 1), mk('heavy.ts', 10, 1)], now);
    expect(ranked[0].path).toBe('heavy.ts');
  });

  it('half-life at 3 days halves an equal-opens rival', () => {
    const ranked = rankRecent([mk('a.ts', 4, 6), mk('b.ts', 2, 0)], now);
    // score a = 4 * 0.25 = 1; score b = 2. b wins.
    expect(ranked[0].path).toBe('b.ts');
  });
});

describe('display helpers', () => {
  it('recentLabel shows file + trailing dir path', () => {
    expect(recentLabel('C:/proj/src/components/App.tsx')).toBe('App.tsx · src/components');
    expect(recentLabel('a.ts')).toBe('a.ts');
  });

  it('formatAgo buckets minutes/hours/days/weeks', () => {
    const now = Date.now();
    expect(formatAgo(now - 10_000, now)).toBe('刚刚');
    expect(formatAgo(now - 5 * 60_000, now)).toBe('5 分');
    expect(formatAgo(now - 3 * 3600_000, now)).toBe('3 时');
    expect(formatAgo(now - 2 * 86_400_000, now)).toBe('2 天');
    expect(formatAgo(now - 9 * 86_400_000, now)).toBe('1 周');
  });
});
