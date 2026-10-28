import { describe, expect, it } from 'vitest';
import { nextPreviewTabId } from '../../lib/previewNavigation';

describe('preview tab keyboard navigation', () => {
  const ids = ['one', 'two', 'three'];

  it('wraps left and right around the tab list', () => {
    expect(nextPreviewTabId(ids, 'one', 'ArrowLeft')).toBe('three');
    expect(nextPreviewTabId(ids, 'three', 'ArrowRight')).toBe('one');
    expect(nextPreviewTabId(ids, 'two', 'ArrowRight')).toBe('three');
  });

  it('supports Home and End and handles an empty list', () => {
    expect(nextPreviewTabId(ids, 'two', 'Home')).toBe('one');
    expect(nextPreviewTabId(ids, 'two', 'End')).toBe('three');
    expect(nextPreviewTabId([], null, 'Home')).toBeNull();
  });
});
