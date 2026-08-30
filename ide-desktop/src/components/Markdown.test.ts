import { describe, expect, it } from 'vitest';
import { parseBlocks } from './Markdown';

describe('parseBlocks', () => {
  it('parses fenced code blocks with a language tag', () => {
    const blocks = parseBlocks('```ts\nconst x = 1;\n```');
    expect(blocks).toEqual([{ kind: 'code', lang: 'ts', text: 'const x = 1;' }]);
  });

  it('parses headings by level', () => {
    const blocks = parseBlocks('## Title');
    expect(blocks).toEqual([{ kind: 'heading', level: 2, text: 'Title' }]);
  });

  it('parses unordered and ordered lists', () => {
    const ul = parseBlocks('- one\n- two');
    expect(ul).toEqual([{ kind: 'ul', items: ['one', 'two'] }]);
    const ol = parseBlocks('1. first\n2. second');
    expect(ol).toEqual([{ kind: 'ol', items: ['first', 'second'] }]);
  });

  it('gathers consecutive lines into a paragraph', () => {
    const blocks = parseBlocks('hello\nworld');
    expect(blocks).toEqual([{ kind: 'p', text: 'hello world' }]);
  });

  it('does not treat text inside a code block as markdown structure', () => {
    const blocks = parseBlocks('```\n# not a heading\n- not a list\n```');
    expect(blocks).toEqual([{ kind: 'code', lang: '', text: '# not a heading\n- not a list' }]);
  });

  it('separates blocks across blank lines', () => {
    const blocks = parseBlocks('# Head\n\npara text\n\n- item');
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, text: 'Head' },
      { kind: 'p', text: 'para text' },
      { kind: 'ul', items: ['item'] },
    ]);
  });
});
