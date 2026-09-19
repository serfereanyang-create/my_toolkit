/**
 * hardcodedText.ts — 扫描源码中的硬编码可本地化字符串
 *
 * 面向 TS/TSX 文件，挑出模板字符串/字符串字面量中包含 CJK 字符
 * 且未经 t() / i18n.* / locale 处理的位置。用于评估 i18n 迁移工作量。
 */

import * as ts from 'typescript';
import { readFile } from 'node:fs/promises';
import { glob } from 'glob';

export interface HardcodedText {
  filePath: string;
  line: number;
  column: number;
  /** 提取的可本地化字符串内容 */
  text: string;
  /** 是否位于 JSX/TSX 元素（通常是用户可见文案） */
  inJsx: boolean;
  /** 是否位于 import/require（模块路径不算） */
  inImportPath: boolean;
}

const CJK_RANGE = /[㐀-鿿豈-﫿]/;

function isTWrapped(source: string, start: number): boolean {
  // 简单向前回溯，看是否处于 t("...") / i18n.t("...") 调用中
  const prefix = source.slice(Math.max(0, start - 8), start);
  return /\b(t|i18n\.t|intl\.formatMessage)\($/.test(prefix);
}

function isImportPath(node: ts.Node): boolean {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isImportDeclaration(cur) || ts.isExportDeclaration(cur)) return true;
    if (ts.isCallExpression(cur)) {
      const expr = cur.expression;
      if (ts.isIdentifier(expr) && (expr.text === 'require' || expr.text === 'import')) return true;
    }
    cur = cur.parent;
  }
  return false;
}

function inJsxElement(node: ts.Node): boolean {
  if (ts.isJsxText(node)) return true;
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (
      ts.isJsxElement(cur) ||
      ts.isJsxSelfClosingElement(cur) ||
      ts.isJsxAttribute(cur) ||
      ts.isJsxExpression(cur)
    ) {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}

/** 分析单个 TS/TSX 源文件 */
export function analyzeFile(filePath: string, sourceText: string): HardcodedText[] {
  const sf = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: HardcodedText[] = [];

  function visit(node: ts.Node): void {
    let literalText: string | null = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      literalText = node.text;
    } else if (ts.isJsxText(node)) {
      literalText = node.text;
    }
    if (literalText !== null) {
      const text = literalText.trim();
      // 长度 2+ 才值得提示本地化；含路径分隔符或纯文件名视为模块路径
      const isPathLike = /[./\\]/.test(text) && !/\s/.test(text);
      const cjkCount = (text.match(new RegExp(CJK_RANGE.source, 'g')) ?? []).length;
      if (cjkCount >= 2 && !isPathLike) {
        const importPath = isImportPath(node);
        if (!importPath && !isTWrapped(sourceText, node.getStart(sf))) {
          const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          hits.push({
            filePath,
            line: line + 1,
            column: character + 1,
            text,
            inJsx: inJsxElement(node),
            inImportPath: importPath,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return hits;
}

export interface I18nReport {
  scanned: number;
  hits: HardcodedText[];
  /** 按文件分组的概览 */
  byFile: Array<{ file: string; count: number; jsxCount: number }>;
}

export async function scanWorkspace(
  workspaceRoot: string,
  pattern: string,
  maxFiles: number,
): Promise<I18nReport> {
  const files = await glob(pattern, { cwd: workspaceRoot, nodir: true, absolute: true });
  const selected = files.slice(0, maxFiles);
  const all: HardcodedText[] = [];
  for (const file of selected) {
    let text = '';
    try {
      text = await readFile(file, 'utf-8');
    } catch {
      continue;
    }
    all.push(...analyzeFile(file, text));
  }
  const byFileMap = new Map<string, { count: number; jsx: number }>();
  for (const h of all) {
    const entry = byFileMap.get(h.filePath) ?? { count: 0, jsx: 0 };
    entry.count += 1;
    if (h.inJsx) entry.jsx += 1;
    byFileMap.set(h.filePath, entry);
  }
  const byFile = [...byFileMap.entries()]
    .map(([file, v]) => ({ file, count: v.count, jsxCount: v.jsx }))
    .sort((a, b) => b.count - a.count);
  return { scanned: selected.length, hits: all, byFile };
}
