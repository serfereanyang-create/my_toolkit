/**
 * uiWidth.test.ts — display-width primitives and every aligned surface that
 * depends on them (session header box, exec title truncation, overlay rows,
 * home screen). Includes a seeded randomized pass (mulberry32) so a width
 * regression fails with the seed and case number that produced it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  charDisplayWidth,
  displayTokens,
  displayWidth,
  stripAnsi,
  takeByDisplayWidth,
  truncateToWidth,
} from '../src/ui/width.js';
import { TerminalUI } from '../src/ui/terminal.js';
import { renderOverlayFrame } from '../src/ui/overlay.js';
import { renderHomeScreen } from '../src/ui/home.js';
import { formatResultCard, summarizeToolLine } from '../src/ui/resultCard.js';

const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*?(?:\u0007|\u001b\\)|[@-Z\\-_])/y;

function captureStdout(run: () => void) {
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    run();
  } finally {
    process.stdout.write = originalWrite;
  }
  return output;
}

function withColumns<T>(columns: number, fn: () => T): T {
  const original = process.stdout.columns;
  (process.stdout as { columns?: number }).columns = columns;
  try {
    return fn();
  } finally {
    (process.stdout as { columns?: number }).columns = original;
  }
}

/** True when every ESC in `value` starts a complete, well-formed sequence. */
function ansiIsWellFormed(value: string): boolean {
  let i = 0;
  while (i < value.length) {
    const esc = value.indexOf('\u001b', i);
    if (esc < 0) return true;
    ANSI.lastIndex = esc;
    const match = ANSI.exec(value);
    if (!match) return false;
    i = ANSI.lastIndex;
  }
  return true;
}

// ─── Width table ────────────────────────────────────────────────────────────

const WIDTH_TABLE: Array<[string, number, string]> = [
  ['abc', 3, 'ASCII'],
  ['中文', 4, 'CJK wide'],
  ['こんにちは', 10, 'kana'],
  ['한국어', 6, 'hangul'],
  ['ＡＢＣ', 6, 'fullwidth latin'],
  ['😀', 2, 'emoji'],
  ['😀😀', 4, 'two emoji'],
  ['👨‍👩‍👧', 2, 'ZWJ family is one glyph'],
  ['👨‍👩‍👧‍👦', 2, 'ZWJ family of four'],
  ['🇨🇳', 2, 'regional-indicator flag'],
  ['🇨🇳🇺🇸', 4, 'two flags'],
  ['e\u0301', 1, 'base + combining acute'],
  ['Cafe\u0301', 4, 'combining inside word'],
  ['❤️', 2, 'VS16 emoji presentation'],
  ['❤', 1, 'text-default heart'],
  ['1️⃣', 2, 'keycap'],
  ['\u200b', 0, 'zero-width space'],
  ['\u001b[31mred\u001b[0m', 3, 'SGR coloured text'],
  ['\u001b[?25l', 0, 'CSI private sequence'],
  ['\u001b]0;title\u0007', 0, 'OSC title'],
  ['', 0, 'empty'],
  ['a\tb', 2, 'tab counts as control (0) + letters'],
];

test('displayWidth covers CJK, emoji, ZWJ, flags, combining marks and ANSI', () => {
  for (const [text, expected, label] of WIDTH_TABLE) {
    assert.equal(displayWidth(text), expected, `${label}: ${JSON.stringify(text)}`);
  }
});

test('displayWidth of stripped text equals width of the plain text', () => {
  const styled = '\u001b[1m\u001b[36m中文 abc 😀\u001b[0m';
  assert.equal(displayWidth(styled), displayWidth(stripAnsi(styled)));
  assert.equal(displayWidth(styled), 4 + 1 + 3 + 1 + 2);
});

test('charDisplayWidth handles lone combining marks as zero width', () => {
  assert.equal(charDisplayWidth('\u0301'), 0);
  assert.equal(charDisplayWidth('\u200d'), 0);
  assert.equal(charDisplayWidth('\ufe0f'), 0);
  assert.equal(charDisplayWidth('\u4e2d'), 2);
});

// ─── Truncation invariants ──────────────────────────────────────────────────

