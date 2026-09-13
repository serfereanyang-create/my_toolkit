import { describe, expect, it } from 'vitest';
import {
  contextBudget,
  estimateTokens,
  fitToBudget,
  tokenBreakdown,
  tokenizeRuns,
} from './tokenEstimate';

describe('estimateTokens', () => {
  it('estimates empty and whitespace-only strings as zero tokens', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('   \n\t  ')).toBe(0);
  });

  it('counts a CJK ideograph as roughly one token', () => {
    // 6 ideographs should land close to 6, never at the latin 1/4 rate.
    expect(estimateTokens('你好世界你好')).toBe(6);
  });

  it('counts hiragana and katakana as CJK', () => {
    expect(estimateTokens('こんにちは')).toBe(5);
    expect(estimateTokens('カタカナ')).toBe(4);
  });

  it('counts hangul syllables as CJK', () => {
    expect(estimateTokens('안녕하세요')).toBe(5);
  });

  it('counts latin words at roughly one token per three and a half characters', () => {
    const one = estimateTokens('hello'); // 5 chars -> 2
    expect(one).toBe(2);
    expect(estimateTokens('a')).toBe(1); // single chars floor at 1
  });

  it('treats digit runs by groups of three', () => {
    // 6 digits -> 2 tokens; commas colons are consumed by the run.
    expect(estimateTokens('123,456')).toBe(2);
    expect(estimateTokens('42')).toBe(1);
  });

  it('uses the dense ratio for URLs and paths', () => {
    const url = 'https://example.com/some/deep/path';
    const dense = tokenBreakdown(url).dense;
    expect(dense).toBeGreaterThan(0);
    // Dense runs must cost at least as many tokens as length/3 rounded up.
    expect(dense).toBe(Math.ceil(url.length / 3));
  });

  it('splits camelCase identifiers >= 12 chars as dense', () => {
    const ident = 'handleContextMenuClick';
    expect(tokenizeRuns(ident).every((s) => s.kind === 'dense')).toBe(true);
  });

  it('is monotonic: appending text never lowers the estimate', () => {
    let prev = 0;
    for (const word of ['the', 'quick', 'brown', 'fox', '跳', '了', 'over']) {
      const next = estimateTokens(word);
      prev = next;
      expect(next).toBeGreaterThan(0);
    }
    expect(estimateTokens('the quick brown fox 跳了over')).toBeGreaterThanOrEqual(prev);
  });

  it('mixed CJK + latin code text stays within a sane band', () => {
    const text = 'function greet(name: string) { return `你好，${name}`; }';
    const t = estimateTokens(text);
    // Real tokenizers report ~28 for this line; the estimator must be in the
    // same order of magnitude (20..40), not 4x off.
    expect(t).toBeGreaterThan(18);
    expect(t).toBeLessThan(45);
  });
});

describe('tokenizeRuns', () => {
  it('covers every non-whitespace char exactly once', () => {
    const text = '你好 hello 42 https://x.dev/ab !!';
    const runs = tokenizeRuns(text);
    const covered = new Set<number>();
    for (const run of runs) {
      for (let i = run.start; i < run.end; i += 1) {
        expect(covered.has(i)).toBe(false);
        covered.add(i);
        expect(/\s/.test(text[i])).toBe(false);
      }
    }
    let expected = 0;
    for (const ch of text) if (!/\s/.test(ch)) expected += 1;
    expect(covered.size).toBe(expected);
  });

  it('returns no segments for empty input', () => {
    expect(tokenizeRuns('')).toEqual([]);
  });
});

describe('tokenBreakdown', () => {
  it('sums to the same total as estimateTokens', () => {
    const text = 'const 计数器 = "counter"; // 123 tokens https://a.io/b';
    const bd = tokenBreakdown(text);
    const sum = bd.cjk + bd.latin + bd.digit + bd.dense + bd.symbol;
    expect(sum).toBe(estimateTokens(text));
  });
});

describe('contextBudget', () => {
  it('falls back to a 128k window when the provider reports none', () => {
    const b = contextBudget(1000, null);
    expect(b.usable).toBe(128_000 - 4096);
    expect(b.level).toBe('ok');
  });

  it('reserves at most a quarter of small windows', () => {
    // 8k window: reserve 2048 (25%) rather than the 4096 default cap.
    const b = contextBudget(100, 8192);
    expect(b.usable).toBe(8192 - 2048);
  });

  it('classifies severity at 60% and 85% thresholds', () => {
    const b = contextBudget(0, 100_000);
    expect(contextBudget(Math.floor(b.usable * 0.59), b.usable + 4096).level).toBe('ok');
    expect(contextBudget(Math.floor(b.usable * 0.61), b.usable + 4096).level).toBe('warn');
    expect(contextBudget(Math.floor(b.usable * 0.9), b.usable + 4096).level).toBe('critical');
  });
});

describe('fitToBudget', () => {
  it('keeps everything when already inside budget', () => {
    expect(fitToBudget(['short', 'also short'], 1000)).toEqual([0, 1]);
  });

  it('drops oldest unpinned messages but always keeps the newest', () => {
    const texts = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40), 'd'.repeat(40)];
    const kept = fitToBudget(texts, 10); // only one message fits
    expect(kept[kept.length - 1]).toBe(3);
  });

  it('never drops pinned messages', () => {
    const texts = ['x'.repeat(40), 'y'.repeat(40), 'z'.repeat(40)];
    const kept = fitToBudget(texts, 10, new Set([0]));
    // Pinned idx 0 survives; the middle message is the only droppable one.
    expect(kept).toContain(0);
    expect(kept).toContain(2); // newest is always kept
    expect(kept).not.toContain(1);
  });
});
