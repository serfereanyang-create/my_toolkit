/**
 * Reusable TypeScript-compiler language service.
 *
 * A single cached `ts.LanguageService` per workspace root, created from the
 * project's tsconfig.json (or an inferred NodeNext project when absent) and
 * reused across queries; edited files reload by mtime so results stay fresh.
 *
 * This is the shared engine behind BOTH the agent tools (ts_hover /
 * ts_goto_definition / ts_exact_references) and the desktop language bridge
 * that powers editor hover / go-to-definition / find-references / completions.
 *
 * All positions are 1-based line/column at the API boundary. Offsets are
 * computed against the raw file text (CRLF included) so they stay correct on
 * Windows checkouts.
 */

import * as ts from 'typescript';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

type FileEntry = { text: string; mtimeMs: number };

type ServiceEntry = {
  service: ts.LanguageService;
  files: Map<string, FileEntry>;
  serviced: Set<string>;
};

export type Position = { line: number; column: number };
export type Range = { line: number; column: number; endLine: number; endColumn: number };

export type HoverResult = {
  type: string;
  documentation: string;
  path: string;
  range: Range;
} | null;

export type DefinitionResult = Array<{ path: string; range: Range }>;

export type ReferenceResult = Array<{
  path: string;
  range: Range;
  isDefinition: boolean;
  lineText: string;
}>;

export type CompletionItem = {
  label: string;
  kind: string;
  detail?: string;
  insertText: string;
};

const serviceCache = new Map<string, ServiceEntry>();

function fileVersion(entry: FileEntry): string {
  return `${entry.mtimeMs}`;
}

function loadEntry(absolutePath: string): FileEntry {
  const stat = statSync(absolutePath);
  return { text: readFileSync(absolutePath, 'utf8'), mtimeMs: stat.mtimeMs };
}

function statSyncSafe(path: string): { mtimeMs: number } | undefined {
  try { const s = statSync(path); return { mtimeMs: s.mtimeMs }; } catch { return undefined; }
}

function createService(workspaceRoot: string): ServiceEntry {
  const configFile = join(workspaceRoot, 'tsconfig.json');
  let fileNames: string[] | undefined;
  // Inferred-project defaults MUST use NodeNext resolution: modern TS repos
  // import with '.js' specifiers that map to '.ts' sources only under NodeNext.
  let compilerOptions: ts.CompilerOptions = {
    allowJs: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
    skipLibCheck: true,
    resolveJsonModule: true,
  };

  if (existsSync(configFile)) {
    try {
      const raw = ts.readConfigFile(configFile, (name) => readFileSync(name, 'utf8'));
      const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, workspaceRoot);
      // Cap the program: strip node_modules/outDir globs so first build stays bounded.
      fileNames = parsed.fileNames.filter((name) => !/node_modules|dist[\\/]|build[\\/]/.test(name));
      compilerOptions = { ...parsed.options, noEmit: true };
    } catch { /* fall through to inferred project */ }
  }

  const files = new Map<string, FileEntry>();
  const serviced = new Set<string>();

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => (fileNames ? [...new Set([...fileNames, ...serviced])] : [...serviced]),
    getScriptVersion: (name) => {
      const entry = files.get(name);
      return entry ? fileVersion(entry) : '';
    },
    getScriptSnapshot: (name) => {
      let entry = files.get(name);
      if (!entry || statSyncSafe(name)?.mtimeMs !== entry.mtimeMs) {
        try { entry = loadEntry(name); files.set(name, entry); } catch { return undefined; }
      }
      return ts.ScriptSnapshot.fromString(entry.text);
    },
    getCurrentDirectory: () => workspaceRoot,
    getCompilationSettings: () => compilerOptions,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    readDirectory: ts.sys.readDirectory,
    readFile: ts.sys.readFile,
    fileExists: ts.sys.fileExists,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };

  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  return { service, files, serviced };
}

function getService(workspaceRoot: string): ServiceEntry {
  const root = resolve(workspaceRoot);
  let cached = serviceCache.get(root);
  if (!cached) {
    cached = createService(root);
    serviceCache.set(root, cached);
  }
  return cached;
}

/** Resolve a user path (absolute or workspace-relative) and load it into the service. */
export function ensureFile(workspaceRoot: string, rawPath: string): { entry: ServiceEntry; absolutePath: string } {
  const absolutePath = isAbsolute(rawPath) || /^[A-Za-z]:[\\/]/.test(rawPath)
    ? resolve(rawPath)
    : resolve(workspaceRoot, rawPath);
  if (!existsSync(absolutePath)) throw new Error(`File not found: ${rawPath}`);
  const entry = getService(workspaceRoot);
  entry.files.set(absolutePath, loadEntry(absolutePath));
  entry.serviced.add(absolutePath);
  entry.service.getProgram()!.getSourceFile(absolutePath); // ensure in program
  return { entry, absolutePath };
}

