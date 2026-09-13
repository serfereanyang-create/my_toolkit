import { describe, expect, it } from 'vitest';
import { extractOutline, filterOutline, slugifyHeading, walkOutline } from './markdownOutline';

describe('slugifyHeading', () => {
  it('lowercases, strips punctuation and hyphenates spaces', () => {
    expect(slugifyHeading('Hello, World!')).toBe('hello-world');
    expect(slugifyHeading('  Spaced   Out  ')).toBe('spaced-out');
  });

  it('keeps CJK characters and digits', () => {
    expect(slugifyHeading('第 2 章 测试')).toBe('第-2-章-测试');
  });

  it('keeps hyphens but collapses runs', () => {
    expect(slugifyHeading('a - b')).toBe('a---b'.replace(/-+/g, '-'));
    expect(slugifyHeading('snake_case')).toBe('snake_case');
  });

  it('returns empty for punctuation-only headings', () => {
    expect(slugifyHeading('!!!')).toBe('');
  });
});

describe('extractOutline', () => {
  it('returns nothing for empty or heading-free documents', () => {
    expect(extractOutline('')).toMatchObject({ total: 0, entries: [] });
    const plain = extractOutline('just some text\nmore text\n');
    expect(plain.total).toBe(0);
  });

  it('detects ATX headings with levels and slugs', () => {
    const o = extractOutline('# One\n\ntext\n## Two\n### Three\n');
    expect(o.total).toBe(3);
    expect(o.deepest).toBe(3);
    const first = o.entries[0];
    expect(first).toMatchObject({ level: 1, text: 'One', line: 1, id: 'one' });
    expect(first.children[0]).toMatchObject({ level: 2, text: 'Two', id: 'two' });
  });

  it('requires a space after the hashes', () => {
    expect(extractOutline('#Not-ATX\n').total).toBe(0);
    expect(extractOutline('## Real\n').total).toBe(1);
  });

  it('ignores headings inside fenced code blocks', () => {
    const md = [
      '# real',
      '```',
      '# not a heading',
      '~~~',
      '### neither',
      '```',
      '## after fence',
    ].join('\n');
    const o = extractOutline(md);
    expect(o.total).toBe(2);
    expect(o.entries[0].text).toBe('real');
    expect(o.entries[0].children[0].text).toBe('after fence');
  });

  it('strips trailing closing hashes', () => {
    const o = extractOutline('# Closed heading #\n');
    expect(o.entries[0].text).toBe('Closed heading');
  });

  it('handles setext headings', () => {
    const o = extractOutline('Top Title\n=========\n\nSecond\n------\n');
    expect(o.total).toBe(2);
    expect(o.entries[0]).toMatchObject({ level: 1, text: 'Top Title' });
    // Second is level 2, so it nests under the level-1 heading.
    expect(o.entries[0].children[0]).toMatchObject({ level: 2, text: 'Second' });
  });

  it('does not treat list bullets as setext dashes', () => {
    const md = '- one\n---\ntext';
    // "- one" is a bullet; the following "---" is a thematic break.
    const o = extractOutline(md);
    expect(o.total).toBe(0);
  });

  it('deduplicates slugs with -1, -2 suffixes', () => {
    const o = extractOutline('# Item\n\n# Item\n\n# Item\n');
    expect(o.entries.map((e) => e.id)).toEqual(['item', 'item-1', 'item-2']);
  });

  it('nests by level and promotes orphans to roots', () => {
    const o = extractOutline('### deep first\n#### deeper\n## then shallower\n');
    expect(o.entries).toHaveLength(2); // ### and ## are both roots-ish
    expect(o.entries[0].children[0].text).toBe('deeper');
  });

  it('strips inline markdown from display text', () => {
    const o = extractOutline('# `code` and **bold** and [link](http://x)\n');
    expect(o.entries[0].text).toBe('code and bold and link');
  });
});

describe('filterOutline', () => {
  const o = extractOutline('# Alpha\n## Beta\n### Gamma\n## Delta\n# Epsilon\n');

  it('returns everything for a blank needle', () => {
    expect(filterOutline(o, '').total).toBe(5);
  });

  it('keeps ancestors of matches and drops other branches', () => {
    const out = filterOutline(o, 'gamma');
    expect(out.total).toBe(3); // Alpha > Beta > Gamma chain
    expect(out.entries[0].text).toBe('Alpha');
  });

  it('matches case-insensitively', () => {
    expect(filterOutline(o, 'EPsi').total).toBe(1);
  });

  it('returns an empty outline when nothing matches', () => {
    expect(filterOutline(o, 'zzz-not-here').total).toBe(0);
  });
});

describe('walkOutline', () => {
  it('flattens in document order with depths', () => {
    const o = extractOutline('# a\n## b\n### c\n## d\n# e\n');
    const walked = walkOutline(o).map((x) => `${x.depth}:${x.text}`);
    expect(walked).toEqual(['0:a', '1:b', '2:c', '1:d', '0:e']);
  });
});
