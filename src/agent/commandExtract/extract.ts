import type { CommandIntent, CommandSlots, Confidence, ExtractionResult } from './types.js';

const DOC_PATH_EXTENSIONS = 'docx|doc|pdf|txt|csv|xlsx|xls|pptx|ppt|png|jpe?g|gif|webp|zip|log|xml|html?';
const CODE_PATH_EXTENSIONS = `[cm]?[jt]sx?|java|kt|kts|py|rb|go|rs|swift|cs|cpp|cc|cxx|c|h|hpp|vue|svelte|json|ya?ml|toml|md|${DOC_PATH_EXTENSIONS}`;
const CODE_PATH_TOKEN_CHAR = 'A-Za-z0-9_./\\\\@+~%-';
const CODE_PATH_PATTERN = new RegExp(
  `(?<![${CODE_PATH_TOKEN_CHAR}])(?:[${CODE_PATH_TOKEN_CHAR}]+[\\\\/])*[${CODE_PATH_TOKEN_CHAR}]+\\.(?:${CODE_PATH_EXTENSIONS})(?![${CODE_PATH_TOKEN_CHAR}])`,
  'i',
);
// Absolute Windows path that may include non-ASCII (e.g. Desktop/测试.docx) and trailing Chinese verbs.
const ABSOLUTE_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>|*?]+\.[A-Za-z0-9]{1,8}/;
const DESKTOP_PATH_PATTERN = /desktop[\\/][^\s"'<>|*?]+/i;
const TRAILING_READ_NOISE = /(?:看|查看|读取|读一下|打开|内容|的?内容|一下)+$/u;

export function extractCommand(prompt: string): ExtractionResult {
  const normalized = prompt.toLowerCase();
  const path = extractPath(prompt);
  const query = extractSearchQuery(prompt);
  const drive = extractDrive(normalized);
  const hours = extractNumber(normalized, /(最近|past|last)\s*(\d+)\s*(小时|hours?)/i, 2) ?? extractNumber(normalized, /(\d+)\s*(小时|hours?)/i, 1);
  const minMb = extractNumber(normalized, /(大于|超过|over|above)\s*(\d+)\s*m/i, 2);
  const limit = extractNumber(normalized, /(前|top)\s*(\d+)/i, 2);
  const command = extractShellCommand(prompt);
  const slots: CommandSlots = {
    path,
    query,
    drive,
    hours: hours ?? undefined,
    minMb: minMb ?? undefined,
    limit: limit ?? undefined,
    command,
  };

  // Document/path-first: "C:\...\测试.docx看" / "desktop/x.docx" → one-shot read_file, no model loop.
  if (path && isDocumentPath(path) && !hasEditVerb(normalized) && !hasSearchVerb(normalized)) {
    return result('file_read', slots, 'high', ['document or absolute path implies read']);
  }

  if (hasEditVerb(normalized) && (path || hasCodeContext(normalized))) {
    return result('code_edit', slots, 'medium', ['edit intent with code context is strategy-only']);
  }

  if ((hasReadVerb(normalized) || isPathOnlyPrompt(prompt, path)) && path) {
    return result('file_read', slots, 'high', ['explicit read with path']);
  }

  if (hasSearchVerb(normalized) && (query || path)) {
    return result('code_search', slots, query || path ? 'high' : 'medium', ['search intent with query or path']);
  }

  if (hasAny(normalized, ['增长', '涨了', '大文件', '清理', '最近文件', 'disk growth', 'large files'])) {
    return result('disk_growth', { ...slots, hours: slots.hours ?? 48, minMb: slots.minMb ?? 16 }, 'high', ['disk growth keywords']);
  }

  if (hasAny(normalized, ['磁盘', '硬盘', 'c盘', 'd盘', '容量', '剩余空间', '多大', 'disk', 'drive', 'free space']) && !path) {
    return result('disk_capacity', { ...slots, drive: slots.drive ?? 'C' }, 'high', ['disk capacity keywords']);
  }

  if (hasAny(normalized, ['内存', 'memory', '进程', 'process', '占用'])) {
    return result('process_memory', { ...slots, limit: slots.limit ?? 10 }, 'high', ['process/memory keywords']);
  }

  if (hasAny(normalized, ['环境', '容器', '系统信息', '运行环境', 'environment', 'container', 'runtime'])) {
    return result('runtime_info', slots, 'high', ['runtime/environment keywords']);
  }

  if (hasAny(normalized, ['最近', '在干嘛', '活动', '会话', '历史', 'recent', 'activity', 'history', 'sessions'])) {
    return result('recent_activity', { ...slots, limit: slots.limit ?? 5 }, 'high', ['recent activity keywords']);
  }

  if (hasAny(normalized, ['索引', 'index', '项目结构', 'project index'])) {
    return result('project_index', slots, 'high', ['project index keywords']);
  }

  if (hasAny(normalized, ['项目', 'project', '状态', 'status', '概况', '有哪些文件', '列出文件', 'list files'])) {
    return result('project_status', slots, 'high', ['project status/overview keywords']);
  }

  if (hasEditVerb(normalized)) {
    return result('code_edit', slots, 'medium', ['edit intent is strategy-only']);
  }

  if (hasAny(normalized, ['创建', '生成', 'create', 'write']) && path) {
    return result('code_edit', slots, 'medium', ['explicit write/create remains strategy or mock-demo only']);
  }

  if (command || hasAny(normalized, ['运行', '执行', 'run command', 'execute'])) {
    return result('shell_command', slots, command ? 'medium' : 'low', ['shell intent is strategy-only']);
  }

  if (hasReadVerb(normalized) && !path) {
    return result('file_read', slots, 'low', ['read intent without path']);
  }

  if (hasSearchVerb(normalized) && !query && !path) {
    return result('code_search', slots, 'low', ['search intent without query']);
  }

  return result('unknown', slots, 'low', ['no strong intent']);
}

function result(intent: CommandIntent, slots: CommandSlots, confidence: Confidence, reasons: string[]): ExtractionResult {
  return { intent, slots, confidence, reasons };
}

function hasReadVerb(value: string) {
  // Include short Chinese "看" / "看看" which users type after a path.
  if (/看|内容|全文|预览/.test(value)) return true;
  return hasChineseOrEnglishWord(value, ['读取', '读', '打开', '查看', '看看'], ['read', 'open', 'show', 'view', 'preview', 'cat']);
}

function hasSearchVerb(value: string) {
  return hasChineseOrEnglishWord(value, ['查找', '搜索', '在哪里', '引用', '定位'], ['find', 'search', 'grep', 'reference', 'where']);
}

function hasEditVerb(value: string) {
  return hasChineseOrEnglishWord(
    value,
    ['修复', '修改', '实现', '新增', '删除', '重构', '优化', '改成', '改'],
    ['fix', 'modify', 'implement', 'add', 'delete', 'refactor', 'optimize', 'update', 'create', 'write'],
  );
}

function hasCodeContext(value: string) {
  return hasAny(value, ['代码', '源码', '源文件', 'bug', '按钮', '函数', '组件', '解析器', '显示', 'code', 'source', 'button', 'function', 'component', 'class', 'parser', 'handler', 'display']);
}

function extractPath(prompt: string) {
  const quoted = prompt.match(/"([^"\n]+)"|'([^'\n]+)'/);
  if (quoted) {
    const candidate = (quoted[1] ?? quoted[2] ?? '').trim();
    if (candidate && /\.[A-Za-z0-9]{1,8}$/.test(candidate)) return cleanExtractedPath(candidate);
  }

  const absolute = prompt.match(ABSOLUTE_PATH_PATTERN);
  if (absolute?.[0]) return cleanExtractedPath(absolute[0]);

  const desktop = prompt.match(DESKTOP_PATH_PATTERN);
  if (desktop?.[0]) return cleanExtractedPath(desktop[0].replace(/\\/g, '/'));

  const match = prompt.match(CODE_PATH_PATTERN)
    ?? prompt.match(/(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+|(?:^|\s)(\.smoke\/[A-Za-z0-9_.-]+)|(?:^|\s)([A-Za-z0-9_.-]+\.[A-Za-z0-9]+)/);
  if (!match) return undefined;
  return cleanExtractedPath((match[0] ?? match[1] ?? match[2])?.trim() ?? '');
}

function cleanExtractedPath(value: string) {
  let path = value.trim().replace(/^["']|["']$/g, '');
  // Strip trailing Chinese verbs glued to the extension: 测试.docx看
  path = path.replace(TRAILING_READ_NOISE, '');
  path = path.replace(/[，。！？；：、,.!?;:]+$/u, '');
  return path.trim() || undefined;
}

function isDocumentPath(path: string) {
  return /\.(docx?|pdf|txt|csv|xlsx?|pptx?|png|jpe?g|gif|webp|md|log|xml|html?)$/i.test(path)
    || /^desktop[\\/]/i.test(path)
    || /^[A-Za-z]:[\\/]/.test(path);
}

function isPathOnlyPrompt(prompt: string, path: string | undefined) {
  if (!path) return false;
  const leftover = prompt
    .replace(path, ' ')
    .replace(TRAILING_READ_NOISE, ' ')
    .replace(/["']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return leftover.length === 0 || leftover.length <= 4;
}

function extractSearchQuery(prompt: string) {
  const quoted = prompt.match(/["'“”‘’]([^"'“”‘’]{1,120})["'“”‘’]/);
  if (quoted?.[1]) return quoted[1].trim();
  const cleaned = prompt
    .replace(/帮我|请|一下|修复|修改|实现|新增|删除|重构|优化|查找|搜索|在哪里|读取|读|打开|查看|的问题|问题/gi, ' ')
    .replace(/\b(?:please|kindly|fix|modify|implement|add|delete|refactor|optimize|update|find|search|look\s+for|locate|read|open|show)\b/gi, ' ')
    .replace(/^\s*for\b/i, ' ')
    .replace(CODE_PATH_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return undefined;
  if (cleaned.length > 80) return cleaned.slice(0, 80).trim();
  return cleaned;
}

function extractDrive(normalized: string) {
  if (normalized.includes('d盘') || /\b[d]:/.test(normalized)) return 'D';
  if (normalized.includes('c盘') || /\b[c]:/.test(normalized)) return 'C';
  return undefined;
}

function extractShellCommand(prompt: string) {
  const match = prompt.match(/(?:运行|执行|run|execute)\s+([^，。\n]+)/i);
  return match?.[1]?.trim();
}

function extractNumber(value: string, pattern: RegExp, group: number) {
  const match = value.match(pattern);
  if (!match?.[group]) return undefined;
  const parsed = Number(match[group]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasAny(value: string, needles: string[]) {
  return needles.some((needle) => value.includes(needle));
}

const ENGLISH_WORD_BOUNDARY_PATTERNS = new Map<string, RegExp>();

function englishWordBoundaryPattern(needle: string) {
  let pattern = ENGLISH_WORD_BOUNDARY_PATTERNS.get(needle);
  if (!pattern) {
    pattern = new RegExp(`\\b${needle}\\b`);
    ENGLISH_WORD_BOUNDARY_PATTERNS.set(needle, pattern);
  }
  return pattern;
}

function hasChineseOrEnglishWord(value: string, chineseNeedles: string[], englishNeedles: string[]) {
  if (chineseNeedles.some((needle) => value.includes(needle))) return true;
  return englishNeedles.some((needle) => englishWordBoundaryPattern(needle).test(value));
}
