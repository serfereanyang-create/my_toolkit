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

function FileAttachmentCard({ file, onRemove }: FileAttachmentCardProps) {
  const { name, size, category, icon } = file;

  return (
    <div className="file-attachment-card">
      <div className="file-icon">{icon}</div>
      <div className="file-info">
        <div className="file-name" title={name}>
          {name}
        </div>
        <div className="file-meta">
          <span className="file-category">{getCategoryLabel(category)}</span>
          <span className="file-size">{formatFileSize(size)}</span>
        </div>
      </div>
      <button
        className="file-remove"
        onClick={onRemove}
        aria-label="移除文件"
        title="移除文件"
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