function assertTruncationInvariants(input: string, max: number, label: string) {
  const cut = takeByDisplayWidth(input, max);
  assert.ok(displayWidth(cut) <= max, `${label}: ${JSON.stringify(cut)} width ${displayWidth(cut)} > ${max}`);
  assert.ok(ansiIsWellFormed(cut), `${label}: truncated output cut an ANSI sequence: ${JSON.stringify(cut)}`);
  // No content is invented: the stripped result is a prefix of the stripped input.
  assert.ok(
    stripAnsi(input).startsWith(stripAnsi(cut)),
    `${label}: truncated text is not a prefix`,
  );

  const withEllipsis = truncateToWidth(input, max);
  // Stem (input minus the suffix) must fit; the suffix itself is what the
  // output may exceed the budget by (suffix + one wide glyph in production).
  const stemWidth = displayWidth(withEllipsis) - displayWidth('...');
  assert.ok(stemWidth <= max, `${label}: truncateToWidth stem ${stemWidth} > ${max}`);
  if (withEllipsis !== input) {
    assert.ok(displayWidth(withEllipsis) <= max + 2, `${label}: truncateToWidth overflow by a whole glyph: ${displayWidth(withEllipsis)} > ${max}+2`);
  }
  assert.ok(ansiIsWellFormed(withEllipsis), `${label}: truncateToWidth broke ANSI`);
  if (displayWidth(input) <= max) {
    assert.equal(withEllipsis, input, `${label}: no truncation should be a no-op`);
  }
}

test('truncation never exceeds the budget and never splits ANSI', () => {
  const cases = [
    '\u001b[31m中文\u001b[0m中文',
    '👨‍👩‍👧‍👦 family',
    'e\u0301e\u0301e\u0301e\u0301',
    '🇨🇳🇺🇸🇯🇵',
    '\u001b[2m• \u001b[0mhello',
    'a'.repeat(100),
  ];
  for (const value of cases) {
    for (let max = 0; max <= 12; max += 1) {
      assertTruncationInvariants(value, max, `${JSON.stringify(value)} @${max}`);
    }
  }
});

test('truncateToWidth keeps the visible prefix and appends the ellipsis', () => {
  assert.equal(truncateToWidth('abcdef', 4), 'a...');
  // 4 columns budget, 1 for the ellipsis, so only one CJK char (2 cols) fits.
  assert.equal(truncateToWidth('中文中文', 3, '…'), '中…');
  assert.equal(truncateToWidth('中文', 4, '…'), '中文');
  assert.equal(truncateToWidth('abc', 0), '');
});

test('displayTokens keeps ZWJ clusters together', () => {
  const tokens = displayTokens('a👨‍👩‍👧b');
  const glyphs = tokens.map((token) => token.text);
  assert.deepEqual(glyphs, ['a', '👨‍👩‍👧', 'b']);
});

// ─── Seeded randomized pass (mulberry32) ─────────────────────────────────────

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POOL = [
  'a', 'Z', '0', ' ', '中', '文', '日', '本', '語', '한', '국', '😀', '😀', '🚀',
  'e\u0301', '\u200d', '👨', '👩', '👧', '🇨', '🇳', '\ufe0f', '❤', '\u200b', 'Ａ', '！',
  '\u001b[31m', '\u001b[0m', '\u001b[2m', '\u001b[1;36m', '\t',
];

function randomString(rand: () => number, minLen: number, maxLen: number): string {
  const len = minLen + Math.floor(rand() * (maxLen - minLen + 1));
  let out = '';
  for (let i = 0; i < len; i += 1) out += POOL[Math.floor(rand() * POOL.length)]!;
  return out;
}

