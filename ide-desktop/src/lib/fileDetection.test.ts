import { describe, expect, it } from 'vitest';
import { detectedFileFromPath, MAX_FILE_SIZE, validateFile } from './fileDetection';

describe('attachment metadata and size policy', () => {
  it('preserves actual native metadata for a Unicode path', () => {
    const file = detectedFileFromPath('D:\\资料\\截图.png', 6912);
    expect(file.name).toBe('截图.png');
    expect(file.size).toBe(6912);
    expect(file.category).toBe('image');
    expect(validateFile(file)).toEqual({ valid: true });
  });

  it('allows genuine empty files and the exact size limit', () => {
    for (const size of [0, MAX_FILE_SIZE]) {
      expect(validateFile({ name: 'document.txt', size })).toEqual({ valid: true });
    }
  });

  it('rejects a file one byte over the limit for native and browser attachments', () => {
    expect(validateFile({ name: 'large.pdf', size: MAX_FILE_SIZE + 1 })).toEqual({
      valid: false, error: '文件 large.pdf 超过 50MB 大小限制',
    });
  });

  it('reports unreadable byte counts instead of accepting invalid metadata', () => {
    for (const size of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(validateFile({ name: 'invalid.txt', size }).valid).toBe(false);
    }
  });
});
