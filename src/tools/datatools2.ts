import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { pathScopeFor, resolveReadablePath, resolveWorkspacePath } from '../safety/policy.js';
import { lineDiff } from './lineDiff.js';
import { parseCsv, writeCsv } from './csv.js';
import type { ToolDefinition } from './types.js';

/*
 * datatools2 — high-value tools that mainstream coding agents (Claude Code,
 * Cursor, Codex) expose and this CLI was missing. Every tool reuses existing,
 * already-tested machinery (resolveReadablePath / resolveWorkspacePath for path
 * safety, lineDiff for real diff counts, parseCsv / writeCsv for CSV I/O,
 * checkpoints for undo) rather than reinventing it.
 */

// ---------- read_many_files: batch read to save round-trips ----------

export const readManyFilesTool: ToolDefinition<{ paths: string[]; maxBytesEach: number }> = {
  name: 'read_many_files',
  description:
    'Read several files in one call and return their contents concatenated with clear per-file headers. Use instead of many read_file calls when you need to inspect multiple files at once.',
  inputHint: '{ "paths": ["src/a.ts", "src/b.ts"], "maxBytesEach": 50000 }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (!Array.isArray(record.paths) || record.paths.length === 0) throw new Error('paths must be a non-empty array');
    const paths = record.paths.map((p) => String(p)).slice(0, 50);
    const maxBytesEach = typeof record.maxBytesEach === 'number' && record.maxBytesEach > 0 ? Math.min(Math.floor(record.maxBytesEach), 500_000) : 50_000;
    return { paths, maxBytesEach };
  },
  async execute(input, context) {
    const sections: string[] = [];
    let okCount = 0;
    for (const rawPath of input.paths) {
      try {
        const target = resolveReadablePath(context.workspaceRoot, rawPath, pathScopeFor(context.approval));
        const content = await readFile(target, 'utf8');
        const clipped = content.length > input.maxBytesEach ? `${content.slice(0, input.maxBytesEach)}\n[...truncated]` : content;
        sections.push(`===== ${rawPath} =====\n${clipped}`);
        okCount += 1;
      } catch (error) {
        sections.push(`===== ${rawPath} =====\n[error: ${error instanceof Error ? error.message : String(error)}]`);
      }
    }
    return { ok: okCount > 0, output: sections.join('\n\n'), data: { files: input.paths.length, ok: okCount } };
  },
};

// ---------- glob_files: glob pattern matching ----------

export const globFilesTool: ToolDefinition<{ pattern: string; path: string; maxResults: number }> = {
  name: 'glob_files',
  description:
    'Find files by a glob pattern (e.g. "**/*.ts", "src/**/*.test.*"). Returns workspace-relative paths. Supports * (any chars except /), ** (any depth), and ? (single char).',
  inputHint: '{ "pattern": "src/**/*.ts", "path": ".", "maxResults": 200 }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.pattern !== 'string' || !record.pattern.trim()) throw new Error('pattern is required');
    const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : '.';
    const maxResults = typeof record.maxResults === 'number' && record.maxResults > 0 ? Math.min(Math.floor(record.maxResults), 2000) : 200;
    return { pattern: record.pattern.trim(), path, maxResults };
  },
  async execute(input, context) {
    const root = resolveReadablePath(context.workspaceRoot, input.path, pathScopeFor(context.approval));
    const regex = globToRegExp(input.pattern);
    const matches: string[] = [];
    await walkFiles(root, root, regex, matches, input.maxResults);
    return {
      ok: true,
      output: matches.length ? matches.join('\n') : `No files match ${input.pattern}`,
      data: { pattern: input.pattern, matches: matches.length },
    };
  },
};

const IGNORED_WALK_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.aicode', '.aicode-smoke', '.gradle']);

