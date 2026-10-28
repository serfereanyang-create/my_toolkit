import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MarkdownStreamCleaner, stripMarkdownDecorations } from '../src/ui/markdown.js';
import { TerminalUI } from '../src/ui/terminal.js';
import { markdownToHtml, markdownOutlineTool, markdownToHtmlTool, markdownLinksTool, markdownCodeBlocksTool } from '../src/tools/markdown.js';

test('stripMarkdownDecorations removes bold and headings', () => {
  assert.equal(stripMarkdownDecorations('**粗体** 和 ## 标题'), '粗体 和 标题');
  assert.equal(stripMarkdownDecorations('## Hello\n**world**'), 'Hello\nworld');
  assert.equal(stripMarkdownDecorations('no markdown'), 'no markdown');
  assert.doesNotMatch(stripMarkdownDecorations('### 小节 **x**'), /\*\*|##/);
  const sample = [
    '## 一句话',
    '**现在是“能跑的 MVP”**',
    '### A. 测试覆盖层',
    '| 目标 | 完成度 |',
    '|---|---:|',
    '| demo | **70–80%** |',
  ].join('\n');
  const cleaned = stripMarkdownDecorations(sample);
  assert.doesNotMatch(cleaned, /\*\*/);
  assert.doesNotMatch(cleaned, /##/);
  assert.match(cleaned, /一句话/);
  assert.match(cleaned, /70–80%/);
});

test('MarkdownStreamCleaner strips across chunk boundaries', () => {
  const cleaner = new MarkdownStreamCleaner();
  const a = cleaner.push('这是 **重');
  const b = cleaner.push('点** 内容');
  const c = cleaner.flush();
  const joined = `${a}${b}${c}`;
  assert.match(joined, /这是 重点 内容/);
  assert.doesNotMatch(joined, /\*\*/);
});

test('TerminalUI assistant output drops markdown decorations', () => {
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    const ui = new TerminalUI({ noColor: true });
    ui.assistant('## 结果\n**完成**了');
    assert.match(output, /结果/);
    assert.match(output, /完成了/);
    assert.doesNotMatch(output, /\*\*/);
    assert.doesNotMatch(output, /##/);
  } finally {
    process.stdout.write = originalWrite;
  }
});

// ---------------------------------------------------------------------------
// markdown tools: footnotes, task lists, headings inside blockquotes
// ---------------------------------------------------------------------------

const toolContext = { workspaceRoot: process.cwd(), approval: 'auto' as const };

async function outlineOf(markdown: string) {
  const result = await markdownOutlineTool.execute(markdownOutlineTool.validate({ markdown }), toolContext);
  return result.data as {
    headings: Array<{ level: number; text: string; line: number; inQuote?: boolean }>;
    tasks: Array<{ text: string; checked: boolean; line: number }>;
  };
}

async function htmlToolData(markdown: string) {
  const result = await markdownToHtmlTool.execute(
    markdownToHtmlTool.validate({ markdown, maxBytes: 1_000_000 }),
    toolContext,
  );
  return {
    output: result.output,
    data: result.data as {
      footnotes: {
        defined: Array<{ label: string; number: number; text: string; line: number; referenced: boolean }>;
        undefined: Array<{ label: string; line: number }>;
        hasUndefined: boolean;
      };
    },
  };
}

test('footnote reference renders as sup with an id and an anchor', () => {
  const html = markdownToHtml('Text[^1] here.\n\n[^1]: The note.');
  assert.match(html, /<sup id="fnref:1"><a href="#fn:1">1<\/a><\/sup>/);
  assert.match(html, /<section class="footnotes">/);
  assert.match(html, /<li id="fn:1"><p>The note\./);
  assert.match(html, /class="footnote-backref"/);
});

test('footnotes are numbered by definition order, not reference order', () => {
  const html = markdownToHtml('First[^b], second[^a].\n\n[^a]: Note A\n[^b]: Note B');
  // Reference order is b, a; definition order is a, b — the number must follow
  // the definition, so b → 2 and a → 1.
  assert.match(html, /First<sup id="fnref:2"><a href="#fn:2">2<\/a><\/sup>/);
  assert.match(html, /second<sup id="fnref:1"><a href="#fn:1">1<\/a><\/sup>/);
  assert.match(html, /<li id="fn:1"><p>Note A/);
  assert.match(html, /<li id="fn:2"><p>Note B/);
});

test('a footnote referenced twice gets unique ids and two backrefs', () => {
  const html = markdownToHtml('A[^1] B[^1].\n\n[^1]: once');
  assert.match(html, /<sup id="fnref:1"><a href="#fn:1">1<\/a><\/sup>/);
  assert.match(html, /<sup id="fnref:1-2"><a href="#fn:1">1<\/a><\/sup>/);
  const backrefs = html.match(/href="#fnref:1(-2)?"/g) ?? [];
  assert.equal(backrefs.length, 2);
});

test('an undefined footnote reference stays literal and is reported', async () => {
  const html = markdownToHtml('See[^9].');
  assert.equal(html, '<p>See[^9].</p>');
  assert.doesNotMatch(html, /footnotes/);

  const { data } = await htmlToolData('See[^9].');
  assert.equal(data.footnotes.hasUndefined, true);
  assert.deepEqual(data.footnotes.undefined, [{ label: '9', line: 1 }]);
  assert.deepEqual(data.footnotes.defined, []);
});

test('defined footnotes are reported in data with their line numbers', async () => {
  const { data } = await htmlToolData('# Doc\n\nBody[^n]\n\n[^n]: the note');
  assert.deepEqual(data.footnotes.defined, [
    { label: 'n', number: 1, text: 'the note', line: 5, referenced: true },
  ]);
  assert.equal(data.footnotes.hasUndefined, false);
});

test('an orphan definition is dropped from HTML but stays visible in data', async () => {
  const html = markdownToHtml('Body only.\n\n[^orphan]: never referenced');
  assert.doesNotMatch(html, /footnotes/);
  assert.doesNotMatch(html, /never referenced/);
  const { data } = await htmlToolData('Body only.\n\n[^orphan]: never referenced');
  assert.equal(data.footnotes.defined.length, 1);
  assert.equal(data.footnotes.defined[0].referenced, false);
});

test('a footnote definition inside a fenced code block is just code', () => {
  const html = markdownToHtml('```\n[^1]: not a definition\n```');
  assert.match(html, /<pre><code>[\s\S]*\[\^1\]: not a definition/);
  assert.doesNotMatch(html, /class="footnotes"/);
});

test('a footnote reference inside inline code is not converted', () => {
  const html = markdownToHtml('Use `[^1]` here.\n\n[^1]: real note');
  assert.match(html, /<code>\[\^1\]<\/code>/);
  assert.doesNotMatch(html, /<sup/);
  assert.doesNotMatch(html, /class="footnotes"/);
});

test('a footnote definition inside a blockquote is still a definition', () => {
  const html = markdownToHtml('> [^q]: quoted note\n\nBody[^q]');
  assert.match(html, /Body<sup id="fnref:1"><a href="#fn:1">1<\/a><\/sup>/);
  assert.match(html, /<li id="fn:1"><p>quoted note/);
  assert.doesNotMatch(html, /<blockquote>\[/);
});

test('a quoted footnote definition folds its quoted continuation lines too', async () => {
  const { data } = await htmlToolData('> [^q]: first\n>     second\n\nBody[^q]');
  assert.equal(data.footnotes.defined[0].text, 'first second');
});

test('an unclosed fence swallows a would-be footnote definition', () => {
  const html = markdownToHtml('```js\nconst x = 1;\n[^1]: swallowed');
  assert.match(html, /<pre><code class="language-js">/);
  assert.match(html, /\[\^1\]: swallowed/);
  assert.doesNotMatch(html, /class="footnotes"/);
});

test('footnotes never appear in the heading outline', async () => {
  const { headings } = await outlineOf('# Title\n\nBody[^1]\n\n[^1]: a note with no heading');
  assert.deepEqual(headings.map((h) => h.text), ['Title']);
});

test('task list items render disabled checkboxes with the right state', () => {
  const html = markdownToHtml('- [ ] todo\n- [x] done\n- [X] also done\n- plain');
  assert.match(html, /<li><input type="checkbox" disabled> todo<\/li>/);
  assert.match(html, /<li><input type="checkbox" disabled checked> done<\/li>/);
  assert.match(html, /<li><input type="checkbox" disabled checked> also done<\/li>/);
  assert.match(html, /<li>plain<\/li>/);
});

test('a checkbox-like marker later in the line stays literal text', () => {
  const html = markdownToHtml('- see [x] in the middle');
  assert.match(html, /<li>see \[x\] in the middle<\/li>/);
  assert.doesNotMatch(html, /checkbox/);
});

test('task list syntax inside a code fence is not a checkbox', () => {
  const html = markdownToHtml('```\n- [ ] not a task\n```');
  assert.doesNotMatch(html, /checkbox/);
});

test('a task list allows no text after the marker', () => {
  const html = markdownToHtml('- [x]');
  assert.match(html, /<li><input type="checkbox" disabled checked><\/li>/);
});

test('outline reports task items with text, checked, and line', async () => {
  const { tasks } = await outlineOf('# T\n\n- [ ] first\n- [x] second\n\n1. not a task');
  assert.deepEqual(tasks, [
    { text: 'first', checked: false, line: 3 },
    { text: 'second', checked: true, line: 4 },
  ]);
});

test('outline does not report task syntax inside code fences', async () => {
  const { tasks } = await outlineOf('```\n- [ ] nope\n```');
  assert.deepEqual(tasks, []);
});

test('a heading inside a blockquote renders as a real heading element', () => {
  const html = markdownToHtml('> ## Quoted\n> body');
  assert.match(html, /^<blockquote><h2>Quoted<\/h2>/);
  assert.match(html, /<p>body<\/p>/);
  assert.match(html, /<\/blockquote>$/);
});

test('a heading inside nested blockquotes nests the elements', () => {
  const html = markdownToHtml('> > ### Deep');
  assert.equal(html, '<blockquote><blockquote><h3>Deep</h3></blockquote></blockquote>');
});

test('outline includes quoted headings at their own level and marks inQuote', async () => {
  const { headings } = await outlineOf('# Top\n\n> ## Quoted\n> > ### Deep');
  assert.deepEqual(headings, [
    { level: 1, text: 'Top', line: 1 },
    { level: 2, text: 'Quoted', line: 3, inQuote: true },
    { level: 3, text: 'Deep', line: 4, inQuote: true },
  ]);
});

test('outline ignores a heading inside a fenced code block', async () => {
  const { headings } = await outlineOf('# Real\n\n```\n# fake\n```');
  assert.deepEqual(headings.map((h) => h.text), ['Real']);
});

test('outline ignores a heading inside a fence that lives in a blockquote', async () => {
  const { headings } = await outlineOf('> ```\n> # fake\n> ```\n# real');
  assert.deepEqual(headings, [{ level: 1, text: 'real', line: 4 }]);
});

test('a plain blockquote keeps the inline shape; structured content uses blocks', () => {
  assert.equal(markdownToHtml('> quote'), '<blockquote>quote</blockquote>');
  assert.equal(markdownToHtml('> a\n\n> b'), '<blockquote>a</blockquote>\n\n<blockquote>b</blockquote>');
  assert.match(markdownToHtml('> quote\n> more'), /^<blockquote><p>quote<\/p>\n<p>more<\/p><\/blockquote>$/);
});

test('blockquote with an inline code span still parses inline markup', () => {
  const html = markdownToHtml('> use `x` and **y**');
  assert.equal(html, '<blockquote>use <code>x</code> and <strong>y</strong></blockquote>');
});

// ---------------------------------------------------------------------------
// gap cases: backslash escapes, footnote continuation, bullet markers,
// ordered task items, numbering, HTML escaping, quoted fences
// ---------------------------------------------------------------------------

async function linksOf(markdown: string) {
  const result = await markdownLinksTool.execute(
    markdownLinksTool.validate({ markdown, includeImages: true }),
    toolContext,
  );
  return result.data as { links: Array<{ text: string; url: string; type: string; line: number }> };
}

async function codeBlocksOf(markdown: string) {
  const result = await markdownCodeBlocksTool.execute(markdownCodeBlocksTool.validate({ markdown }), toolContext);
  return result.data as {
    codeBlocks: Array<{ language: string; content: string; lineStart: number; lineEnd: number }>;
  };
}

test('a backslash escape keeps the punctuation literal instead of making markup', () => {
  assert.equal(markdownToHtml('\\*not italic\\*'), '<p>*not italic*</p>');
  assert.equal(markdownToHtml('\\_not italic\\_'), '<p>_not italic_</p>');
  assert.equal(markdownToHtml('\\[not a link\\](x)'), '<p>[not a link](x)</p>');
  assert.equal(markdownToHtml('\\`not code\\`'), '<p>`not code`</p>');
  // An escaped backslash is one literal backslash, and does not escape the
  // asterisk that follows it.
  assert.equal(markdownToHtml('\\\\ and \\\\*'), '<p>\\ and \\*</p>');
});

test('an escaped character survives inside other inline constructs', () => {
  assert.equal(markdownToHtml('**a\\*b**'), '<p><strong>a*b</strong></p>');
  assert.equal(markdownToHtml('[l\\_x](http://a)'), '<p><a href="http://a">l_x</a></p>');
  assert.equal(markdownToHtml('- [ ] a \\* b'), '<ul>\n<li><input type="checkbox" disabled> a * b</li>\n</ul>');
});

test('backslashes inside a code span stay literal', () => {
  assert.equal(markdownToHtml('`a\\*b`'), '<p><code>a\\*b</code></p>');
});

test('an escaped heading marker is not a heading but a paragraph', async () => {
  assert.equal(markdownToHtml('\\# not a heading'), '<p># not a heading</p>');
  const { headings } = await outlineOf('# real');
  assert.deepEqual(headings.map((h) => h.text), ['real']);
});

test('a footnote definition folds continuation lines indented by four spaces', async () => {
  const html = markdownToHtml('A[^1]\n\n[^1]: one\n    two\n\tthree\n\nplain para');
  assert.match(html, /<li id="fn:1"><p>one two three /);
  // The continuation lines must not survive as stray paragraphs.
  assert.doesNotMatch(html, /<p>two<\/p>/);
  assert.match(html, /<p>plain para<\/p>/);

  const { data } = await htmlToolData('A[^1]\n\n[^1]: one\n    two');
  assert.equal(data.footnotes.defined[0].text, 'one two');
});

test('a blank line ends a footnote definition', async () => {
  const { data } = await htmlToolData('A[^1]\n\n[^1]: one\n\n    not a continuation');
  assert.equal(data.footnotes.defined[0].text, 'one');
});

test('a definition indented by up to three spaces is still a definition', () => {
  const html = markdownToHtml('A[^1]\n\n  [^1]: indented def');
  assert.match(html, /<li id="fn:1"><p>indented def/);
  assert.doesNotMatch(html, /\[\^1\]:/);
});

test('a definition indented by four spaces is indented code, not a definition', async () => {
  const html = markdownToHtml('A[^1]\n\n    [^1]: indented code');
  assert.match(html, /\[\^1\]: indented code/);
  assert.doesNotMatch(html, /class="footnotes"/);
  const { data } = await htmlToolData('A[^1]\n\n    [^1]: indented code');
  assert.deepEqual(data.footnotes.defined, []);
  assert.equal(data.footnotes.hasUndefined, true);
});

test('footnote numbering skips definitions nobody references', async () => {
  // The orphan is defined first; it must not burn number 1.
  const html = markdownToHtml('A[^b]\n\n[^a]: orphan\n[^b]: used');
  assert.match(html, /<sup id="fnref:1"><a href="#fn:1">1<\/a><\/sup>/);
  assert.match(html, /<li id="fn:1"><p>used/);
  assert.doesNotMatch(html, /fn:2/);
  assert.doesNotMatch(html, /orphan/);

  const { data } = await htmlToolData('A[^b]\n\n[^a]: orphan\n[^b]: used');
  assert.deepEqual(
    data.footnotes.defined.map((d) => ({ label: d.label, number: d.number, referenced: d.referenced })),
    [
      { label: 'a', number: 0, referenced: false },
      { label: 'b', number: 1, referenced: true },
    ],
  );
});

test('a footnote referenced only inside a code span does not get a number', () => {
  // The pre-scan sees the label, the real render does not: the second pass must
  // correct the numbering instead of emitting a gap.
  const html = markdownToHtml('Use `[^1]` here[^2].\n\n[^1]: hidden\n[^2]: shown');
  assert.match(html, /<sup id="fnref:1"><a href="#fn:1">1<\/a><\/sup>/);
  assert.match(html, /<li id="fn:1"><p>shown/);
  assert.doesNotMatch(html, /hidden/);
  assert.doesNotMatch(html, /fn:2/);
});

test('the same undefined reference is reported once per line', async () => {
  const sameLine = await htmlToolData('X[^9] Y[^9]');
  assert.deepEqual(sameLine.data.footnotes.undefined, [{ label: '9', line: 1 }]);
  const twoLines = await htmlToolData('X[^9]\nY[^9]');
  assert.equal(twoLines.data.footnotes.undefined.length, 2);
});

test('literal text is HTML-escaped, so markdown cannot inject tags', () => {
  assert.equal(markdownToHtml('a < b & c > d'), '<p>a &lt; b &amp; c &gt; d</p>');
  assert.equal(markdownToHtml('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(markdownToHtml('> a < b'), '<blockquote>a &lt; b</blockquote>');
  assert.equal(markdownToHtml('- [ ] a < b'), '<ul>\n<li><input type="checkbox" disabled> a &lt; b</li>\n</ul>');
  assert.match(markdownToHtml('A[^1]\n\n[^1]: x < y'), /<li id="fn:1"><p>x &lt; y/);
});

test('an underscore in a URL is not emphasis and the href stays intact', () => {
  assert.equal(markdownToHtml('[t](http://x/a_b_c)'), '<p><a href="http://x/a_b_c">t</a></p>');
  assert.equal(markdownToHtml('![a_b](i.png)'), '<p><img src="i.png" alt="a_b" /></p>');
});

test('all three bullet markers start an unordered list', () => {
  const html = markdownToHtml('+ one\n* two\n- three');
  assert.equal(html, '<ul>\n<li>one</li>\n<li>two</li>\n<li>three</li>\n</ul>');
  assert.match(markdownToHtml('+ [x] task'), /<li><input type="checkbox" disabled checked> task<\/li>/);
});

test('a checkbox inside a blockquote renders a list inside the quote', () => {
  const html = markdownToHtml('> - [x] done\n> - [ ] todo');
  assert.match(html, /^<blockquote><ul>\n<li><input type="checkbox" disabled checked> done<\/li>\n<li><input type="checkbox" disabled> todo<\/li>\n<\/ul><\/blockquote>$/);
});

test('a footnote reference inside a blockquote task item resolves', () => {
  const html = markdownToHtml('> - [x] done[^1]\n\n[^1]: note');
  assert.match(html, /<li><input type="checkbox" disabled checked> done<sup id="fnref:1">/);
  assert.match(html, /<li id="fn:1"><p>note/);
});

test('a footnote reference in a table row renders, though tables are not supported', () => {
  const html = markdownToHtml('| a[^1] | b |\n|---|---|\n\n[^1]: note');
  assert.match(html, /<p>\| a<sup id="fnref:1"><a href="#fn:1">1<\/a><\/sup> \| b \|<\/p>/);
  assert.match(html, /<li id="fn:1"><p>note/);
});

test('outline reports ordered task items like the HTML renderer does', async () => {
  const { tasks } = await outlineOf('1. [ ] first\n2. [x] second\n+ [ ] third');
  assert.deepEqual(tasks, [
    { text: 'first', checked: false, line: 1 },
    { text: 'second', checked: true, line: 2 },
    { text: 'third', checked: false, line: 3 },
  ]);
});

test('outline only reports a task when the HTML renderer draws a checkbox', async () => {
  // No space after the marker: renderListItem keeps it as plain list text.
  assert.doesNotMatch(markdownToHtml('- [x]no-space'), /checkbox/);
  const { tasks } = await outlineOf('- [x]no-space');
  assert.deepEqual(tasks, []);
});

test('outline marks task items inside a blockquote', async () => {
  const { tasks } = await outlineOf('> - [x] quoted\n- [ ] top');
  assert.deepEqual(tasks, [
    { text: 'quoted', checked: true, line: 1, inQuote: true },
    { text: 'top', checked: false, line: 2 },
  ]);
});

test('a footnote definition right after a quoted fence is still collected', async () => {
  // The quoted fence ends with its quote, so the next line must be examined
  // instead of being swallowed as fence content.
  const html = markdownToHtml('> ```\n> code\n> ```\n[^1]: def\n\nBody[^1]');
  assert.match(html, /<li id="fn:1"><p>def/);
});

test('a footnote definition inside a quoted fence is code, not a definition', async () => {
  const { data } = await htmlToolData('> ```\n> [^1]: x\n> ```\n\nBody[^1]');
  assert.deepEqual(data.footnotes.defined, []);
  assert.equal(data.footnotes.hasUndefined, true);
});

test('outline finds headings and tasks on the line after a quoted fence', async () => {
  const { headings, tasks } = await outlineOf('> ```\n> x\n> ```\n# real\n- [ ] task');
  assert.deepEqual(headings, [{ level: 1, text: 'real', line: 4 }]);
  assert.deepEqual(tasks, [{ text: 'task', checked: false, line: 5 }]);
});

test('code blocks inside a blockquote are extracted without the quote prefix', async () => {
  const { codeBlocks } = await codeBlocksOf('```js\na\n```\n\n> ```py\n> b\n> c\n> ```\n');
  assert.deepEqual(codeBlocks, [
    { language: 'js', content: 'a', lineStart: 1, lineEnd: 3 },
    { language: 'py', content: 'b\nc', lineStart: 5, lineEnd: 8 },
  ]);
});

test('an unterminated fence still yields its code block', async () => {
  const { codeBlocks } = await codeBlocksOf('```js\nconst a = 1;');
  assert.deepEqual(codeBlocks, [{ language: 'js', content: 'const a = 1;', lineStart: 1, lineEnd: 2 }]);
});

test('links inside a fenced block in a blockquote are not reported', async () => {
  const inFence = await linksOf('> ```\n> [a](b)\n> ```');
  assert.deepEqual(inFence.links, []);
  const ordinary = await linksOf('> [a](b)');
  assert.deepEqual(ordinary.links, [{ text: 'a', url: 'b', type: 'link', line: 1 }]);
});

test('no stray newline run separates the body from the footnote section', () => {
  const html = markdownToHtml('Body[^1]\n\n[^1]: note\n\n\n');
  assert.equal(html.split('<section')[0], '<p>Body<sup id="fnref:1"><a href="#fn:1">1</a></sup></p>\n');
});

test('a definition inside a nested blockquote leaves no leading newline behind', () => {
  const html = markdownToHtml('> > [^1]: note\n\nBody[^1]');
  assert.match(html, /^<p>Body<sup id="fnref:1">/);
});

test('footnote references and checkboxes work at a nested quote depth', () => {
  assert.match(markdownToHtml('> > Body[^1]\n\n[^1]: note'), /^<blockquote><blockquote>Body<sup id="fnref:1">/);
  assert.equal(
    markdownToHtml('> > - [x] deep'),
    '<blockquote><blockquote><ul>\n<li><input type="checkbox" disabled checked> deep</li>\n</ul></blockquote></blockquote>',
  );
});

test('a footnote reference inside emphasis or a heading still resolves', () => {
  assert.match(markdownToHtml('**bold[^1]**\n\n[^1]: note'), /^<p><strong>bold<sup id="fnref:1">/);
  assert.match(markdownToHtml('# Title[^1]\n\n[^1]: note'), /^<h1>Title<sup id="fnref:1">/);
});
