import type { DetectedFile } from '../lib/fileDetection';
import { formatFileSize } from '../lib/fileDetection';
import { AlertTriangle, RefreshCw } from 'lucide-react';

type FileAttachmentListProps = {
  files: DetectedFile[];
  onRemove: (index: number) => void;
  onRetry?: () => void;
};

export function FileAttachmentList({ files, onRemove, onRetry }: FileAttachmentListProps) {
  if (files.length === 0) return null;

  return (
    <div className="file-attachment-list">
      {files.map((file, index) => (
        <FileAttachmentCard
          key={`${file.path}-${index}`}
          file={file}
          onRemove={() => onRemove(index)}
          onRetry={onRetry}
        />
      ))}
    </div>
  );
}

type FileAttachmentCardProps = {
  file: DetectedFile;
  onRemove: () => void;
  onRetry?: () => void;
};

/**
 * 一张附件卡：图片画缩略图，其它文件画类型图标。
 *
 * 有缩略图时才叫「我贴的是这张图」；只写文件名的话，两张截图长得一模一样，
 * 用户没有任何办法确认自己贴错了哪一张。
 */
function FileAttachmentCard({ file, onRemove, onRetry }: FileAttachmentCardProps) {
  const { name, size, category, icon, attachmentError } = file;
  const preview = attachmentError ? undefined : file.preview;

  return (
    <div className={`file-attachment-card${preview ? ' has-thumb' : ''}${attachmentError ? ' is-unavailable' : ''}`} data-attachment={category} data-attachment-error={attachmentError ? 'true' : undefined}>
      {preview ? (
        <img className="file-attachment-thumb" src={preview} alt={name} data-attachment-thumb="" />
      ) : (
        <div className="file-attachment-glyph" aria-hidden="true">{icon}</div>
      )}
      <div className="file-attachment-foot">
        <span className="file-attachment-name" title={name}>{name}</span>
        <span className="file-attachment-meta">
          <span className="file-category">{getCategoryLabel(category)}</span>
          <span className="file-size">{formatFileSize(size)}</span>
        </span>
        {attachmentError && <span className="file-attachment-error" role="status" title={attachmentError}><AlertTriangle size={12} aria-hidden="true" />{attachmentError}</span>}
        {attachmentError && onRetry && <button type="button" className="file-attachment-retry" onClick={onRetry} aria-label={`重新检查附件 ${name}`}><RefreshCw size={12} aria-hidden="true" />重新检查</button>}
      </div>
      <button
        type="button"
        className="file-remove"
        onClick={onRemove}
        aria-label={`移除附件 ${name}`}
        title="移除附件"
      >
        ×
      </button>
    </div>
  );
}

function getCategoryLabel(category: string): string {
  switch (category) {
    case 'image': return '图片';
    case 'document': return '文档';
    case 'code': return '代码';
    case 'data': return '数据';
    case 'archive': return '压缩包';
    default: return '文件';
  }
}
