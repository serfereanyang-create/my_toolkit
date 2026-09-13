import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearInputHistory,
  loadInputHistory,
  normalizeHistoryEntry,
  pushInputHistory,
  INPUT_HISTORY_LIMIT,
} from './inputHistory';

describe('normalizeHistoryEntry', () => {
  it('collapses newlines and trims', () => {
    expect(normalizeHistoryEntry('  a\nb  ')).toBe('a b');
  });
  it('rejects blank input', () => {
    expect(normalizeHistoryEntry('\n \n')).toBe('');
  });
});

describe('pushInputHistory', () => {
  beforeEach(() => clearInputHistory());

  it('round-trips entries in order', () => {
    pushInputHistory('first');
    pushInputHistory('second');
    expect(loadInputHistory()).toEqual(['first', 'second']);
  });

  it('dedupes by moving the repeated entry to newest', () => {
    pushInputHistory('a');
    pushInputHistory('b');
    pushInputHistory('a');
    expect(loadInputHistory()).toEqual(['b', 'a']);
  });

  it('ignores blank pushes', () => {
    pushInputHistory('keep');
    pushInputHistory('   ');
    expect(loadInputHistory()).toEqual(['keep']);
  });

  it('caps at the limit by dropping the oldest', () => {
    for (let index = 0; index < INPUT_HISTORY_LIMIT + 5; index += 1) {
      pushInputHistory(`entry ${index}`);
    }
    const entries = loadInputHistory();
    expect(entries).toHaveLength(INPUT_HISTORY_LIMIT);
    expect(entries[0]).toBe('entry 5');
    expect(entries[entries.length - 1]).toBe(`entry ${INPUT_HISTORY_LIMIT + 4}`);
  });
});
