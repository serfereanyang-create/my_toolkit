import { describe, expect, it } from 'vitest';
import { nextRovingTabId } from './rovingTabs';

describe('roving tab navigation', () => {
  it('wraps arrows and supports Home/End', () => {
    const tabs = ['one', 'two', 'three'];
    expect(nextRovingTabId(tabs, 'one', 'ArrowLeft')).toBe('three');
    expect(nextRovingTabId(tabs, 'three', 'ArrowRight')).toBe('one');
    expect(nextRovingTabId(tabs, 'two', 'Home')).toBe('one');
    expect(nextRovingTabId(tabs, 'two', 'End')).toBe('three');
  });
});
