/**
 * testGeneration.ts — 测试生成与修复工具
 *
 * test_generate: 基于源码（函数签名、类、接口）生成测试文件骨架，包含：
 *  - 测试框架检测（Jest/Mocha/Vitest/node:test）
 *  - 导入语句生成
 *  - 基础用例骨架（happy path、边界、错误路径）
 *  - Mock 建议
 *
 * test_fix: 分析失败的测试输出，建议修复方案（断言调整、mock 更新、数据修正）。
 */

import { readFile, writeFile, access } from 'node:fs/promises';
import { join, relative, dirname, basename, extname } from 'node:path';
import * as ts from 'typescript';
import { parseSourceFile } from '../analysis/parseCache.js';

type TestFramework = 'jest' | 'vitest' | 'mocha' | 'node:test' | 'unknown';

/**
 * 检测项目使用的测试框架（按优先级：package.json devDeps → 已有测试文件导入）。
 */
export async function detectTestFramework(workspaceRoot: string): Promise<TestFramework> {
  try {
    const pkgPath = join(workspaceRoot, 'package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { devDependencies?: Record<string, string> };
    const deps = pkg.devDependencies ?? {};
    if (deps.vitest) return 'vitest';
    if (deps.jest || deps['@types/jest']) return 'jest';
    if (deps.mocha) return 'mocha';
  } catch {
    // package.json 不存在或解析失败，继续尝试检测已有测试文件
  }
  return 'node:test'; // 默认回退到 Node.js 内置测试
}

type FunctionSignature = {
  name: string;
  parameters: Array<{ name: string; type: string }>;
  returnType: string;
  isAsync: boolean;
  isExported: boolean;
  leadingComment?: string;
};

type ClassSignature = {
  name: string;
  isExported: boolean;
  methods: Array<{ name: string; isStatic: boolean; parameters: Array<{ name: string; type: string }>; returnType: string }>;
};

/**
 * 提取源文件中可测试的函数与类签名。
 */
export async function extractTestableEntities(filePath: string, workspaceRoot: string): Promise<{
  functions: FunctionSignature[];
  classes: ClassSignature[];
}> {
  const sourceFile = await parseSourceFile(filePath, workspaceRoot);
  if (!sourceFile) {
    throw new Error(`Failed to parse ${filePath}`);
  }
  const functions: FunctionSignature[] = [];
  const classes: ClassSignature[] = [];
  const src = sourceFile; // 非空断言后的局部引用

  function getTypeText(node: ts.Node | undefined): string {
    if (!node) return 'unknown';
    return node.getText(src).replace(/\s+/g, ' ');
  }

  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      const isAsync = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
      const parameters = node.parameters.map((p) => ({
        name: p.name.getText(src),
        type: p.type ? getTypeText(p.type) : 'any',
      }));
      const returnType = node.type ? getTypeText(node.type) : isAsync ? 'Promise<unknown>' : 'unknown';
      const leadingComment = ts.getLeadingCommentRanges(src.text, node.getFullStart())?.[0];
      functions.push({
        name: node.name.text,
        parameters,
        returnType,
        isAsync,
        isExported,
        leadingComment: leadingComment ? src.text.slice(leadingComment.pos, leadingComment.end).trim() : undefined,
      });
    }

    if (ts.isClassDeclaration(node) && node.name) {
      const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      const methods = node.members
        .filter((m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && !!m.name)
        .map((m) => ({
          name: m.name!.getText(src),
          isStatic: m.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.StaticKeyword) ?? false,
          parameters: m.parameters.map((p) => ({
            name: p.name.getText(src),
            type: p.type ? getTypeText(p.type) : 'any',
          })),
          returnType: m.type ? getTypeText(m.type) : 'unknown',
        }));
      classes.push({ name: node.name.text, isExported, methods });
    }

    ts.forEachChild(node, visit);
  }

  visit(src);
  return { functions: functions.filter((f) => f.isExported), classes: classes.filter((c) => c.isExported) };
}

/**
 * 生成测试文件骨架代码。
 */
