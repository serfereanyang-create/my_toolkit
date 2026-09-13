import { describe, expect, it } from 'vitest';
import { fuzzyRank, fuzzyRankItems, highlightRanges, scoreFuzzy } from './fuzzy';

describe('scoreFuzzy', () => {
  it('returns a full score for the empty query', () => {
    expect(scoreFuzzy('', 'anything')?.ranges).toEqual([]);
  });

  it('rejects non-subsequences', () => {
    expect(scoreFuzzy('xyz', 'abc')).toBeNull();
  });

  it('ranks prefix substring above mid-string substring', () => {
    const a = scoreFuzzy('set', 'settings panel')!;
    const b = scoreFuzzy('set', 'get presets')!;
    expect(a.score).toBeGreaterThan(b.score);
  });

  it('prefers compact matches over scattered ones', () => {
    const compact = scoreFuzzy('opfile', 'openFile window')!;
    const scattered = scoreFuzzy('opfile', 'options of a profile')!;
    // Both are subsequences; the contiguous-word one must win.
    expect(compact).toBeDefined();
    expect(scattered).toBeDefined();
    expect(compact.score).toBeGreaterThan(scattered.score);
  });

  it('gives word-boundary chars a bonus so abbreviation queries work', () => {
    // "csp" against "Ctrl+Shift+P command palette" hits at separators.
    const hit = scoreFuzzy('csp', 'Ctrl Shift P palette');
    expect(hit).not.toBeNull();
  });

  it('matches CJK queries against CJK targets as a subsequence', () => {
    const hit = scoreFuzzy('关闭', '关闭当前标签页');
    expect(hit).not.toBeNull();
    // Contiguous CJK should score as a substring hit.
    expect(hit!.ranges.length).toBe(1);
  });

  it('respects case fidelity on exact substring hits', () => {
    const exact = scoreFuzzy('Git', 'GitPanel')!;
    const loose = scoreFuzzy('git', 'GitPanel')!;
    expect(exact.score).toBeGreaterThan(loose.score);
  });
});

describe('fuzzyRank', () => {
  const targets = ['New Chat', 'Open File', 'Open Settings', 'Toggle Terminal', 'Close Tab', '打开文件'];

  it('orders results best-match-first', () => {
    const ranked = fuzzyRank('open se', targets);
    expect(ranked[0].index).toBe(2); // Open Settings
  });

  it('returns everything for an empty query, in input order', () => {
    const ranked = fuzzyRank('', targets);
    expect(ranked.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('drops non-matching candidates', () => {
    const ranked = fuzzyRank('zzqx', targets);
    expect(ranked).toHaveLength(0);
  });

  it('matches Chinese targets by Chinese query', () => {
    const ranked = fuzzyRank('文件', targets);
    // Both "Open File" (fuzzy latin won't match) and the CJK entry; only the
    // CJK entry contains 文件 as chars.
    expect(ranked.some((r) => targets[r.index] === '打开文件')).toBe(true);
  });

  it('exposes match ranges aligned to target text for highlighting', () => {
    const ranked = fuzzyRank('term', targets);
    const terminal = ranked.find((r) => targets[r.index] === 'Toggle Terminal')!;
    // "Term" appears as a substring inside "Terminal" starting at offset 7.
    expect(terminal.ranges[0][0]).toBe(7);
  });
});

describe('fuzzyRankItems', () => {
  it('factors a static prior into ordering when the query is empty', () => {
    const items = [
      { item: 'rare', key: 'rare cmd', prior: 0.1 },
      { item: 'common', key: 'common cmd', prior: 10 },
    ];
    const ranked = fuzzyRankItems('', items);
    expect(ranked[0].item).toBe('common');
  });

  it('searches the keywords fallback when the primary key misses', () => {
    const items = [
      { item: 'theme', key: 'Cycle Theme', keywords: '主题 深色 浅色 dark light' },
    ];
    const ranked = fuzzyRankItems('深色', items);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].item).toBe('theme');
  });

  it('weights keyword hits below primary hits', () => {
    const items = [
      { item: 'primary', key: '深色模式切换', keywords: '' },
      { item: 'secondary', key: 'Toggle Contrast', keywords: '深色模式' },
    ];
    const ranked = fuzzyRankItems('深色模式', items);
    expect(ranked[0].item).toBe('primary');
    expect(ranked[1].item).toBe('secondary');
  });
});

describe('highlightRanges', () => {
  it('wraps matched spans and leaves gaps unmarked', () => {
    const parts = highlightRanges('Toggle Terminal', [[7, 10]]);
    expect(parts).toEqual([
      { text: 'Toggle ', hit: false },
      { text: 'Term', hit: true },
      { text: 'inal', hit: false },
    ]);
  });

  it('marks the whole string for a full match', () => {
    const parts = highlightRanges('abc', [[0, 2]]);
    expect(parts).toEqual([{ text: 'abc', hit: true }]);
  });

  it('returns a single plain fragment when there are no ranges', () => {
    expect(highlightRanges('abc', [])).toEqual([{ text: 'abc', hit: false }]);
  });
});