async function walkFiles(current: string, root: string, regex: RegExp, out: string[], limit: number): Promise<void> {
  if (out.length >= limit) return;
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= limit) return;
    const full = join(current, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_WALK_DIRS.has(entry.name)) continue;
      await walkFiles(full, root, regex, out, limit);
    } else {
      const rel = relative(root, full).replace(/\\/g, '/');
      if (regex.test(rel)) out.push(rel);
    }
  }
}

// Convert a glob to a RegExp. ** = any depth, * = any chars except /, ? = one char.
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1; // consume slash after **
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

// ---------- diff_files: compare two files with real line counts ----------

export const diffFilesTool: ToolDefinition<{ left: string; right: string }> = {
  name: 'diff_files',
  description: 'Compare two text files and report added/removed line counts plus a unified-style preview of the differing lines.',
  inputHint: '{ "left": "old.txt", "right": "new.txt" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.left !== 'string' || typeof record.right !== 'string') throw new Error('left and right paths are required');
    return { left: record.left.trim(), right: record.right.trim() };
  },
  async execute(input, context) {
    const leftText = await readFile(resolveReadablePath(context.workspaceRoot, input.left, pathScopeFor(context.approval)), 'utf8');
    const rightText = await readFile(resolveReadablePath(context.workspaceRoot, input.right, pathScopeFor(context.approval)), 'utf8');
    const { added, removed } = lineDiff(leftText, rightText);
    const preview = unifiedPreview(leftText.split(/\r?\n/), rightText.split(/\r?\n/), 40);
    return {
      ok: true,
      output: `+${added} -${removed}\n${preview}`,
      data: { left: input.left, right: input.right, added, removed },
    };
  },
};

function unifiedPreview(a: string[], b: string[], maxLines: number): string {
  const out: string[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max && out.length < maxLines; i += 1) {
    if (a[i] !== b[i]) {
      if (a[i] !== undefined) out.push(`- ${a[i]}`);
      if (b[i] !== undefined) out.push(`+ ${b[i]}`);
    }
  }
  if (out.length >= maxLines) out.push('[...preview truncated]');
  return out.join('\n') || '(files are identical)';
}

// ---------- edit_lines: insert / replace / delete a line range ----------

export const editLinesTool: ToolDefinition<{ path: string; start: number; end: number; mode: 'replace' | 'insert' | 'delete'; text: string }> = {
  name: 'edit_lines',
  description:
    'Edit a file by line number: replace lines [start,end], insert before `start`, or delete lines [start,end]. Line numbers are 1-based. Use for surgical edits when apply_patch is awkward.',
  inputHint: '{ "path": "src/a.ts", "start": 10, "end": 12, "mode": "replace", "text": "new line\\nnext line" }',
  risk: 'write',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.path !== 'string' || !record.path.trim()) throw new Error('path is required');
    const mode = record.mode === 'insert' || record.mode === 'delete' ? record.mode : 'replace';
    const start = typeof record.start === 'number' && record.start >= 1 ? Math.floor(record.start) : 1;
    const end = typeof record.end === 'number' && record.end >= start ? Math.floor(record.end) : start;
    const text = typeof record.text === 'string' ? record.text : '';
    return { path: record.path.trim(), start, end, mode, text };
  },
  async execute(input, context) {
    const target = resolveWorkspacePath(context.workspaceRoot, input.path, pathScopeFor(context.approval));
    let before = '';
    try {
      before = await readFile(target, 'utf8');
    } catch {
      before = '';
    }
    const lines = before === '' ? [] : before.replace(/\r\n/g, '\n').split('\n');
    const startIdx = input.start - 1;
    const endIdx = input.end; // exclusive slice end
    const newLines = input.text === '' ? [] : input.text.replace(/\r\n/g, '\n').split('\n');

    let result: string[];
    if (input.mode === 'insert') {
      result = [...lines.slice(0, startIdx), ...newLines, ...lines.slice(startIdx)];
    } else if (input.mode === 'delete') {
      result = [...lines.slice(0, startIdx), ...lines.slice(endIdx)];
    } else {
      result = [...lines.slice(0, startIdx), ...newLines, ...lines.slice(endIdx)];
    }
    const after = result.join('\n');
    const checkpoint = await context.checkpoints?.beforeWrite(target);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, after, 'utf8');
    await context.checkpoints?.confirm(checkpoint);
    const { added, removed } = lineDiff(before, after);
    return {
      ok: true,
      output: `Edited ${input.path} (${input.mode}, +${added} -${removed})`,
      data: { path: target, mode: input.mode, added, removed, checkpointId: checkpoint?.id },
    };
  },
};

