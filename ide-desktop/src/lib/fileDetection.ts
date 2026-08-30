export type FileCategory = 'image' | 'document' | 'code' | 'data' | 'archive' | 'unknown';

export type DetectedFile = {
  path: string;
  name: string;
  size: number;
  category: FileCategory;
  mediaType?: string;
  icon: string;
};

export const MAX_FILE_COUNT = 10;
export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico'];
const DOCUMENT_EXTS = ['.pdf', '.doc', '.docx', '.txt', '.md', '.rtf', '.odt'];
const CODE_EXTS = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.go', '.rs', '.rb', '.php', '.html', '.css', '.json', '.xml', '.yaml', '.yml'];
const DATA_EXTS = ['.csv', '.tsv', '.jsonl', '.parquet', '.db', '.sqlite'];
const ARCHIVE_EXTS = ['.zip', '.tar', '.gz', '.7z', '.rar'];

export function categorizeFile(fileName: string): FileCategory {
  const name = fileName.toLowerCase();
  const ext = name.substring(name.lastIndexOf('.'));
  
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (DOCUMENT_EXTS.includes(ext)) return 'document';
  if (CODE_EXTS.includes(ext)) return 'code';
  if (DATA_EXTS.includes(ext)) return 'data';
  if (ARCHIVE_EXTS.includes(ext)) return 'archive';
  
  return 'unknown';
}

export function getMediaType(fileName: string): string | undefined {
  const name = fileName.toLowerCase();
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.gif')) return 'image/gif';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.svg')) return 'image/svg+xml';
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.xml')) return 'application/xml';
  
  return undefined;
}

export function getCategoryIcon(category: FileCategory): string {
  switch (category) {
    case 'image': return '🖼️';
    case 'document': return '📄';
    case 'code': return '💻';
    case 'data': return '📊';
    case 'archive': return '📦';
    default: return '📎';
  }
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function validateFile(file: File): { valid: boolean; error?: string } {
  if (file.size > MAX_FILE_SIZE) {
    return { valid: false, error: `文件 ${file.name} 超过 50MB 大小限制` };
  }
  return { valid: true };
}

export function generateSmartPrompt(files: DetectedFile[]): string {
  if (files.length === 0) return '';
  
  if (files.length === 1) {
    const f = files[0];
    return `请查看这个${getCategoryLabel(f.category)}文件：${f.name}`;
  }
  
  const grouped = files.reduce((acc, f) => {
    const key = f.category;
    if (!acc[key]) acc[key] = [];
    acc[key].push(f.name);
    return acc;
  }, {} as Record<FileCategory, string[]>);
  
  const parts = Object.entries(grouped).map(([cat, names]) => {
    const label = getCategoryLabel(cat as FileCategory);
    return `${names.length}个${label}文件（${names.slice(0, 2).join('、')}${names.length > 2 ? '等' : ''}）`;
  });
  
  return `请查看这些文件：${parts.join('、')}`;
}

function getCategoryLabel(category: FileCategory): string {
  switch (category) {
    case 'image': return '图片';
    case 'document': return '文档';
    case 'code': return '代码';
    case 'data': return '数据';
    case 'archive': return '压缩包';
    default: return '';
  }
}
