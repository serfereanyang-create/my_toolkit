/**
 * classMetrics.ts — 类级别质量度量
 *
 * 统计 class 的：
 *  - 方法数 / 属性数 / getter/setter 数
 *  - 公开 / 私有 比例
 *  - 类的总代码行数
 *  - 继承深度（extends 链长度估算）
 *
 * 用于找"上帝类"与过深的继承树。
 */

import * as ts from 'typescript';
import { readFile } from 'node:fs/promises';
import { glob } from 'glob';

export interface ClassMetric {
  file: string;
  className: string;
  line: number;
  linesOfCode: number;
  methodCount: number;
  propertyCount: number;
  getterCount: number;
  setterCount: number;
  publicMembers: number;
  privateMembers: number;
  protectedMembers: number;
  /** extends 目标，无继承为 null */
  extends: string | null;
  implementsCount: number;
}

export interface ClassMetricsReport {
  scannedFiles: number;
  totalClasses: number;
  classes: ClassMetric[];
  /** 按属性+方法总数倒序 */
  largest: ClassMetric[];
  /** 实现的接口总数最多的类 */
  mostImplemented: ClassMetric[];
}

function visibilityOf(member: ts.ClassElement): 'public' | 'private' | 'protected' {
  if (!ts.canHaveModifiers(member)) return 'public';
  const mods = ts.getModifiers(member) ?? [];
  if (mods.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)) return 'private';
  if (mods.some((m) => m.kind === ts.SyntaxKind.ProtectedKeyword)) return 'protected';
  return 'public';
}

export function analyzeClassMetrics(filePath: string, source: string): ClassMetric[] {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: ClassMetric[] = [];

  function visit(node: ts.Node): void {
    if (ts.isClassDeclaration(node)) {
      const name = node.name?.text ?? '<anonymous>';
      const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;

      let methods = 0;
      let props = 0;
      let getters = 0;
      let setters = 0;
      let pub = 0;
      let priv = 0;
      let prot = 0;

      for (const member of node.members) {
        if (ts.isMethodDeclaration(member)) methods += 1;
        else if (ts.isPropertyDeclaration(member)) props += 1;
        else if (ts.isGetAccessorDeclaration(member)) getters += 1;
        else if (ts.isSetAccessorDeclaration(member)) setters += 1;
        else continue;
        const vis = visibilityOf(member);
        if (vis === 'public') pub += 1;
        else if (vis === 'private') priv += 1;
        else prot += 1;
      }

      let extendsName: string | null = null;
      let implementsCount = 0;
      if (node.heritageClauses) {
        for (const clause of node.heritageClauses) {
          if (clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types[0]) {
            extendsName = clause.types[0].expression.getText(sf);
          } else if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
            implementsCount = clause.types.length;
          }
        }
      }

      out.push({
        file: filePath,
        className: name,
        line: startLine,
        linesOfCode: Math.max(1, endLine - startLine + 1),
        methodCount: methods,
        propertyCount: props,
        getterCount: getters,
        setterCount: setters,
        publicMembers: pub,
        privateMembers: priv,
        protectedMembers: prot,
        extends: extendsName,
        implementsCount,
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return out;
}

export async function analyzeWorkspaceClasses(
  workspaceRoot: string,
  pattern: string,
  maxFiles: number,
): Promise<ClassMetricsReport> {
  const files = await glob(pattern, { cwd: workspaceRoot, nodir: true, absolute: true });
  const selected = files.slice(0, maxFiles);
  const all: ClassMetric[] = [];
  for (const file of selected) {
    let source: string;
    try {
      source = await readFile(file, 'utf-8');
    } catch {
      continue;
    }
    all.push(...analyzeClassMetrics(file, source));
  }
  const largest = [...all]
    .sort((a, b) => b.methodCount + b.propertyCount - (a.methodCount + a.propertyCount))
    .slice(0, 20);
  const mostImplemented = [...all].sort((a, b) => b.implementsCount - a.implementsCount).slice(0, 20);
  return {
    scannedFiles: selected.length,
    totalClasses: all.length,
    classes: all,
    largest,
    mostImplemented,
  };
}
