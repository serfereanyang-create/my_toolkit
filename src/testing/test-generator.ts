/**
 * test-generator.ts — 单元测试生成器
 * 
 * 自动生成单元测试框架和测试用例
 * - 基于函数签名生成测试脚手架
 * - 识别纯函数生成属性测试
 * - Mock 依赖自动生成
 * - 边界值分析和等价类划分
 */

import * as ts from 'typescript';
import { readFile } from 'node:fs/promises';
import { resolve, basename, dirname, join } from 'node:path';

/**
 * 测试框架类型
 */
export type TestFramework = 'jest' | 'vitest' | 'mocha' | 'node-test';

/**
 * 测试用例
 */
export interface TestCase {
  /** 测试描述 */
  description: string;
  /** 输入参数 */
  input: any[];
  /** 期望输出 */
  expected: any;
  /** 是否为边界情况 */
  isBoundary?: boolean;
  /** 是否为异常情况 */
  isException?: boolean;
}

/**
 * 函数测试信息
 */
export interface FunctionTestInfo {
  name: string;
  parameters: Array<{
    name: string;
    type: string;
    isOptional: boolean;
  }>;
  returnType: string;
  isPure: boolean;
  dependencies: string[];
  testCases: TestCase[];
}

/**
 * 测试生成结果
 */
export interface TestGenerationResult {
  /** 测试文件内容 */
  testCode: string;
  /** 测试文件路径建议 */
  suggestedPath: string;
  /** 生成的测试函数列表 */
  functions: FunctionTestInfo[];
  /** Mock 依赖 */
  mocks: string[];
}

/**
 * 分析函数是否为纯函数
 */
function analyzePurity(node: ts.FunctionDeclaration, sourceFile: ts.SourceFile): boolean {
  let isPure = true;
  
  function visit(n: ts.Node) {
    // 检查是否有副作用
    if (ts.isCallExpression(n)) {
      // console.log, process.exit 等非纯操作
      const text = n.expression.getText(sourceFile);
      if (text.includes('console.') || 
          text.includes('process.') ||
          text.includes('Math.random') ||
          text.includes('Date.now')) {
        isPure = false;
      }
    }
    
    // 检查是否修改外部状态
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = n.left;
      if (ts.isPropertyAccessExpression(left) && 
          left.expression.kind !== ts.SyntaxKind.ThisKeyword) {
        isPure = false;
      }
    }
    
    ts.forEachChild(n, visit);
  }
  
  if (node.body) {
    visit(node.body);
  }
  
  return isPure;
}

/**
 * 提取函数依赖
 */
function extractDependencies(node: ts.FunctionDeclaration, sourceFile: ts.SourceFile): string[] {
  const deps = new Set<string>();
  
  function visit(n: ts.Node) {
    if (ts.isCallExpression(n)) {
      if (ts.isIdentifier(n.expression)) {
        deps.add(n.expression.text);
      } else if (ts.isPropertyAccessExpression(n.expression)) {
        const objName = n.expression.expression.getText(sourceFile);
        const methodName = n.expression.name.text;
        deps.add(`${objName}.${methodName}`);
      }
    }
    ts.forEachChild(n, visit);
  }
  
  if (node.body) {
    visit(node.body);
  }
  
  return Array.from(deps);
}

/**
 * 基于类型生成测试用例（边界值分析）
 */
function generateTestCasesForType(
  paramName: string,
  paramType: string,
  isOptional: boolean
): Array<{ description: string; value: any; isBoundary: boolean }> {
  const cases: Array<{ description: string; value: any; isBoundary: boolean }> = [];
  
  const normalizedType = paramType.toLowerCase();
  
  if (normalizedType.includes('number')) {
    cases.push(
      { description: `${paramName} 为 0`, value: 0, isBoundary: true },
      { description: `${paramName} 为正数`, value: 42, isBoundary: false },
      { description: `${paramName} 为负数`, value: -1, isBoundary: true },
      { description: `${paramName} 为小数`, value: 3.14, isBoundary: false },
      { description: `${paramName} 为 NaN`, value: NaN, isBoundary: true },
      { description: `${paramName} 为 Infinity`, value: Infinity, isBoundary: true }
    );
  } else if (normalizedType.includes('string')) {
    cases.push(
      { description: `${paramName} 为空字符串`, value: '', isBoundary: true },
      { description: `${paramName} 为普通字符串`, value: 'test', isBoundary: false },
      { description: `${paramName} 包含特殊字符`, value: '<script>alert("xss")</script>', isBoundary: true },
      { description: `${paramName} 为多行字符串`, value: 'line1\\nline2', isBoundary: false },
      { description: `${paramName} 为很长的字符串`, value: 'a'.repeat(10000), isBoundary: true }
    );
  } else if (normalizedType.includes('boolean')) {
    cases.push(
      { description: `${paramName} 为 true`, value: true, isBoundary: false },
      { description: `${paramName} 为 false`, value: false, isBoundary: false }
    );
  } else if (normalizedType.includes('array') || normalizedType.includes('[]')) {
    cases.push(
      { description: `${paramName} 为空数组`, value: [], isBoundary: true },
      { description: `${paramName} 为单元素数组`, value: [1], isBoundary: false },
      { description: `${paramName} 为多元素数组`, value: [1, 2, 3], isBoundary: false }
    );
  } else if (normalizedType.includes('object') || normalizedType === 'any') {
    cases.push(
      { description: `${paramName} 为空对象`, value: {}, isBoundary: true },
      { description: `${paramName} 为普通对象`, value: { key: 'value' }, isBoundary: false },
      { description: `${paramName} 为 null`, value: null, isBoundary: true }
    );
  }
  
  if (isOptional) {
    cases.push({ description: `${paramName} 为 undefined`, value: undefined, isBoundary: true });
  }
  
  return cases;
}

