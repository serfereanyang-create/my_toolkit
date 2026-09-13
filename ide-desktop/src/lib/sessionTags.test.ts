import { describe, expect, it } from 'vitest';
import {
  normalizeTag, parseTagInput, tagCloud, sessionMatchesTag, tagColorIndex,
  MAX_TAG_LEN, MAX_PER_SESSION,
} from './sessionTags';

describe('normalizeTag', () => {
  it('trims, collapses whitespace, and lowercases', () => {
    expect(normalizeTag('  Bug   Fix ')).toBe('bug fix');
  });
  it('caps length at MAX_TAG_LEN', () => {
    expect(normalizeTag('x'.repeat(40))).toHaveLength(MAX_TAG_LEN);
  });
  it('returns empty string for whitespace input', () => {
    expect(normalizeTag('   ')).toBe('');
  });
});

describe('parseTagInput', () => {
  it('splits on ASCII and full-width commas', () => {
    expect(parseTagInput('a,b，c')).toEqual(['a', 'b', 'c']);
  });
  it('dedupes case-insensitively and caps per session', () => {
    const out = parseTagInput('A, a, b, c, d, e, f, g');
    expect(out).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(out.length).toBe(MAX_PER_SESSION);
  });
  it('drops empty pieces', () => {
    expect(parseTagInput(', ,  ,')).toEqual([]);
  });
});

describe('tagCloud', () => {
  it('counts sessions per tag and orders by usage then alphabetically', () => {
    const map = {
      s1: ['wip', 'bug'],
      s2: ['wip'],
      s3: ['release', 'bug'],
    };
    expect(tagCloud(map)).toEqual([
      { tag: 'bug', count: 2 },
      { tag: 'wip', count: 2 },
      { tag: 'release', count: 1 },
    ]);
  });
  it('handles empty map', () => {
    expect(tagCloud({})).toEqual([]);
  });
});

describe('sessionMatchesTag', () => {
  const map = { s1: ['wip'], s2: [] };
  it('passes everything with a null filter', () => {
    expect(sessionMatchesTag(map, 's2', null)).toBe(true);
  });
  it('requires the tag', () => {
    expect(sessionMatchesTag(map, 's1', 'wip')).toBe(true);
    expect(sessionMatchesTag(map, 's2', 'wip')).toBe(false);
  });
});

describe('tagColorIndex', () => {
  it('is stable and inside palette range', () => {
    expect(tagColorIndex('wip')).toBe(tagColorIndex('wip'));
    for (const tag of ['wip', 'a', 'release', '电子设计']) {
      expect(tagColorIndex(tag)).toBeGreaterThanOrEqual(0);
      expect(tagColorIndex(tag)).toBeLessThan(8);
    }
  });
  it('distinguishes different tags', () => {
    expect(tagColorIndex('alpha')).not.toBe(tagColorIndex('beta'));
  });
});
