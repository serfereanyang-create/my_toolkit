import { validateFile, type DetectedFile } from './fileDetection';
import { withThumbnails } from './attachmentPreview';

export type AttachmentInspection = { path: string; ok: boolean; size?: number; mtimeMs?: number; error?: string };
type InspectAttachments = (paths: string[]) => Promise<AttachmentInspection[]>;

export async function refreshAttachments(files: DetectedFile[], inspect?: InspectAttachments): Promise<DetectedFile[]> {
  const api = globalThis as unknown as { zcodeDesktop?: { files?: { inspect?: InspectAttachments } } };
  const read = inspect ?? api.zcodeDesktop?.files?.inspect;
  let checked = files;
  if (read && files.length > 0) {
    try {
      const results = await read(files.map(file => file.path));
      if (results.length !== files.length || results.some((result, index) => result.path !== files[index]?.path)) {
        throw new Error('附件检查结果与当前文件不匹配。');
      }
      checked = files.map((file, index) => {
        const result = results[index]!;
        const size = result.size === undefined ? file.size : result.size;
        const validation = validateFile({ name: file.name, size });
        const error = !result.ok ? result.error || '附件不可读取，请重试或移除。'
          : result.size === undefined ? '无法确认附件大小，请重试。'
            : validation.valid ? undefined : validation.error;
        const changed = size !== file.size || (file.mtimeMs !== undefined && result.mtimeMs !== undefined && result.mtimeMs !== file.mtimeMs);
        if (file.attachmentError === error && !changed && file.mtimeMs === result.mtimeMs) return file;
        const { attachmentError: _error, preview, ...metadata } = file;
        return {
          ...metadata, size, mtimeMs: result.mtimeMs,
          ...(error ? { attachmentError: error } : {}),
          ...(!changed && !error && preview ? { preview } : {}),
        };
      });
    } catch {
      checked = files.map(file => {
        const error = '暂时无法检查附件，请重试。';
        if (file.attachmentError === error) return file;
        const { preview: _preview, ...metadata } = file;
        return { ...metadata, attachmentError: error };
      });
    }
  }
  const restored = await withThumbnails(checked);
  return restored.every((file, index) => file === files[index]) ? files : restored;
}