/**
 * 生成函数测试用例
 */
function generateTestCasesForFunction(
  func: FunctionTestInfo
): TestCase[] {
  const testCases: TestCase[] = [];
  
  // 正常情况：每个参数取正常值
  if (func.parameters.length > 0) {
    const normalCase: TestCase = {
      description: '正常输入',
      input: func.parameters.map(p => {
        const type = p.type.toLowerCase();
        if (type.includes('number')) return 42;
        if (type.includes('string')) return 'test';
        if (type.includes('boolean')) return true;
        if (type.includes('array')) return [1, 2, 3];
        return {};
      }),
      expected: null, // 需要根据实际逻辑填充
    };
    testCases.push(normalCase);
  }
  
  // 边界情况：每个参数的边界值
  for (let i = 0; i < func.parameters.length; i++) {
    const param = func.parameters[i];
    const boundaryCases = generateTestCasesForType(param.name, param.type, param.isOptional);
    
    for (const boundaryCase of boundaryCases.filter(c => c.isBoundary)) {
      const input = func.parameters.map((p, idx) => {
        if (idx === i) return boundaryCase.value;
        // 其他参数使用正常值
        const type = p.type.toLowerCase();
        if (type.includes('number')) return 42;
        if (type.includes('string')) return 'test';
        if (type.includes('boolean')) return true;
        return {};
      });
      
      testCases.push({
        description: boundaryCase.description,
        input,
        expected: null,
        isBoundary: true,
      });
    }
  }
  
  // 异常情况
  if (func.parameters.length > 0) {
    testCases.push({
      description: '所有参数为 null',
      input: func.parameters.map(() => null),
      expected: null,
      isException: true,
    });
  }
  
  return testCases.slice(0, 10); // 限制数量
}

/**
 * 生成 Mock 代码
 */
function generateMockCode(
  dependencies: string[],
  framework: TestFramework
): { imports: string[]; mocks: string[] } {
  const imports: string[] = [];
  const mocks: string[] = [];
  
  for (const dep of dependencies) {
    if (dep.includes('.')) {
      const [obj, method] = dep.split('.');
      
      if (framework === 'jest') {
        mocks.push(`const mock${obj} = { ${method}: jest.fn() };`);
      } else if (framework === 'vitest') {
        mocks.push(`const mock${obj} = { ${method}: vi.fn() };`);
      } else {
        mocks.push(`const mock${obj} = { ${method}: () => {} };`);
      }
    }
  }
  
  return { imports, mocks };
}

/**
 * 生成测试代码
 */
function generateTestCode(
  functions: FunctionTestInfo[],
  sourceFilePath: string,
  framework: TestFramework
): string {
  const lines: string[] = [];
  
  // 导入语句
  if (framework === 'jest') {
    lines.push("import { describe, it, expect, jest } from '@jest/globals';");
  } else if (framework === 'vitest') {
    lines.push("import { describe, it, expect, vi } from 'vitest';");
  } else if (framework === 'mocha') {
    lines.push("import { describe, it } from 'mocha';");
    lines.push("import { expect } from 'chai';");
  } else {
    lines.push("import { describe, it } from 'node:test';");
    lines.push("import assert from 'node:assert';");
  }
  
  // 导入被测试的函数
  const importNames = functions.map(f => f.name).join(', ');
  const importPath = sourceFilePath.replace(/\.ts$/, '.js').replace(/\\/g, '/');
  lines.push(`import { ${importNames} } from '${importPath}';`);
  lines.push('');
  
  // 为每个函数生成测试
  for (const func of functions) {
    lines.push(`describe('${func.name}', () => {`);
    
    // Mock 依赖
    if (func.dependencies.length > 0) {
      const { mocks } = generateMockCode(func.dependencies, framework);
      for (const mock of mocks) {
        lines.push(`  ${mock}`);
      }
      lines.push('');
    }
    
    // 生成测试用例
    for (const testCase of func.testCases) {
      const argsStr = testCase.input.map(v => JSON.stringify(v)).join(', ');
      
      lines.push(`  it('${testCase.description}', () => {`);
      
      if (testCase.isException) {
        // 异常测试
        if (framework === 'node-test') {
          lines.push(`    assert.throws(() => ${func.name}(${argsStr}));`);
        } else {
          lines.push(`    expect(() => ${func.name}(${argsStr})).toThrow();`);
        }
      } else {
        // 正常测试
        lines.push(`    const result = ${func.name}(${argsStr});`);
        lines.push(`    // TODO: 验证 result 的值`);
        
        if (framework === 'node-test') {
          lines.push(`    // assert.strictEqual(result, expected);`);
        } else {
          lines.push(`    // expect(result).toBe(expected);`);
        }
      }
      
      lines.push(`  });`);
      lines.push('');
    }
    
    lines.push('});');
    lines.push('');
  }
  
  return lines.join('\n');
}

