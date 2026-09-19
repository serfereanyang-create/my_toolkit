/**
 * unusedExports.ts - Detect exported symbols that are never imported anywhere.
 *
 * Builds a two-pass picture: first collect every exported symbol per file,
 * then scan every source file's import statements; exports never referenced
 * elsewhere are flagged as unused candidates for removal or API rework.
 */

import * as ts from 'typescript';
import { readFile } from 'node:fs/promises';
import { glob } from 'glob';
import { relative, sep } from 'node:path';

export interface ExportedSymbol {
  file: string;
  exportedName: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'const' | 'default' | 'namespace' | 'other';
  line: number;
}

export interface UnusedExport extends ExportedSymbol {
  /** Number of files that import this name (usually 0 for candidates). */
  referencedBy: number;
}

export interface UnusedExportsReport {
  scannedFiles: number;
  exportedCount: number;
  unusedCount: number;
  unused: UnusedExport[];
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/** Collect all exported symbols from a single file. */
export function collectExports(filePath: string, source: string): ExportedSymbol[] {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: ExportedSymbol[] = [];

  function classify(node: ts.Node): ExportedSymbol['kind'] {
    if (ts.isFunctionDeclaration(node)) return 'function';
    if (ts.isClassDeclaration(node)) return 'class';
    if (ts.isInterfaceDeclaration(node)) return 'interface';
    if (ts.isTypeAliasDeclaration(node)) return 'type';
    if (ts.isVariableStatement(node)) return 'const';
    if (ts.isModuleDeclaration(node)) return 'namespace';
    return 'other';
  }

  function push(node: ts.Node, name: string): void {
    found.push({
      file: filePath,
      exportedName: name,
      kind: classify(node),
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
    });
  }

  function visit(node: ts.Node): void {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : [];
    const isExported = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

    if (isExported || isDefault) {
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) push(node, decl.name.text);
        }
      } else if (isDefault && (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))) {
        push(node, node.name?.text ?? 'default');
      } else if (
        (ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isModuleDeclaration(node) ||
          ts.isEnumDeclaration(node)) &&
        'name' in node &&
        node.name &&
        ts.isIdentifier(node.name as ts.Identifier)
      ) {
        push(node, (node.name as ts.Identifier).text);
      }
    }

    // export { a, b as c }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) {
        push(node, el.name.text);
      }
    }

    ts.forEachChild(node, visit);
  }
  visit(sf);
  return found;
}

/** Collect all imported identifiers per file (local alias names). */
export function collectImportedNames(source: string): Set<string> {
  const sf = ts.createSourceFile('m.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set<string>();
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause?.name) names.add(clause.name.text);
      if (clause?.namedBindings) {
        if (ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) names.add(el.name.text);
        } else if (ts.isNamespaceImport(clause.namedBindings)) {
          names.add(clause.namedBindings.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return names;
}

/** Workspace-wide scan: collect all exports, subtract imports, report unused. */
export async function findUnusedExports(
  workspaceRoot: string,
  pattern: string,
  maxFiles: number,
): Promise<UnusedExportsReport> {
  const files = await glob(pattern, { cwd: workspaceRoot, nodir: true, absolute: true });
  const selected = files.slice(0, maxFiles);

  const allExports: ExportedSymbol[] = [];
  const allImportedNames = new Set<string>();

  for (const file of selected) {
    let source: string;
    try {
      source = await readFile(file, 'utf-8');
    } catch {
      continue;
    }
    const rel = toPosix(relative(workspaceRoot, file));
    allExports.push(...collectExports(rel, source));
    for (const name of collectImportedNames(source)) allImportedNames.add(name);
  }

  const unused: UnusedExport[] = allExports
    .filter((exp) => !allImportedNames.has(exp.exportedName))
    .map((exp) => ({ ...exp, referencedBy: 0 }));

  return {
    scannedFiles: selected.length,
    exportedCount: allExports.length,
    unusedCount: unused.length,
    unused,
  };
}
