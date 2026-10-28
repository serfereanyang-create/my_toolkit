import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FileAttachmentList } from './FileAttachmentCard';
import type { DetectedFile } from '../lib/fileDetection';

const file = (overrides: Partial<DetectedFile> = {}): DetectedFile => ({
  path: '/tmp/shot.png',
  name: 'shot.png',
  size: 2048,
  category: 'image',
  mediaType: 'image/png',
  icon: '🖼️',
  ...overrides,
});

/* 附件卡的两件事：图片必须画出缩略图（否则贴了两张截图就分不清），
   非图片必须有图标和「类型 · 大小」，删除按钮必须能被键盘聚焦到。 */

describe('FileAttachmentList', () => {
  it('shows an unavailable file with a reason and an explicit retry without showing a stale thumbnail', () => {
    const html = renderToStaticMarkup(<FileAttachmentList files={[file({ attachmentError: '原文件已移动或删除', preview: 'data:image/png;base64,old' })]} onRemove={() => {}} onRetry={() => {}} />);
    expect(html).toContain('data-attachment-error="true"');
    expect(html).toContain('原文件已移动或删除');
    expect(html).toContain('aria-label="重新检查附件 shot.png"');
    expect(html).not.toContain('file-attachment-thumb');
  });
  it('没有附件时不渲染任何东西', () => {
    expect(renderToStaticMarkup(<FileAttachmentList files={[]} onRemove={() => {}} />)).toBe('');
  });

  it('图片附件画缩略图，alt 用文件名', () => {
    const html = renderToStaticMarkup(
      <FileAttachmentList files={[file({ preview: 'data:image/png;base64,AAAA' })]} onRemove={() => {}} />,
    );
    expect(html).toContain('class="file-attachment-thumb"');
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain('alt="shot.png"');
    expect(html).toContain('class="file-attachment-card has-thumb"');
  });

  it('没有缩略图时退回图标，不出现空的 img', () => {
    const html = renderToStaticMarkup(<FileAttachmentList files={[file()]} onRemove={() => {}} />);
    expect(html).not.toContain('file-attachment-thumb');
    expect(html).toContain('file-attachment-glyph');
    expect(html).toContain('🖼️');
  });

  it('文件名、类型与大小都出现在卡片上', () => {
    const html = renderToStaticMarkup(
      <FileAttachmentList files={[file({ name: '报告.pdf', category: 'document', size: 2048, icon: '📄' })]} onRemove={() => {}} />,
    );
    expect(html).toContain('title="报告.pdf"');
    expect(html).toContain('文档');
    expect(html).toContain('2.0 KB');
    expect(html).toContain('data-attachment="document"');
  });

  it('删除按钮带具体文件名，键盘也能聚焦', () => {
    const html = renderToStaticMarkup(<FileAttachmentList files={[file({ name: 'shot.png' })]} onRemove={() => {}} />);
    expect(html).toContain('aria-label="移除附件 shot.png"');
    expect(html).toContain('type="button"');
  });

  it('多张附件各画各的缩略图', () => {
    const html = renderToStaticMarkup(
      <FileAttachmentList
        files={[file({ path: '/a.png', preview: 'data:image/png;base64,A' }), file({ path: '/b.png', preview: 'data:image/png;base64,B' })]}
        onRemove={() => {}}
      />,
    );
    expect(html).toContain('src="data:image/png;base64,A"');
    expect(html).toContain('src="data:image/png;base64,B"');
  });
});