function fileText(entry: ServiceEntry, absolutePath: string): string {
  let file = entry.files.get(absolutePath);
  if (!file) { file = loadEntry(absolutePath); entry.files.set(absolutePath, file); }
  return file.text;
}

/** 1-based line/column -> absolute character offset, CRLF-correct. */
function offsetAt(entry: ServiceEntry, absolutePath: string, line: number, column: number): number {
  const text = fileText(entry, absolutePath);
  const rawLines = text.split('\n');
  const lineText = (rawLines[line - 1] ?? '').replace(/\r$/, '');
  let offset = 0;
  for (let i = 0; i < line - 1; i += 1) offset += rawLines[i].length + 1; // +1 for the \n
  return offset + Math.min(Math.max(column - 1, 0), lineText.length);
}

/** Character span -> 1-based range, CRLF-correct (split on raw \n). */
function spanToRange(entry: ServiceEntry, absolutePath: string, start: number, end: number): Range {
  const text = fileText(entry, absolutePath);
  const upToStart = text.slice(0, start).split('\n');
  const line = upToStart.length;
  const column = (upToStart.at(-1)?.replace(/\r$/, '').length ?? 0) + 1;
  const upToEnd = text.slice(0, end).split('\n');
  return { line, column, endLine: upToEnd.length, endColumn: (upToEnd.at(-1)?.replace(/\r$/, '').length ?? 0) + 1 };
}

/** Workspace-relative POSIX path when inside the root, else the absolute POSIX path. */
export function relPath(workspaceRoot: string, absolutePath: string): string {
  const root = resolve(workspaceRoot);
  const target = resolve(absolutePath);
  const candidate = relative(root, target);
  const outside = candidate === '..' || candidate.startsWith(`..${sep}`) || isAbsolute(candidate);
  return (outside ? target : candidate).replace(/\\/g, '/');
}

export function hoverAt(workspaceRoot: string, rawPath: string, line: number, column: number): HoverResult {
  const { entry, absolutePath } = ensureFile(workspaceRoot, rawPath);
  const offset = offsetAt(entry, absolutePath, line, column);
  const info = entry.service.getQuickInfoAtPosition(absolutePath, offset);
  if (!info) return null;
  return {
    type: ts.displayPartsToString(info.displayParts),
    documentation: ts.displayPartsToString(info.documentation),
    path: relPath(workspaceRoot, absolutePath),
    range: spanToRange(entry, absolutePath, info.textSpan.start, info.textSpan.start + info.textSpan.length),
  };
}

export function definitionAt(workspaceRoot: string, rawPath: string, line: number, column: number): DefinitionResult {
  const { entry, absolutePath } = ensureFile(workspaceRoot, rawPath);
  const offset = offsetAt(entry, absolutePath, line, column);
  const defs = entry.service.getDefinitionAtPosition(absolutePath, offset);
  if (!defs?.length) return [];
  return defs.map((def) => ({
    path: relPath(workspaceRoot, def.fileName),
    range: spanToRange(entry, def.fileName, def.textSpan.start, def.textSpan.start + def.textSpan.length),
  }));
}

export function referencesAt(workspaceRoot: string, rawPath: string, line: number, column: number): ReferenceResult {
  const { entry, absolutePath } = ensureFile(workspaceRoot, rawPath);
  const offset = offsetAt(entry, absolutePath, line, column);
  const refs = entry.service.getReferencesAtPosition(absolutePath, offset);
  if (!refs?.length) return [];
  return refs.map((ref) => {
    const range = spanToRange(entry, ref.fileName, ref.textSpan.start, ref.textSpan.start + ref.textSpan.length);
    const lineText = fileText(entry, ref.fileName).split(/\r?\n/)[range.line - 1]?.trim() ?? '';
    return {
      path: relPath(workspaceRoot, ref.fileName),
      range,
      isDefinition: (ref as { isDefinition?: boolean }).isDefinition === true,
      lineText: lineText.slice(0, 200),
    };
  });
}

export function completionsAt(
  workspaceRoot: string,
  rawPath: string,
  line: number,
  column: number,
  limit = 80,
): CompletionItem[] {
  const { entry, absolutePath } = ensureFile(workspaceRoot, rawPath);
  const offset = offsetAt(entry, absolutePath, line, column);
  const completions = entry.service.getCompletionsAtPosition(absolutePath, offset, {
    includeCompletionsForModuleExports: false,
    includeCompletionsWithInsertText: true,
  });
  if (!completions?.entries?.length) return [];
  return completions.entries.slice(0, limit).map((item) => ({
    label: item.name,
    kind: item.kind,
    detail: item.kindModifiers || undefined,
    insertText: item.insertText ?? item.name,
  }));
}
