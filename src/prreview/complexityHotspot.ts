/**
 * complexityHotspot.ts - Cross-file complexity hotspot report.
 *
 * Walks TS/TSX sources, computes cyclomatic + cognitive complexity per
 * function, ranks the worst offenders across the whole workspace, and
 * summarizes category distribution. Pure analysis, no mutation.
 */

import * as ts from 'typescript';
import { readFile } from 'node:fs/promises';
import { glob } from 'glob';

export interface FunctionComplexity {
  file: string;
  name: string;
  startLine: number;
  endLine: number;
  linesOfCode: number;
  cyclomatic: number;
  cognitive: number;
  params: number;
}

export interface HotspotReport {
  scannedFiles: number;
  totalFunctions: number;
  worstByCyclomatic: FunctionComplexity[];
  worstByCognitive: FunctionComplexity[];
  largestFunctions: FunctionComplexity[];
  summary: {
    avgCyclomatic: number;
    avgCognitive: number;
    over10Cyclomatic: number;
    over10Cognitive: number;
  };
}

/** Count branch points for cyclomatic complexity. */
function countCyclomatic(node: ts.Node): number {
  let score = 1;
  function walk(n: ts.Node): void {
    switch (n.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CaseClause:
      case ts.SyntaxKind.ConditionalExpression:
      case ts.SyntaxKind.CatchClause:
        score += 1;
        break;
      case ts.SyntaxKind.BinaryExpression: {
        const op = (n as ts.BinaryExpression).operatorToken.kind;
        if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) score += 1;
        break;
      }
      default:
        break;
    }
    ts.forEachChild(n, walk);
  }
  walk(node);
  return score;
}

/** Rough cognitive complexity: nesting depth adds weight. */
function countCognitive(node: ts.Node): number {
  let score = 0;
  function walk(n: ts.Node, depth: number): void {
    switch (n.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CaseClause:
      case ts.SyntaxKind.CatchClause:
      case ts.SyntaxKind.ConditionalExpression:
        score += 1 + depth;
        ts.forEachChild(n, (child) => walk(child, depth + 1));
        return;
      default:
        break;
    }
    ts.forEachChild(n, (child) => walk(child, depth));
  }
  walk(node, 0);
  return score;
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

/** Extract complexity for every function-like node in a source file. */
export function analyzeFileComplexity(filePath: string, sourceText: string): FunctionComplexity[] {
  const sf = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: FunctionComplexity[] = [];
  function visit(node: ts.Node): void {
    const isFn =
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node);
    if (isFn) {
      const body = (node as ts.FunctionLikeDeclaration).body;
      if (body) {
        const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
        out.push({
          file: filePath,
          name: functionName(node),
          startLine: start,
          endLine: end,
          linesOfCode: Math.max(1, end - start + 1),
          cyclomatic: countCyclomatic(body),
          cognitive: countCognitive(body),
          params: (node as ts.FunctionLikeDeclaration).parameters.length,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return out;
}

export async function analyzeWorkspace(
  workspaceRoot: string,
  pattern: string,
  maxFiles: number,
): Promise<HotspotReport> {
  const files = await glob(pattern, { cwd: workspaceRoot, nodir: true, absolute: true });
  const selected = files.slice(0, maxFiles);
  const all: FunctionComplexity[] = [];
  for (const file of selected) {
    let source: string;
    try {
      source = await readFile(file, 'utf-8');
    } catch {
      continue;
    }
    all.push(...analyzeFileComplexity(file, source));
  }

  const byCyclomatic = [...all].sort((a, b) => b.cyclomatic - a.cyclomatic);
  const byCognitive = [...all].sort((a, b) => b.cognitive - a.cognitive);
  const byLength = [...all].sort((a, b) => b.linesOfCode - a.linesOfCode);

  const totalCyc = all.reduce((n, f) => n + f.cyclomatic, 0);
  const totalCog = all.reduce((n, f) => n + f.cognitive, 0);
  const count = all.length || 1;

  return {
    scannedFiles: selected.length,
    totalFunctions: all.length,
    worstByCyclomatic: byCyclomatic.slice(0, 20),
    worstByCognitive: byCognitive.slice(0, 20),
    largestFunctions: byLength.slice(0, 20),
    summary: {
      avgCyclomatic: Math.round((totalCyc / count) * 10) / 10,
      avgCognitive: Math.round((totalCog / count) * 10) / 10,
      over10Cyclomatic: all.filter((f) => f.cyclomatic > 10).length,
      over10Cognitive: all.filter((f) => f.cognitive > 10).length,
    },
  };
}