// ---------- write_json: write a structured JSON file ----------

export const writeJsonTool: ToolDefinition<{ path: string; value: unknown; pretty: boolean }> = {
  name: 'write_json',
  description: 'Write a value as a JSON file (pretty-printed by default). Use for creating or overwriting config/data files with structured content.',
  inputHint: '{ "path": "data/out.json", "value": { "a": 1 }, "pretty": true }',
  risk: 'write',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.path !== 'string' || !record.path.trim()) throw new Error('path is required');
    if (!('value' in record)) throw new Error('value is required');
    return { path: record.path.trim(), value: record.value, pretty: record.pretty !== false };
  },
  async execute(input, context) {
    const target = resolveWorkspacePath(context.workspaceRoot, input.path, pathScopeFor(context.approval));
    const serialized = JSON.stringify(input.value, null, input.pretty ? 2 : 0);
    let before = '';
    try {
      before = await readFile(target, 'utf8');
    } catch {
      before = '';
    }
    const checkpoint = await context.checkpoints?.beforeWrite(target);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${serialized}\n`, 'utf8');
    await context.checkpoints?.confirm(checkpoint);
    const { added, removed } = lineDiff(before, `${serialized}\n`);
    return { ok: true, output: `Wrote JSON ${input.path} (+${added} -${removed})`, data: { path: target, added, removed, checkpointId: checkpoint?.id } };
  },
};

// ---------- format_json: pretty-print or minify a JSON string ----------

export const formatJsonTool: ToolDefinition<{ json: string; minify: boolean }> = {
  name: 'format_json',
  description: 'Pretty-print (default) or minify a JSON string and return the result. Validates the JSON and reports parse errors.',
  inputHint: '{ "json": "{\\"a\\":1}", "minify": false }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.json !== 'string' || !record.json.trim()) throw new Error('json is required');
    return { json: record.json, minify: record.minify === true };
  },
  async execute(input) {
    try {
      const parsed = JSON.parse(input.json);
      const out = JSON.stringify(parsed, null, input.minify ? 0 : 2);
      return { ok: true, output: out, data: { minified: input.minify, bytes: Buffer.byteLength(out) } };
    } catch (error) {
      return { ok: false, output: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, data: {} };
    }
  },
};

// ---------- json_to_csv: convert a JSON array of objects to CSV ----------

export const jsonToCsvTool: ToolDefinition<{ json: string; headers?: string[] }> = {
  name: 'json_to_csv',
  description: 'Convert a JSON array of flat objects (or array of arrays) into CSV text. Column order comes from the first object keys or an explicit headers array.',
  inputHint: '{ "json": "[{\\"name\\":\\"a\\",\\"n\\":1}]", "headers": ["name","n"] }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.json !== 'string' || !record.json.trim()) throw new Error('json is required');
    const headers = Array.isArray(record.headers) ? record.headers.map((h) => String(h)) : undefined;
    return { json: record.json, headers };
  },
  async execute(input) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.json);
    } catch (error) {
      return { ok: false, output: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, data: {} };
    }
    if (!Array.isArray(parsed)) return { ok: false, output: 'JSON must be an array (of objects or arrays).', data: {} };
    const matrix = jsonArrayToMatrix(parsed, input.headers);
    const csv = writeCsv(matrix);
    return { ok: true, output: csv, data: { rows: matrix.length } };
  },
};

function jsonArrayToMatrix(rows: unknown[], explicitHeaders?: string[]): (string | number | boolean | null)[][] {
  if (rows.length === 0) return [];
  const first = rows[0];
  if (Array.isArray(first)) {
    return rows.map((r) => (Array.isArray(r) ? r.map(cellify) : [cellify(r)]));
  }
  const headers = explicitHeaders ?? Object.keys(first as Record<string, unknown>);
  const out: (string | number | boolean | null)[][] = [headers];
  for (const row of rows) {
    const rec = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
    out.push(headers.map((h) => cellify(rec[h])));
  }
  return out;
}

function cellify(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value;
  return JSON.stringify(value);
}

// ---------- csv_to_json: convert CSV text to a JSON array of objects ----------

export const csvToJsonTool: ToolDefinition<{ csv: string; header: boolean }> = {
  name: 'csv_to_json',
  description: 'Parse CSV text into JSON. With header=true (default) the first row becomes object keys; otherwise returns an array of arrays.',
  inputHint: '{ "csv": "name,n\\na,1", "header": true }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.csv !== 'string' || record.csv === '') throw new Error('csv is required');
    return { csv: record.csv, header: record.header !== false };
  },
  async execute(input) {
    const matrix = parseCsv(input.csv);
    if (!input.header) return { ok: true, output: JSON.stringify(matrix, null, 2), data: { rows: matrix.length } };
    if (matrix.length === 0) return { ok: true, output: '[]', data: { rows: 0 } };
    const [headers, ...rows] = matrix;
    const objects = rows.map((row) => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => { obj[h] = row[i] ?? ''; });
      return obj;
    });
    return { ok: true, output: JSON.stringify(objects, null, 2), data: { rows: objects.length } };
  },
};

// ---------- list_tree: directory tree view ----------

export const listTreeTool: ToolDefinition<{ path: string; maxDepth: number; maxEntries: number }> = {
  name: 'list_tree',
  description: 'Render a directory as an indented tree (like the `tree` command), skipping node_modules/.git/dist. Good for understanding project layout.',
  inputHint: '{ "path": ".", "maxDepth": 3, "maxEntries": 300 }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : '.';
    const maxDepth = typeof record.maxDepth === 'number' && record.maxDepth >= 1 ? Math.min(Math.floor(record.maxDepth), 8) : 3;
    const maxEntries = typeof record.maxEntries === 'number' && record.maxEntries > 0 ? Math.min(Math.floor(record.maxEntries), 2000) : 300;
    return { path, maxDepth, maxEntries };
  },
  async execute(input, context) {
    const root = resolveReadablePath(context.workspaceRoot, input.path, pathScopeFor(context.approval));
    const lines: string[] = [];
    const counter = { n: 0 };
    await treeInto(root, '', 0, input.maxDepth, input.maxEntries, lines, counter);
    return { ok: true, output: lines.join('\n') || '(empty)', data: { entries: counter.n } };
  },
};

async function treeInto(dir: string, prefix: string, depth: number, maxDepth: number, maxEntries: number, out: string[], counter: { n: number }): Promise<void> {
  if (depth >= maxDepth || counter.n >= maxEntries) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
  for (let i = 0; i < entries.length; i += 1) {
    if (counter.n >= maxEntries) return;
    const entry = entries[i];
    if (entry.isDirectory() && IGNORED_WALK_DIRS.has(entry.name)) continue;
    const last = i === entries.length - 1;
    out.push(`${prefix}${last ? '└─ ' : '├─ '}${entry.name}${entry.isDirectory() ? '/' : ''}`);
    counter.n += 1;
    if (entry.isDirectory()) {
      await treeInto(join(dir, entry.name), `${prefix}${last ? '   ' : '│  '}`, depth + 1, maxDepth, maxEntries, out, counter);
    }
  }
}
