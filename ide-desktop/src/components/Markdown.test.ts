import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, parseBlocks } from './Markdown';

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

describe('blockquotes', () => {
  it('parses a single-level quote as a nested block list', () => {
    expect(parseBlocks('> 注意：这一步会清空缓存。')).toEqual([
      { kind: 'quote', blocks: [{ kind: 'p', text: '注意：这一步会清空缓存。' }] },
    ]);
  });

  it('nests quotes and keeps paragraphs, lists and fences inside them', () => {
    const src = [
      '> 外层说明',
      '> > 内层提醒',
      '>',
      '> - 一',
      '> - 二',
      '>',
      '> ```ts',
      '> const x = 1;',
      '> ```',
    ].join('\n');
    expect(parseBlocks(src)).toEqual([{
      kind: 'quote',
      blocks: [
        { kind: 'p', text: '外层说明' },
        { kind: 'quote', blocks: [{ kind: 'p', text: '内层提醒' }] },
        { kind: 'ul', items: ['一', '二'] },
        { kind: 'code', lang: 'ts', text: 'const x = 1;' },
      ],
    }]);
  });

  it('ends the quote at the first unmarked line', () => {
    expect(parseBlocks('> 引用\n普通段落')).toEqual([
      { kind: 'quote', blocks: [{ kind: 'p', text: '引用' }] },
      { kind: 'p', text: '普通段落' },
    ]);
  });

  it('stops nesting at four levels instead of recursing without bound', () => {
    const src = `${'> '.repeat(9)}deep`;
    let depth = 0;
    let blocks = parseBlocks(src);
    while (blocks.length === 1 && blocks[0].kind === 'quote') {
      depth += 1;
      blocks = blocks[0].blocks;
    }
    expect(depth).toBe(4);
    expect(blocks).toEqual([{ kind: 'p', text: `${'> '.repeat(4)}deep` }]);
  });
});

describe('nested lists', () => {
  it('restores two-space nesting', () => {
    expect(parseBlocks('- a\n  - b')).toEqual([{
      kind: 'ul',
      items: [{ text: 'a', children: [{ kind: 'ul', items: ['b'] }] }],
    }]);
  });

  it('restores four-space nesting and tab indentation', () => {
    const four = parseBlocks('- a\n    - b');
    const tab = parseBlocks('- a\n\t- b');
    expect(tab).toEqual(four);
    expect(four).toEqual([{
      kind: 'ul',
      items: [{ text: 'a', children: [{ kind: 'ul', items: ['b'] }] }],
    }]);
  });

  it('keeps three levels and clamps anything deeper onto the third', () => {
    expect(parseBlocks('- a\n  - b\n    - c\n      - d')).toEqual([{
      kind: 'ul',
      items: [{
        text: 'a',
        children: [{
          kind: 'ul',
          items: [{ text: 'b', children: [{ kind: 'ul', items: ['c', 'd'] }] }],
        }],
      }],
    }]);
  });

  it('nests an ordered list under an unordered one and resumes the parent', () => {
    expect(parseBlocks('- a\n  1. b\n  2. c\n- d')).toEqual([{
      kind: 'ul',
      items: [
        { text: 'a', children: [{ kind: 'ol', items: ['b', 'c'] }] },
        'd',
      ],
    }]);
  });

  it('starts a new block when the marker kind changes at the top level', () => {
    expect(parseBlocks('- a\n1. b')).toEqual([
      { kind: 'ul', items: ['a'] },
      { kind: 'ol', items: ['b'] },
    ]);
  });
});

describe('heading levels and markup', () => {
  const sixLevels = '# 一级\n\n## 二级\n\n### 三级\n\n#### 四级\n\n##### 五级\n\n###### 六级';

  it('parses all six source levels', () => {
    expect(parseBlocks(sixLevels).map((block) => (block.kind === 'heading' ? block.level : 0))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('renders six different level classes, keeping the h1/h2 tag shift', () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: sixLevels }));
    for (let level = 1; level <= 6; level += 1) {
      expect(html.match(new RegExp(`class="md-heading md-h${level}"`, 'g'))).toHaveLength(1);
    }
    // h1 lands on <h3> and h2 on <h4> (level + 2, capped at h6); nothing
    // outranks the app's own titles and nothing goes below <h6>.
    expect(html).toMatch(/<h3 id="[^"]*" class="md-heading md-h1"/);
    expect(html).toMatch(/<h4 id="[^"]*" class="md-heading md-h2"/);
    expect(html).not.toMatch(/<h1[ >]/);
    expect(html).not.toMatch(/<h7/);
  });

  it('renders a quote as a md-quote blockquote with its children inside', () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: '> 引用里的 **粗体**' }));
    expect(html).toContain('<blockquote class="md-quote">');
    expect(html).toContain('<strong>粗体</strong>');
  });

  it('renders each nested list level as its own md-list', () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: '- a\n  - b\n    - c' }));
    expect(html.match(/<ul class="md-list">/g)).toHaveLength(3);
    expect(html).toContain('<li>a<ul class="md-list">');
  });
});