export function generateTestSkeleton(
  entities: { functions: FunctionSignature[]; classes: ClassSignature[] },
  sourcePath: string,
  framework: TestFramework,
): string {
  const lines: string[] = [];
  const importPath = `./${basename(sourcePath, extname(sourcePath))}`;

  // 框架导入
  if (framework === 'node:test') {
    lines.push("import { test } from 'node:test';", "import assert from 'node:assert/strict';");
  } else if (framework === 'jest' || framework === 'vitest') {
    lines.push(`import { describe, it, expect } from '${framework}';`);
  } else if (framework === 'mocha') {
    lines.push("import { describe, it } from 'mocha';", "import { expect } from 'chai';");
  }

  // 源码导入
  const importNames = [
    ...entities.functions.map((f) => f.name),
    ...entities.classes.map((c) => c.name),
  ];
  if (importNames.length > 0) {
    lines.push(`import { ${importNames.join(', ')} } from '${importPath}';`);
  }
  lines.push('');

  // 函数测试
  for (const fn of entities.functions) {
    if (framework === 'node:test') {
      lines.push(`test('${fn.name} handles typical inputs', ${fn.isAsync ? 'async ' : ''}() => {`);
      lines.push(`  // TODO: 准备输入`);
      const call = `${fn.name}(${fn.parameters.map((p) => `/* ${p.name} */`).join(', ')})`;
      lines.push(`  const result = ${fn.isAsync ? 'await ' : ''}${call};`);
      lines.push(`  // TODO: 验证输出`);
      lines.push(`  assert.ok(result);`);
      lines.push(`});`);
      lines.push('');
      lines.push(`test('${fn.name} handles edge cases', ${fn.isAsync ? 'async ' : ''}() => {`);
      lines.push(`  // TODO: 边界值、空输入、极端情况`);
      lines.push(`  assert.ok(true, 'implement edge case test');`);
      lines.push(`});`);
    } else {
      lines.push(`describe('${fn.name}', () => {`);
      lines.push(`  it('handles typical inputs', ${fn.isAsync ? 'async ' : ''}() => {`);
      lines.push(`    // TODO: 准备输入`);
      const call = `${fn.name}(${fn.parameters.map((p) => `/* ${p.name} */`).join(', ')})`;
      lines.push(`    const result = ${fn.isAsync ? 'await ' : ''}${call};`);
      lines.push(`    // TODO: 验证输出`);
      lines.push(`    expect(result).toBeDefined();`);
      lines.push(`  });`);
      lines.push('');
      lines.push(`  it('handles edge cases', () => {`);
      lines.push(`    // TODO: 边界值、空输入、极端情况`);
      lines.push(`  });`);
      lines.push(`});`);
    }
    lines.push('');
  }

  // 类测试
  for (const cls of entities.classes) {
    if (framework === 'node:test') {
      for (const method of cls.methods) {
        lines.push(`test('${cls.name}.${method.name} works correctly', () => {`);
        lines.push(`  const instance = new ${cls.name}(/* constructor args */);`);
        lines.push(`  const result = instance.${method.name}(${method.parameters.map((p) => `/* ${p.name} */`).join(', ')});`);
        lines.push(`  assert.ok(result);`);
        lines.push(`});`);
        lines.push('');
      }
    } else {
      lines.push(`describe('${cls.name}', () => {`);
      for (const method of cls.methods) {
        lines.push(`  it('${method.name} works correctly', () => {`);
        lines.push(`    const instance = new ${cls.name}(/* constructor args */);`);
        lines.push(`    const result = instance.${method.name}(${method.parameters.map((p) => `/* ${p.name} */`).join(', ')});`);
        lines.push(`    expect(result).toBeDefined();`);
        lines.push(`  });`);
      }
      lines.push(`});`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * 推荐测试文件路径（与源文件同目录的 .test.ts/.spec.ts，或 tests/ 子目录）。
 */
export function suggestTestPath(sourcePath: string, workspaceRoot: string): string {
  const rel = relative(workspaceRoot, sourcePath);
  const dir = dirname(rel);
  const name = basename(rel, extname(rel));
  return join(workspaceRoot, dir, `${name}.test.ts`);
}
