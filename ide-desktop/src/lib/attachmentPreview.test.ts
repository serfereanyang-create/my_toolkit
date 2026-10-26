import { describe, expect, it, afterEach } from 'vitest';
import { MAX_THUMBNAIL_BYTES, withThumbnail, withThumbnails } from './attachmentPreview';
import type { DetectedFile } from './fileDetection';

const image = (overrides: Partial<DetectedFile> = {}): DetectedFile => ({
  path: '/tmp/pasted-image-1.png',
  name: 'pasted-image-1.png',
  size: 2048,
  category: 'image',
  mediaType: 'image/png',
  icon: '🖼️',
  ...overrides,
});

const scope = globalThis as unknown as { zcodeDesktop?: unknown };

afterEach(() => {
  delete scope.zcodeDesktop;
});

describe('withThumbnail', () => {
  it('图片附件会补上 data URL 缩略图', async () => {
    scope.zcodeDesktop = { fs: { readImageDataUrl: async () => 'data:image/png;base64,AAAA' } };
    const result = await withThumbnail(image());
    expect(result.preview).toBe('data:image/png;base64,AAAA');
  });

  it('非图片附件不去读文件', async () => {
    let called = 0;
    scope.zcodeDesktop = { fs: { readImageDataUrl: async () => { called += 1; return 'data:image/png;base64,AAAA'; } } };
    const result = await withThumbnail(image({ category: 'document', name: 'notes.md', path: '/tmp/notes.md' }));
    expect(result.preview).toBeUndefined();
    expect(called).toBe(0);
  });

  it('已经有缩略图时不重复读', async () => {
    let called = 0;
    scope.zcodeDesktop = { fs: { readImageDataUrl: async () => { called += 1; return 'data:other'; } } };
    const result = await withThumbnail(image({ preview: 'data:image/png;base64,OLD' }));
    expect(result.preview).toBe('data:image/png;base64,OLD');
    expect(called).toBe(0);
  });

  it('没有原生能力（node 环境）时原样返回', async () => {
    const result = await withThumbnail(image());
    expect(result).toEqual(image());
  });

  it('读取失败不抛错，只是没有缩略图', async () => {
    scope.zcodeDesktop = { fs: { readImageDataUrl: async () => { throw new Error('EPERM'); } } };
    const result = await withThumbnail(image());
    expect(result.preview).toBeUndefined();
    expect(result.name).toBe('pasted-image-1.png');
  });

  it('超过 8MB 的图片不去读：缩略图不值得为它把主进程读满', async () => {
    let called = 0;
    scope.zcodeDesktop = { fs: { readImageDataUrl: async () => { called += 1; return 'data:x'; } } };
    const result = await withThumbnail(image({ size: MAX_THUMBNAIL_BYTES + 1 }));
    expect(result.preview).toBeUndefined();
    expect(called).toBe(0);
  });

  it('路径为空的附件跳过（拖拽有时拿不到路径）', async () => {
    let called = 0;
    scope.zcodeDesktop = { fs: { readImageDataUrl: async () => { called += 1; return 'data:x'; } } };
    const result = await withThumbnail(image({ path: '' }));
    expect(result.preview).toBeUndefined();
    expect(called).toBe(0);
  });
});

describe('withThumbnails', () => {
  it('顺序与入参一致，混合类型各自处理', async () => {
    scope.zcodeDesktop = {
      fs: { readImageDataUrl: async (path: string) => `data:image/png;base64,${path.length}` },
    };
    const files = [
      image({ path: '/a.png' }),
      image({ path: '/b.md', name: 'b.md', category: 'document' }),
      image({ path: '/cccc.png' }),
    ];
    const result = await withThumbnails(files);
    expect(result.map((file) => file.name)).toEqual(['pasted-image-1.png', 'b.md', 'pasted-image-1.png']);
    expect(result[0].preview).toBe(`data:image/png;base64,${'/a.png'.length}`);
    expect(result[1].preview).toBeUndefined();
    expect(result[2].preview).toBe(`data:image/png;base64,${'/cccc.png'.length}`);
  });
});
