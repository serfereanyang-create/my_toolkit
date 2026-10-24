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

  it('keeps a still-streaming unclosed fence as code', () => {
    // Mid-stream the closing fence has not arrived yet. Treating the body as a
    // paragraph joined its lines with spaces, so partial code read as one run
    // of prose until the fence closed.
    const blocks = parseBlocks('排序如下：\n\n```python\ndef part(a, lo, hi):\n    return lo');
    expect(blocks).toEqual([
      { kind: 'p', text: '排序如下：' },
      { kind: 'code', lang: 'python', text: 'def part(a, lo, hi):\n    return lo' },
    ]);
  });
});

describe('column-aligned and tabular output', () => {
  it('keeps the line breaks of a space-aligned table', () => {
    // Straight from a real run: asked for the five largest TypeScript files,
    // the model answered with a space-padded block. Joining those lines into a
    // paragraph collapsed every column into one run of text.
    const src = [
      'src 目录下 TypeScript 文件按行数排序，前 5 名：',
      '',
      '  行数    文件',
      '  1885    src/agent/agent.ts',
      '  1634    src/cli/commands.ts',
    ].join('\n');
    const blocks = parseBlocks(src);
    const aligned = blocks.find((block) => block.kind === 'p' && block.mono);
    expect(aligned).toBeDefined();
    const lines = (aligned as Extract<(typeof blocks)[number], { kind: 'p' }>).text.split('\n');
    expect(lines).toEqual(['  行数    文件', '  1885    src/agent/agent.ts', '  1634    src/cli/commands.ts']);
  });

  it('still joins ordinary wrapped prose into one paragraph', () => {
    const blocks = parseBlocks('这是一段普通文字，\n但是被模型换行了。');
    expect(blocks).toEqual([{ kind: 'p', text: '这是一段普通文字， 但是被模型换行了。' }]);
  });

  it('parses a GFM table with alignments', () => {
    const blocks = parseBlocks('| 文件 | 行数 |\n| --- | ---: |\n| a.ts | 12 |\n| b.ts | 7 |');
    expect(blocks).toEqual([{
      kind: 'table',
      header: ['文件', '行数'],
      align: [null, 'right'],
      rows: [['a.ts', '12'], ['b.ts', '7']],
    }]);
  });

  it('pads short table rows to the header width', () => {
    const blocks = parseBlocks('| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |');
    const table = blocks[0] as Extract<(typeof blocks)[number], { kind: 'table' }>;
    expect(table.rows[0]).toEqual(['1', '2', '']);
  });

  it('interprets a loose list split by blank lines as one list', () => {
    // Models commonly put a blank line between bullets. Parsing each bullet as
    // its own block rendered four separate lists, each numbered from 1.
    const blocks = parseBlocks('1. first\n\n2. second\n\n- a\n\n- b');
    expect(blocks).toEqual([
      { kind: 'ol', items: ['first', 'second'] },
      { kind: 'ul', items: ['a', 'b'] },
    ]);
  });

  it('keeps a list starting at a number other than one', () => {
    const blocks = parseBlocks('3. third\n4. fourth');
    expect(blocks).toEqual([{ kind: 'ol', items: ['third', 'fourth'], start: 3 }]);
  });

  it('does not merge a list into a following paragraph across a blank line', () => {
    const blocks = parseBlocks('- item\n\n普通段落');
    expect(blocks).toEqual([{ kind: 'ul', items: ['item'] }, { kind: 'p', text: '普通段落' }]);
  });

  it('does not treat a lone pipe in prose as a table', () => {
    const blocks = parseBlocks('用 a | b 表示或。\n下一行普通文字。');
    expect(blocks[0].kind).toBe('p');
  });
});
