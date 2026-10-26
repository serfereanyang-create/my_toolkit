import type { DetectedFile } from '../lib/fileDetection';
import { formatFileSize } from '../lib/fileDetection';

type FileAttachmentListProps = {
  files: DetectedFile[];
  onRemove: (index: number) => void;
};

export function FileAttachmentList({ files, onRemove }: FileAttachmentListProps) {
  if (files.length === 0) return null;

  return (
    <div className="file-attachment-list">
      {files.map((file, index) => (
        <FileAttachmentCard
          key={`${file.path}-${index}`}
          file={file}
          onRemove={() => onRemove(index)}
        />
      ))}
    </div>
  );
}

type FileAttachmentCardProps = {
  file: DetectedFile;
  onRemove: () => void;
};

/**
 * 一张附件卡：图片画缩略图，其它文件画类型图标。
 *
 * 有缩略图时才叫「我贴的是这张图」；只写文件名的话，两张截图长得一模一样，
 * 用户没有任何办法确认自己贴错了哪一张。
 */
function FileAttachmentCard({ file, onRemove }: FileAttachmentCardProps) {
  const { name, size, category, icon, preview } = file;

  return (
    <div className={`file-attachment-card${preview ? ' has-thumb' : ''}`} data-attachment={category}>
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
