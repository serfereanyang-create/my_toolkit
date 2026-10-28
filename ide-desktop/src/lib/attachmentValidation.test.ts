import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshAttachments } from './attachmentValidation';
import type { DetectedFile } from './fileDetection';

const file = (patch: Partial<DetectedFile> = {}): DetectedFile => ({
  path: 'C:/project/reference.txt', name: 'reference.txt', size: 12, category: 'document', icon: 'file', ...patch,
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('attachment revalidation', () => {
  it('preserves missing attachment metadata and clears its stale thumbnail', async () => {
    const original = file({ category: 'image', preview: 'data:image/png;base64,old' });
    const result = await refreshAttachments([original], async paths => [{ path: paths[0]!, ok: false, error: '原文件已移动或删除' }]);
    expect(result[0]?.path).toBe(original.path);
    expect(result[0]?.attachmentError).toMatch(/移动或删除/);
    expect(result[0]?.preview).toBeUndefined();
  });

  it('clears an earlier error when the original file becomes readable again', async () => {
    const result = await refreshAttachments([file({ attachmentError: 'missing' })], async paths => [{ path: paths[0]!, ok: true, size: 15, mtimeMs: 200 }]);
    expect(result[0]?.attachmentError).toBeUndefined();
    expect(result[0]?.size).toBe(15);
    expect(result[0]?.mtimeMs).toBe(200);
  });

  it('keeps oversized and unreadable results out of a sendable state', async () => {
    const oversized = await refreshAttachments([file()], async paths => [{ path: paths[0]!, ok: true, size: 52428801 }]);
    expect(oversized[0]?.attachmentError).toMatch(/50MB/);
    const unavailable = await refreshAttachments([file()], async () => { throw new Error('bridge unavailable'); });
    expect(unavailable[0]?.attachmentError).toMatch(/无法检查/);
  });

  it('rejects mismatched response ownership and missing successful byte counts', async () => {
    const wrong = await refreshAttachments([file()], async () => [{ path: 'C:/other.txt', ok: true, size: 1 }]);
    expect(wrong[0]?.attachmentError).toMatch(/无法检查/);
    const missing = await refreshAttachments([file()], async paths => [{ path: paths[0]!, ok: true }]);
    expect(missing[0]?.attachmentError).toMatch(/大小/);
  });

  it('refreshes an image after its mtime changes and skips thumbnail reads for unavailable files', async () => {
    const readThumbnail = vi.fn(async () => 'data:image/png;base64,new');
    vi.stubGlobal('zcodeDesktop', { fs: { readImageDataUrl: readThumbnail } });
    const image = file({ category: 'image', mtimeMs: 1, preview: 'data:image/png;base64,old' });
    const result = await refreshAttachments([image], async paths => [{ path: paths[0]!, ok: true, size: 12, mtimeMs: 2 }]);
    expect(result[0]?.preview).toBe('data:image/png;base64,new');
    expect(readThumbnail).toHaveBeenCalledTimes(1);
    await refreshAttachments([image], async paths => [{ path: paths[0]!, ok: false, error: 'missing' }]);
    expect(readThumbnail).toHaveBeenCalledTimes(1);
  });

  it('keeps an unchanged valid snapshot stable without forcing another render', async () => {
    const files = [file({ mtimeMs: 1 })];
    const result = await refreshAttachments(files, async paths => [{ path: paths[0]!, ok: true, size: 12, mtimeMs: 1 }]);
    expect(result).toBe(files);
  });
});