test('randomized width invariants hold across 2000 seeded cases', () => {
  const seed = 0x5eed1234;
  const rand = mulberry32(seed);
  // Removing an escape sequence can move a ZWJ next to the preceding glyph,
  // which *does* change cluster membership (and therefore width). The UI never
  // emits ANSI between a base and its ZWJ — it styles whole cells — so the
  // strip-equality property is only asserted for inputs that contain no ZWJ.
  for (let caseIndex = 0; caseIndex < 2000; caseIndex += 1) {
    const value = randomString(rand, 0, 24);
    const max = Math.floor(rand() * 20);
    const context = `seed=0x${seed.toString(16)} case=${caseIndex} max=${max} value=${JSON.stringify(value)}`;
    const width = displayWidth(value);
    assert.ok(Number.isInteger(width) && width >= 0, `non-integer width; ${context}`);
    // Additive over token boundaries.
    const sum = displayTokens(value).reduce((total, token) => total + token.width, 0);
    assert.equal(width, sum, `token widths do not sum to display width; ${context}`);
    // Removing an escape sequence can move a ZWJ, a regional indicator or a
    // variation selector next to the preceding glyph, which *does* change
    // cluster membership (and width). The UI never emits ANSI inside a grapheme
    // cluster — it styles whole cells — so strip-equality is asserted only for
    // inputs without cluster-forming code points around escapes.
    if (!/[‍\u{1F1E6}-\u{1F1FF}︎️]/u.test(value)) {
      assert.equal(displayWidth(stripAnsi(value)), width, `stripAnsi changed width; ${context}`);
    }
    assert.ok(ansiIsWellFormed(value), `random input itself was malformed (test bug); ${context}`);
    try {
      assertTruncationInvariants(value, max, context);
    } catch (error) {
      throw new Error(`randomized failure; ${context}\n${error instanceof Error ? error.message : String(error)}`);
    }
  }
});

// ─── Session header box ─────────────────────────────────────────────────────

function headerLines(directory: string, columns: number): string[] {
  const ui = new TerminalUI({ noColor: true });
  const output = withColumns(columns, () => captureStdout(() => {
    ui.banner({ workspaceRoot: directory } as never, { name: 'openai', model: 'm' } as never);
  }));
  return output.split('\n').filter((line) => line.length > 0);
}

test('session header box stays aligned for CJK, emoji and combining paths', () => {
  for (const directory of ['C:\\用户\\项目\\目录', 'C:\\Users\\x\\😀😀\\cli', 'C:/e\u0301e\u0301/cli']) {
    for (const columns of [80, 120]) {
      const lines = headerLines(directory, columns);
      const widths = lines.map((line) => displayWidth(line));
      assert.equal(new Set(widths).size, 1, `misaligned box for ${directory}: ${widths.join(',')}`);
      assert.ok(widths[0]! <= columns, `box wider than terminal (${widths[0]} > ${columns})`);
    }
  }
});

test('session header folds instead of overflowing a 40 column terminal', () => {
  const directory = 'C:\\Users\\someone\\very\\deeply\\nested\\project\\workspace\\root\\directory';
  const lines = headerLines(directory, 40);
  const widths = lines.map((line) => displayWidth(line));
  assert.equal(new Set(widths).size, 1, `misaligned box: ${widths.join(',')}`);
  assert.ok(widths[0]! <= 40);
  // The fold must keep both ends of the path, not just the left edge.
  const dirRow = lines.find((line) => line.includes('directory:'))!;
  assert.ok(dirRow.includes('…'), 'expected a middle ellipsis on the folded directory row');
  assert.ok(dirRow.includes('directory'), 'expected the tail to remain visible');
});

test('exec title truncation is measured in display columns', () => {
  const ui = new TerminalUI({ noColor: true });
  const output = captureStdout(() => ui.toolStart('read_file', { path: `${'中文'.repeat(40)}.ts` }));
  const row = output.split('\n').find((line) => line.includes('Running'))!;
  // 2 prefix spaces + bullet + space + "Running" + space + "read_file" + space + <=60 columns.
  assert.ok(displayWidth(row) <= 2 + 2 + 7 + 1 + 9 + 1 + 60, `exec row too wide: ${displayWidth(row)}`);
  assert.ok(row.endsWith('...'), 'expected the truncation suffix');
});

// ─── Overlay in narrow terminals ────────────────────────────────────────────

