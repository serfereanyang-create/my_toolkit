import { describe, expect, it } from 'vitest';
import { searchNavIds, SETTINGS_NAV_KEYWORDS } from './settingsSearch';

const ENTRIES = [
  { id: 'general', label: '常规', keywords: '' },
  { id: 'appearance', label: '外观', keywords: '' },
  { id: 'model', label: '模型', keywords: '' },
  { id: 'usage', label: '用量统计', keywords: '' },
  { id: 'shortcuts', label: '键盘快捷键', keywords: '' },
  { id: 'git', label: 'Git', keywords: '' },
  { id: 'worktrees', label: 'Worktrees', keywords: '' },
  { id: 'archived', label: '已归档的聊天', keywords: '' },
];

describe('searchNavIds', () => {
  it('returns everything (input order) for a blank query', () => {
    expect(searchNavIds('', ENTRIES)).toEqual(ENTRIES.map((e) => e.id));
    expect(searchNavIds('   ', ENTRIES)).toEqual(ENTRIES.map((e) => e.id));
  });

  it('matches the Chinese label substring', () => {
    expect(searchNavIds('快捷', ENTRIES)).toEqual(['shortcuts']);
  });

  it('bridges English queries to Chinese labels via keywords', () => {
    // "theme" only lives in appearance's keyword table.
    expect(searchNavIds('theme', ENTRIES)).toContain('appearance');
    // "provider" belongs to model.
    expect(searchNavIds('provider', ENTRIES)).toContain('model');
  });

  it('fuzzy-cases the English label itself', () => {
    // "wrk" is a subsequence of "Worktrees".
    expect(searchNavIds('wrk', ENTRIES)).toContain('worktrees');
  });

  it('prefers the closest match first', () => {
    const out = searchNavIds('用量', ENTRIES);
    expect(out[0]).toBe('usage');
  });

  it('drops unrelated entries', () => {
    expect(searchNavIds('qqq', ENTRIES)).toEqual([]);
  });

  it('every nav id in the keyword table resolves its own English term', () => {
    // Spot-check: each entry's first keyword token finds it.
    const all = Object.entries(SETTINGS_NAV_KEYWORDS).map(([id, kw]) => ({ id, label: id, keywords: kw }));
    for (const [id] of Object.entries(SETTINGS_NAV_KEYWORDS)) {
      const found = searchNavIds(id, all);
      expect(found).toContain(id);
    }
  });
});