/**
 * 分析文件并生成测试
 */
export async function generateTests(
  filePath: string,
  workspaceRoot: string,
  options: {
    framework?: TestFramework;
    maxCasesPerFunction?: number;
  } = {}
): Promise<TestGenerationResult> {
  const framework = options.framework || 'vitest';
  const maxCases = options.maxCasesPerFunction || 10;
  
  const absolutePath = resolve(workspaceRoot, filePath);
  const content = await readFile(absolutePath, 'utf-8');
  
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true
  );
  
  const functions: FunctionTestInfo[] = [];
  const allMocks = new Set<string>();
  
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.text;
      
      const parameters = node.parameters.map(p => ({
        name: ts.isIdentifier(p.name) ? p.name.text : '?',
        type: p.type ? p.type.getText(sourceFile) : 'any',
        isOptional: !!p.questionToken,
      }));
      
      const returnType = node.type ? node.type.getText(sourceFile) : 'any';
      const isPure = analyzePurity(node, sourceFile);
      const dependencies = extractDependencies(node, sourceFile);
      
      dependencies.forEach(dep => allMocks.add(dep));
      
      const funcInfo: FunctionTestInfo = {
        name,
        parameters,
        returnType,
        isPure,
        dependencies,
        testCases: [],
      };
      
      funcInfo.testCases = generateTestCasesForFunction(funcInfo).slice(0, maxCases);
      
      functions.push(funcInfo);
    }
    
    ts.forEachChild(node, visit);
  }
  
  visit(sourceFile);
  
  // 生成测试代码
  const testCode = generateTestCode(functions, filePath, framework);
  
  // 建议测试文件路径
  const fileBasename = basename(filePath, '.ts');
  const fileDir = dirname(filePath);
  const suggestedPath = join(fileDir, `${fileBasename}.test.ts`);
  
  return {
    testCode,
    suggestedPath,
    functions,
    mocks: Array.from(allMocks),
  };
}

/**
 * 生成单个函数的测试
 */
export async function generateTestForFunction(
  filePath: string,
  functionName: string,
  workspaceRoot: string,
  framework: TestFramework = 'vitest'
): Promise<string> {
  const result = await generateTests(filePath, workspaceRoot, { framework });
  
  const func = result.functions.find(f => f.name === functionName);
  if (!func) {
    throw new Error(`函数 '${functionName}' 未找到`);
  }
  
  return generateTestCode([func], filePath, framework);
}

/**
 * 生成属性测试（针对纯函数）
 */
export function generatePropertyTest(
  func: FunctionTestInfo,
  framework: TestFramework
): string {
  if (!func.isPure) {
    throw new Error('属性测试仅适用于纯函数');
  }
  
  const lines: string[] = [];
  
  lines.push(`describe('${func.name} - Property Tests', () => {`);
  
  // 幂等性测试
  if (func.parameters.length > 0) {
    lines.push(`  it('应该是幂等的（相同输入产生相同输出）', () => {`);
    const args = func.parameters.map(() => 'testInput').join(', ');
    lines.push(`    const result1 = ${func.name}(${args});`);
    lines.push(`    const result2 = ${func.name}(${args});`);
    
    if (framework === 'node-test') {
      lines.push(`    assert.deepStrictEqual(result1, result2);`);
    } else {
      lines.push(`    expect(result1).toEqual(result2);`);
    }
    
    lines.push(`  });`);
    lines.push('');
  }
  
  // 可交换性测试（如果适用）
  if (func.parameters.length === 2 && func.returnType === 'number') {
    lines.push(`  it('应该满足交换律', () => {`);
    lines.push(`    const a = 5, b = 10;`);
    lines.push(`    const result1 = ${func.name}(a, b);`);
    lines.push(`    const result2 = ${func.name}(b, a);`);
    lines.push(`    // 如果函数支持交换律，取消下面的注释`);
    lines.push(`    // expect(result1).toBe(result2);`);
    lines.push(`  });`);
    lines.push('');
  }
  
  lines.push('});');
  
  return lines.join('\n');
}
