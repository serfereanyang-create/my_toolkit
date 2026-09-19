/**
 * unusedImports.ts - Detect imported identifiers never referenced in the file body.
 *
 * 收集每个 import 绑定的本地名字，然后在剩余 AST 中查找 Identifier usage
 * （排除 import 节点本身的绑定位置）。未被引用的 import 为可清理目标。
 */

import * as ts from 'typescript';
import { readFile } from 'node:fs/promises';
import { glob } from 'glob';

export interface UnusedImportInfo {
  file: string;
  line: number;
  /** 形如 `import { a, b } from './x'` 里的 a 或 b；命名空间/default import 同理 */
  localName: string;
  moduleSpecifier: string;
  kind: 'named' | 'default' | 'namespace';
}

export interface UnusedImportsReport {
  scannedFiles: number;
  totalImports: number;
  unusedCount: number;
  unused: UnusedImportInfo[];
  byFile: Array<{ file: string; count: number }>;
}

interface Binding {
  localName: string;
  kind: 'named' | 'default' | 'namespace';
  node: ts.Node;
  moduleSpecifier: string;
}

function bindingsOf(node: ts.ImportDeclaration): Binding[] {
  const out: Binding[] = [];
  const clause = node.importClause;
  if (!clause) return out;
  const spec = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : '';
  if (clause.name) {
    out.push({ localName: clause.name.text, kind: 'default', node: clause.name, moduleSpecifier: spec });
  }
  if (clause.namedBindings) {
    if (ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        out.push({ localName: el.name.text, kind: 'named', node: el.name, moduleSpecifier: spec });
      }
    } else if (ts.isNamespaceImport(clause.namedBindings)) {
      out.push({
        localName: clause.namedBindings.name.text,
        kind: 'namespace',
        node: clause.namedBindings.name,
        moduleSpecifier: spec,
      });
    }
  }
  return out;
}

/** 收集 AST 中所有非 import 位置出现的 Identifier 文本 */
function collectUsedIdentifiers(root: ts.Node): Set<string> {
  const used = new Set<string>();
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) return; // skip binding positions
    if (ts.isIdentifier(node)) used.add(node.text);
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(root, visit);
  return used;
}

export function analyzeFileUnusedImports(filePath: string, source: string): UnusedImportInfo[] {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const used = collectUsedIdentifiers(sf);
  const out: UnusedImportInfo[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      for (const b of bindingsOf(node)) {
        if (!used.has(b.localName)) {
          out.push({
            file: filePath,
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            localName: b.localName,
            moduleSpecifier: b.moduleSpecifier,
            kind: b.kind,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return out;
}

export async function findUnusedImports(
  workspaceRoot: string,
  pattern: string,
  maxFiles: number,
): Promise<UnusedImportsReport> {
  const files = await glob(pattern, { cwd: workspaceRoot, nodir: true, absolute: true });
  const selected = files.slice(0, maxFiles);

  const all: UnusedImportInfo[] = [];
  for (const file of selected) {
    let source: string;
    try {
      source = await readFile(file, 'utf-8');
    } catch {
      continue;
    }
    all.push(...analyzeFileUnusedImports(file, source));
  }

  const byFileMap = new Map<string, number>();
  for (const it of all) byFileMap.set(it.file, (byFileMap.get(it.file) ?? 0) + 1);
  const byFile = [...byFileMap.entries()]
    .map(([file, count]) => ({ file, count }))
    .sort((a, b) => b.count - a.count);

  return {
    scannedFiles: selected.length,
    totalImports: 0, // 由调用方另行聚合；此处只专注 unused
    unusedCount: all.length,
    unused: all,
    byFile,
  };
}
