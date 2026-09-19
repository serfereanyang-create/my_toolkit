/**
 * namingRules.ts - Naming convention checks for exported symbols.
 *
 * Flags common style violations: non-camelCase functions, non-PascalCase
 * classes, non-UPPER_SNAKE constants, single-letter identifiers.
 */

import * as ts from 'typescript';
import { readFile } from 'node:fs/promises';
import { glob } from 'glob';

export type NamingKind =
  | 'function-not-camel'
  | 'class-not-pascal'
  | 'const-not-upper'
  | 'type-not-pascal'
  | 'single-letter'
  | 'underscore-prefix-misuse'
  | 'non-descriptive';

export interface NamingViolation {
  file: string;
  line: number;
  kind: NamingKind;
  name: string;
  message: string;
}

export interface NamingReport {
  scannedFiles: number;
  checked: number;
  violations: NamingViolation[];
  byKind: Record<string, number>;
}

const CAMEL_RE = /^[a-z][a-zA-Z0-9]*$/;
const PASCAL_RE = /^[A-Z][a-zA-Z0-9]*$/;
const UPPER_SNAKE_RE = /^[A-Z][A-Z0-9_]*$/;
const IGNORED_SHORT = new Set(['i', 'j', 'k', 'x', 'y', 'z', 'e', 'n', 'm', 'a', 'b', 'v', 't', 'f', 'p', 'q', 'r', 's', 'u', 'l', '_']);

function classifyFunction(name: string): NamingViolation['kind'] | null {
  if (name.startsWith('_') && name.length > 1) return null; // 私有前缀，放过
  if (!CAMEL_RE.test(name) && !PASCAL_RE.test(name)) return 'function-not-camel';
  return null;
}

function classifyClass(name: string): NamingViolation['kind'] | null {
  return PASCAL_RE.test(name) ? null : 'class-not-pascal';
}

function classifyConst(name: string, isExported: boolean): NamingViolation['kind'] | null {
  // 只对导出常量严格要求 UPPER_SNAKE；本地 const 只要合理长度即可
  if (isExported && !UPPER_SNAKE_RE.test(name) && !PASCAL_RE.test(name) && !CAMEL_RE.test(name)) {
    return 'const-not-upper';
  }
  if (name.length === 1 && !IGNORED_SHORT.has(name)) return 'single-letter';
  return null;
}

function classifyType(name: string): NamingViolation['kind'] | null {
  return PASCAL_RE.test(name) ? null : 'type-not-pascal';
}

export function analyzeNaming(filePath: string, source: string): NamingViolation[] {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: NamingViolation[] = [];

  function record(node: ts.Node, name: string, kind: NamingKind, message: string): void {
    out.push({
      file: filePath,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      kind,
      name,
      message,
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.text;
      const v = classifyFunction(name);
      if (v) record(node, name, v, `函数名应为 camelCase 或 PascalCase，当前: ${name}`);
    } else if (ts.isClassDeclaration(node) && node.name) {
      const name = node.name.text;
      const v = classifyClass(name);
      if (v) record(node, name, v, `类名应为 PascalCase，当前: ${name}`);
    } else if (ts.isVariableStatement(node)) {
      const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : [];
      const isExported = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      const isConst = Boolean(node.declarationList.flags & ts.NodeFlags.Const);
      if (isConst) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            const name = decl.name.text;
            const v = classifyConst(name, isExported);
            if (v) record(node, name, v, `常量命名不合规（${v}）：${name}`);
          }
        }
      }
    } else if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      const name = node.name.text;
      const v = classifyType(name);
      if (v) record(node, name, v, `类型/接口应为 PascalCase，当前: ${name}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return out;
}

export async function analyzeWorkspaceNaming(
  workspaceRoot: string,
  pattern: string,
  maxFiles: number,
): Promise<NamingReport> {
  const files = await glob(pattern, { cwd: workspaceRoot, nodir: true, absolute: true });
  const selected = files.slice(0, maxFiles);
  const all: NamingViolation[] = [];
  for (const file of selected) {
    let source: string;
    try {
      source = await readFile(file, 'utf-8');
    } catch {
      continue;
    }
    all.push(...analyzeNaming(file, source));
  }
  const byKind: Record<string, number> = {};
  for (const v of all) byKind[v.kind] = (byKind[v.kind] ?? 0) + 1;
  return {
    scannedFiles: selected.length,
    checked: all.length,
    violations: all,
    byKind,
  };
}
