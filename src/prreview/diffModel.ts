export function splitLines(text: string): string[] {
  return text.split('\n');
}

export interface DiffHunk {
  newStart: number;
  newLines: number;
  oldStart: number;
  oldLines: number;
  changes: string[];
}

export interface FileDiff {
  path: string;
  oldPath: string;
  kind: 'added' | 'modified' | 'deleted' | 'renamed';
  hunks: DiffHunk[];
  addedLines: number;
  removedLines: number;
}

export interface ParsedDiff {
  files: FileDiff[];
  totalAdded: number;
  totalRemoved: number;
}

/** 正文行分类：add/del/context（文件头 +++/--- 不算变更） */
function classifyBodyLine(line: string): 'add' | 'del' | 'context' {
  if (line[0] === '+' && line[1] !== '+') return 'add';
  if (line[0] === '-' && line[1] !== '-') return 'del';
  return 'context';
}

/**
 * 拆分 `diff --git <a> <b>` 的两个路径 token。
 *
 * git 对含空格/特殊字符的路径会加双引号并做 C 风格转义
 * （`diff --git "a/my file.ts" "b/my file.ts"`）。旧的「找 ' a/' 与 ' b/'」
 * 做法既不认引号，也会把带空格的路径截断，文件直接从解析结果里消失——
 * 评审报告于是漏掉了这些文件。按 token 扫描并对引号内的转义做反转义。
 */
function gitHeaderTokens(rest: string): string[] | null {
  const tokens: string[] = [];
  let i = 0;
  while (i < rest.length) {
    while (rest[i] === ' ') i++;
    if (i >= rest.length) break;
    if (rest[i] === '"') {
      const start = i;
      i++;
      while (i < rest.length && rest[i] !== '"') {
        if (rest[i] === '\\') i++;
        i++;
      }
      i = Math.min(i + 1, rest.length);
      tokens.push(unquoteGitPath(rest.slice(start, i)));
    } else {
      const start = i;
      while (i < rest.length && rest[i] !== ' ') i++;
      tokens.push(rest.slice(start, i));
    }
  }
  return tokens.length === 2 ? tokens : null;
}

