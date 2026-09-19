/**
 * paramAnalysis.ts - Function parameter count & signature complexity scan.
 *
 * 找出参数过多、返回类型缺失、签名过长的函数，作为 API 改造候选。
 */

import * as ts from 'typescript';
import { readFile } from 'node:fs/promises';
import { glob } from 'glob';

export interface FunctionSigInfo {
  file: string;
  name: string;
  line: number;
  paramCount: number;
  hasReturnType: boolean;
  isAsync: boolean;
  isExported: boolean;
  /** 整个签名（单行截断展示） */
  signature: string;
}

export interface ParamAnalysisReport {
  scannedFiles: number;
  totalFunctions: number;
  /**
   * Bucketed counts: 0, 1, 2, 3, 4, 5, 6+ params
   */
  paramHistogram: number[];
  manyParams: FunctionSigInfo[];
  missingReturnType: FunctionSigInfo[];
  topByLength: FunctionSigInfo[];
}

function functionName(node: ts.Node): string {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  }
  return '<anonymous>';
}

export function analyzeFunctionSignatures(filePath: string, source: string): FunctionSigInfo[] {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: FunctionSigInfo[] = [];
  function visit(node: ts.Node): void {
    const isFunction =
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node);
    if (isFunction) {
      const fn = node as ts.FunctionLikeDeclaration;
      const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : [];
      const isExported = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      const isAsync = modifiers.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
      const hasReturn = Boolean((node as ts.FunctionLikeDeclaration).type);
      const endOfParams = (() => {
        const closeParen = source.indexOf(')', node.getStart(sf));
        return closeParen > 0 ? closeParen : node.getStart(sf) + 100;
      })();
      const rawSig = source.slice(node.getStart(sf), endOfParams + 1);
      const signature = rawSig.split('\n')[0]!.slice(0, 120);
      out.push({
        file: filePath,
        name: functionName(node),
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        paramCount: fn.parameters.length,
        hasReturnType: hasReturn,
        isAsync,
        isExported,
        signature,
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return out;
}

export async function analyzeWorkspaceSignatures(
  workspaceRoot: string,
  pattern: string,
  maxFiles: number,
): Promise<ParamAnalysisReport> {
  const files = await glob(pattern, { cwd: workspaceRoot, nodir: true, absolute: true });
  const selected = files.slice(0, maxFiles);
  const all: FunctionSigInfo[] = [];
  for (const file of selected) {
    let source: string;
    try {
      source = await readFile(file, 'utf-8');
    } catch {
      continue;
    }
    all.push(...analyzeFunctionSignatures(file, source));
  }

  const histogram = new Array<number>(7).fill(0);
  for (const f of all) {
    const bucket = f.paramCount >= 6 ? 6 : f.paramCount;
    histogram[bucket] = (histogram[bucket] ?? 0) + 1;
  }

  const manyParams = all.filter((f) => f.paramCount >= 5).sort((a, b) => b.paramCount - a.paramCount);
  const missingReturnType = all.filter((f) => !f.hasReturnType && !f.name.startsWith('_'));
  const topByLength = [...all].sort((a, b) => b.signature.length - a.signature.length);

  return {
    scannedFiles: selected.length,
    totalFunctions: all.length,
    paramHistogram: histogram,
    manyParams: manyParams.slice(0, 50),
    missingReturnType: missingReturnType.slice(0, 100),
    topByLength: topByLength.slice(0, 20),
  };
}
