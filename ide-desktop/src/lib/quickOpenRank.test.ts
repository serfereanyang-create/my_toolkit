import { describe, expect, it } from 'vitest';
import { rankQuickFiles, splitQuickPath, nameRanges, QOPEN_RECENCY_HALFLIFE_MS } from './quickOpenRank';

const DAY = 24 * 3600 * 1000;

describe('splitQuickPath', () => {
  it('splits nested posix paths', () => {
    expect(splitQuickPath('src/components/App.tsx')).toEqual({ dir: 'src/components', name: 'App.tsx' });
  });
  it('returns empty dir for bare file', () => {
    expect(splitQuickPath('README.md')).toEqual({ dir: '', name: 'README.md' });
  });
  it('normalises backslashes', () => {
    expect(splitQuickPath('src\\lib\\fuzzy.ts')).toEqual({ dir: 'src/lib', name: 'fuzzy.ts' });
  });
});

describe('rankQuickFiles', () => {
  const now = 1_700_000_000_000;
  const files = [
    { path: 'src/components/App.tsx', mtimeMs: now - 30 * DAY },
    { path: 'src/components/Editor.tsx', mtimeMs: now - DAY },
    { path: 'src/lib/fuzzy.ts', mtimeMs: now - 2 * DAY },
    { path: 'docs/guide.md', mtimeMs: now - 7 * DAY },
  ];

  it('empty query sorts by recency', () => {
    const out = rankQuickFiles(files, '', now);
    expect(out.map((r) => r.file.path)).toEqual([
      'src/components/Editor.tsx',
      'src/lib/fuzzy.ts',
      'docs/guide.md',
      'src/components/App.tsx',
    ]);
  });

  it('empty query produces no ranges', () => {
    const out = rankQuickFiles(files, '   ', now);
    expect(out.every((r) => r.ranges.length === 0)).toBe(true);
  });

  it('matches subsequence across directories', () => {
    const out = rankQuickFiles(files, 'edtr', now);
    expect(out[0]?.file.path).toBe('src/components/Editor.tsx');
  });

  it('filters out non-matching files', () => {
    const out = rankQuickFiles(files, 'zzzz', now);
    expect(out).toEqual([]);
  });

  it('respects limit', () => {
    const out = rankQuickFiles(files, 'e', now, 2);
    expect(out.length).toBe(2);
  });

  it('newer files win on equal fuzzy quality', () => {
    const tie = [
      { path: 'a/x.ts', mtimeMs: now - 60 * DAY },
      { path: 'z/x.ts', mtimeMs: now - DAY },
    ];
    const out = rankQuickFiles(tie, 'x', now);
    expect(out.map((r) => r.file.path)).toEqual(['z/x.ts', 'a/x.ts']);
  });

  it('prior decays with half-life', () => {
    expect(QOPEN_RECENCY_HALFLIFE_MS).toBe(7 * DAY);
  });
});

describe('nameRanges', () => {
  it('drops directory-only ranges and shifts name ranges', () => {
    const out = nameRanges('src/App.tsx', [[0, 3], [4, 7]]);
    // name = "App.tsx" starts at offset 4; range [0,3] is inside dir, [4,7] shifts to [0,3]
    expect(out).toEqual([[0, 3]]);
  });
  it('returns empty list for no matches', () => {
    expect(nameRanges('README.md', [])).toEqual([]);
  });
});