/** 取消 git 的双引号 + C 风格转义；未加引号的原样返回。 */
export function unquoteGitPath(token: string): string {
  if (token.length < 2 || token[0] !== '"' || token[token.length - 1] !== '"') return token;
  let out = '';
  for (let i = 1; i < token.length - 1; i += 1) {
    const ch = token[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = token[++i] ?? '';
    if (next === 'n') out += '\n';
    else if (next === 't') out += '\t';
    else if (next === 'r') out += '\r';
    else if (next === '"') out += '"';
    else if (next === '\\') out += '\\';
    else if (/[0-7]/.test(next)) {
      // 八进制字节转义（git 对非 UTF-8 字节使用 \NNN）
      let octal = next;
      while (octal.length < 3 && /[0-7]/.test(token[i + 1] ?? '')) octal += token[++i];
      out += String.fromCharCode(Number.parseInt(octal, 8));
    } else out += next;
  }
  return out;
}

/** 判断是否为文件块起始行（diff 开头的文件指示行） */
function isFileHeader(line: string): boolean {
  return line.startsWith('diff --git ') && gitHeaderTokens(line.slice('diff --git '.length)) !== null;
}

/** 从文件头行提取新旧路径 */
function extractHeaderPaths(line: string): { prev: string; next: string } | null {
  const tokens = gitHeaderTokens(line.slice('diff --git '.length));
  if (!tokens) return null;
  const [from, to] = tokens as [string, string];
  const prev = from.startsWith('a/') ? from.slice(2) : from;
  const next = to.startsWith('b/') ? to.slice(2) : to;
  if (!prev || !next) return null;
  return { prev, next };
}

/**
 * 处理文件元信息行（new/deleted/rename）。返回更新后的 FileDiff 或 null。
 */
function fileDirective(line: string, file: FileDiff): FileDiff | null {
  if (line.startsWith('new file mode')) return { ...file, kind: 'added' };
  if (line.startsWith('deleted file mode')) return { ...file, kind: 'deleted' };
  if (line.startsWith('rename from ')) {
    return { ...file, kind: 'renamed', oldPath: unquoteGitPath(line.slice('rename from '.length).trim()) };
  }
  if (line.startsWith('rename to ')) {
    return { ...file, kind: 'renamed', path: unquoteGitPath(line.slice('rename to '.length).trim()) };
  }
  return null;
}

/**
 * 解析 unified diff 文本。无法识别的行被安全跳过，
 * 二进制文件标记会产生一个无 hunk 的记录。
 */
export function parseUnifiedDiff(diffText: string): ParsedDiff {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let currentHunk: DiffHunk | null = null;

  const lines = splitLines(diffText);
  for (const line of lines) {
    if (isFileHeader(line)) {
      const paths = extractHeaderPaths(line);
      current = {
        path: paths?.next ?? 'unknown',
        oldPath: paths?.prev ?? 'unknown',
        kind: 'modified',
        hunks: [],
        addedLines: 0,
        removedLines: 0,
      };
      files.push(current);
      currentHunk = null;
      continue;
    }
    if (!current) continue;

    const updated = fileDirective(line, current);
    if (updated) {
      current = updated;
      files[files.length - 1] = updated;
      continue;
    }

    const hunk = matchHunkHeader(line);
    if (hunk) {
      currentHunk = hunk;
      current.hunks.push(hunk);
      continue;
    }

    if (currentHunk) {
      const cls = classifyBodyLine(line);
      if (cls === 'add' || cls === 'del') {
        currentHunk.changes.push(cls === 'add' ? `+${line.slice(1)}` : `-${line.slice(1)}`);
        if (cls === 'add') current.addedLines += 1;
        else current.removedLines += 1;
      } else if (line.startsWith(' ') || line === '') {
        currentHunk.changes.push(` ${line.startsWith(' ') ? line.slice(1) : line}`);
      }
    }
  }

  return {
    files,
    totalAdded: files.reduce((n, f) => n + f.addedLines, 0),
    totalRemoved: files.reduce((n, f) => n + f.removedLines, 0),
  };
}

/** 匹配块头行（形如 @@ -a,b +c,d @@），手工解析两段数字 */
function matchHunkHeader(line: string): DiffHunk | null {
  if (!line.startsWith('@@')) return null;
  const closing = line.indexOf('@@', 2);
  const inner = closing > 2 ? line.slice(2, closing) : line.slice(2);
  const minusIdx = inner.indexOf('-');
  const plusIdx = inner.indexOf('+');
  if (minusIdx < 0 || plusIdx < 0) return null;
  const oldPart = inner.slice(minusIdx + 1, plusIdx).trim();
  const newPart = inner.slice(plusIdx + 1).trim();
  const ov = parseRangeSpec(oldPart);
  const nv = parseRangeSpec(newPart);
  if (!ov || !nv) return null;
  return { oldStart: ov.start, oldLines: ov.count, newStart: nv.start, newLines: nv.count, changes: [] };
}

/** 解析 "start" 或 "start,count" 形式的范围说明。count 缺省按 1 处理。 */
function parseRangeSpec(spec: string): { start: number; count: number } | null {
  const comma = spec.indexOf(',');
  const startRaw = comma < 0 ? spec.trim() : spec.slice(0, comma).trim();
  const countRaw = comma < 0 ? '1' : spec.slice(comma + 1).trim();
  const start = Number(startRaw);
  const count = Number(countRaw);
  if (!Number.isFinite(start) || !Number.isFinite(count)) return null;
  return { start, count };
}

/** 新增行在新文件中的行号列表（用于定位评审问题） */
export function addedLineNumbers(file: FileDiff): number[] {
  const numbers: number[] = [];
  for (const hunk of file.hunks) {
    let cursor = hunk.newStart;
    for (const change of hunk.changes) {
      if (change[0] === '+') {
        numbers.push(cursor);
        cursor += 1;
      } else if (change[0] !== '-') {
        cursor += 1;
      }
    }
  }
  return numbers;
}
