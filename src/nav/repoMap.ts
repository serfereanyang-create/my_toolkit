import { lstat, readdir, readFile, stat, writeFile, readFile as readCache, mkdir } from 'node:fs/promises';
import { join, relative, extname, dirname } from 'node:path';
import * as ts from 'typescript';
import { isIgnoredDirName } from '../workspace/ignored.js';

export interface RepositoryMap {
  version: 1;
  generated: number;
  root: string;
  summary: {
    totalFiles: number;
    totalLines: number;
    languages: Record<string, number>;
  };
  modules: ModuleEntry[];
}

export interface ModuleEntry {
  path: string;
  kind: 'module' | 'config';
  exports: string[];
  imports: string[];
  lines: number;
  description?: string;
}

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const CONFIG_FILES = new Set(['package.json', 'tsconfig.json', 'vite.config.ts', 'webpack.config.js']);

/**
 * Build a repository map: module structure, exports, imports for TS/JS files.
 * Cached in .aicode/repo-map.json for 24h.
 */
export async function buildRepositoryMap(workspaceRoot: string, maxFiles = 5000): Promise<RepositoryMap> {
  const files: string[] = [];
  const modules: ModuleEntry[] = [];
  const languages: Record<string, number> = {};
  let totalLines = 0;

  await walkFiles(workspaceRoot, workspaceRoot, files, maxFiles);

  for (const filePath of files) {
    const absolutePath = join(workspaceRoot, filePath);
    const ext = extname(filePath);
    languages[ext] = (languages[ext] || 0) + 1;

    if (!TS_EXTENSIONS.has(ext)) continue;

    try {
      const content = await readFile(absolutePath, 'utf8');
      const lines = content.split('\n').length;
      totalLines += lines;

      const entry = parseModuleEntry(filePath, content, lines);
      if (entry) modules.push(entry);
    } catch {
      // Skip unreadable files
    }
  }

  return {
    version: 1,
    generated: Date.now(),
    root: workspaceRoot,
    summary: {
      totalFiles: files.length,
      totalLines,
      languages,
    },
    modules,
  };
}

async function walkFiles(current: string, root: string, files: string[], maxFiles: number): Promise<void> {
  if (files.length >= maxFiles) return;

  try {
    const info = await lstat(current);
    if (info.isSymbolicLink()) return;
    if (info.isFile()) {
      files.push(relative(root, current).replace(/\\/g, '/'));
      return;
    }

    if (!info.isDirectory()) return;

    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const name = entry.name;
      // Skip common large/generated directories through the shared list. The
      // old `name.startsWith('.')` rule below still hides dot-directories (so
      // `.github` stays out); routing caches through the list means the
      // `.aicode*` family is skipped here for the same reason as everywhere
      // else, not only because it happens to start with a dot.
      if (isIgnoredDirName(name)) continue;
      if (name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) continue; // junction cycles recurse forever

      const fullPath = join(current, name);
      if (entry.isDirectory()) {
        await walkFiles(fullPath, root, files, maxFiles);
      } else {
        files.push(relative(root, fullPath).replace(/\\/g, '/'));
      }
    }
  } catch {
    // Skip permission errors
  }
}

function parseModuleEntry(filePath: string, content: string, lines: number): ModuleEntry | null {
  const fileName = filePath.split('/').pop() || '';
  const kind: 'module' | 'config' = CONFIG_FILES.has(fileName) ? 'config' : 'module';

  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const exports: string[] = [];
  const imports: string[] = [];

  function visit(node: ts.Node) {
    // Extract exports
    if (ts.isFunctionDeclaration(node) && node.name && hasExportModifier(node)) {
      exports.push(node.name.text);
    } else if (ts.isClassDeclaration(node) && node.name && hasExportModifier(node)) {
      exports.push(node.name.text);
    } else if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      node.declarationList.declarations.forEach((decl) => {
        if (ts.isIdentifier(decl.name)) exports.push(decl.name.text);
      });
    } else if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      node.exportClause.elements.forEach((element) => {
        exports.push(element.name.text);
      });
    }

    // Extract imports
    if (ts.isImportDeclaration(node) && node.importClause) {
      const clause = node.importClause;
      if (clause.name) imports.push(clause.name.text);
      if (clause.namedBindings) {
        if (ts.isNamedImports(clause.namedBindings)) {
          clause.namedBindings.elements.forEach((element) => {
            imports.push(element.name.text);
          });
        } else if (ts.isNamespaceImport(clause.namedBindings)) {
          imports.push(clause.namedBindings.name.text);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  // Only include files with exports (skip pure scripts)
  if (exports.length === 0 && kind === 'module') return null;

  return {
    path: filePath,
    kind,
    exports: [...new Set(exports)].slice(0, 20), // Deduplicate and limit
    imports: [...new Set(imports)].slice(0, 30),
    lines,
  };
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/**
 * Load cached repository map if fresh (<24h), otherwise rebuild.
 */
export async function loadOrBuildRepositoryMap(workspaceRoot: string, forceRefresh = false): Promise<RepositoryMap> {
  const cachePath = join(workspaceRoot, '.aicode', 'repo-map.json');

  if (!forceRefresh) {
    try {
      const cached = JSON.parse(await readCache(cachePath, 'utf8')) as RepositoryMap;
      const age = Date.now() - cached.generated;
      if (age < 24 * 60 * 60 * 1000) return cached; // 24h cache
    } catch {
      // Cache miss or parse error, rebuild
    }
  }

  const map = await buildRepositoryMap(workspaceRoot);

  try {
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(map, null, 2), 'utf8');
  } catch {
    // Cache write failed, continue without cache
  }

  return map;
}