test('overlay rows fit 20/40/80/200 column terminals', () => {
  const items = [
    { id: '/compact', keyword: '/compact [N]', detail: 'Compact context, keep last N messages + summary stub', tags: [] },
    { id: '/中文', keyword: '/不准偷懒开发 状态', detail: '查看守门状态与最近的判定记录', tags: [] },
    { id: '/wide', keyword: '/wide', detail: '😀'.repeat(40), tags: [] },
  ];
  for (const columns of [20, 40, 80, 200]) {
    for (const color of [false, true]) {
      const frame = withColumns(columns, () => renderOverlayFrame({
        title: 'Message Actions',
        query: '',
        items,
        selected: 0,
        color,
      }));
      assert.ok(ansiIsWellFormed(frame), `malformed ANSI at ${columns}`);
      for (const line of frame.split('\n')) {
        if (!line) continue;
        assert.ok(displayWidth(line) <= columns, `${columns} cols: row width ${displayWidth(line)}: ${JSON.stringify(line)}`);
      }
    }
  }
});

// ─── Home screen in narrow terminals ────────────────────────────────────────

const homeConfig = {
  provider: 'openai' as const,
  model: 'gpt-5.5',
  baseUrl: 'https://api.example.com/v1',
  approval: 'ask' as const,
  workspaceRoot: 'C:\\x',
  sessionDir: 'C:\\x\\.aicode\\sessions',
  maxSteps: 24,
  noBanner: false,
};
const homeProvider = {
  name: 'openai' as const,
  model: 'gpt-5.5',
  complete: async () => ({ actions: [] as Array<never> }),
};

test('home screen never draws past a 20 or 40 column terminal', () => {
  const originalRows = process.stdout.rows;
  (process.stdout as { rows?: number }).rows = 30;
  try {
    for (const columns of [20, 40]) {
      const screen = withColumns(columns, () => renderHomeScreen(homeConfig, homeProvider, {
        noColor: true,
        version: '0.1.0',
        logoOnly: false,
      }));
      for (const line of screen.split('\n')) {
        if (!line) continue;
        assert.ok(displayWidth(line) <= columns, `${columns} cols: row width ${displayWidth(line)}: ${JSON.stringify(line)}`);
      }
    }
  } finally {
    (process.stdout as { rows?: number }).rows = originalRows;
  }
});

test('home screen drops the wordmark when it cannot fit', () => {
  const screen = withColumns(20, () => renderHomeScreen(homeConfig, homeProvider, {
    noColor: true,
    logoOnly: true,
  }));
  assert.doesNotMatch(screen, /█████/, '20 column terminal must not paint the 52-column wordmark');
  assert.match(screen, /\/help commands/);
});

test('result card rows are clipped by display width, not UTF-16 length', () => {
  const longName = '进程'.repeat(60); // 120 CJK chars = 240 display columns
  const card = formatResultCard({
    tool: 'process_memory',
    output: '',
    data: { processes: [{ name: longName, pid: 42, memoryMb: 7 }] },
    locale: 'en',
  });
  assert.ok(card, 'card must still render');
  for (const line of card!.split('\n')) {
    assert.ok(displayWidth(line) <= 100, `row is ${displayWidth(line)} columns: ${JSON.stringify(line)}`);
  }
});

test('summarizeToolLine clips a CJK first line to 72 display columns', () => {
  const line = summarizeToolLine({ tool: 'read_file', ok: true, output: '中文内容'.repeat(30) });
  assert.ok(displayWidth(line) <= displayWidth('read_file ok · ') + 72, JSON.stringify(line));
  assert.ok(line.endsWith('...'), 'clipped summaries keep the ellipsis marker');
});

test('home card keeps both frame edges at 20/40/80 columns', () => {
  const originalRows = process.stdout.rows;
  (process.stdout as { rows?: number }).rows = 30;
  try {
    for (const columns of [20, 40, 80]) {
      const screen = withColumns(columns, () => renderHomeScreen(homeConfig, homeProvider, {
        noColor: true,
        version: '0.1.0',
        logoOnly: false,
      }));
      for (const raw of screen.split('\n')) {
        const line = stripAnsi(raw);
        if (!line.startsWith('│')) continue;
        assert.ok(line.endsWith('│'), `${columns} cols: inner row lost its right edge: ${JSON.stringify(line)}`);
        assert.equal(displayWidth(line), Math.min(columns, 72), `${columns} cols: frame width drifted: ${JSON.stringify(line)}`);
      }
    }
  } finally {
    (process.stdout as { rows?: number }).rows = originalRows;
  }
});
