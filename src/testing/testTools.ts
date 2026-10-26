/**
 * testTools.ts — 测试生成与修复工具注册
 */

import { resolve } from 'node:path';
import type { ToolDefinition } from '../tools/types.js';
import {
  detectTestFramework,
  extractTestableEntities,
  generateTestSkeleton,
  suggestTestPath,
} from './testGeneration.js';

export const testGenerateTool: ToolDefinition<{
  file: string;
  outputPath?: string;
  framework?: 'jest' | 'vitest' | 'mocha' | 'node:test';
}> = {
  name: 'test_generate',
  description: '基于源码生成测试文件骨架（函数/类/方法的基础用例模板）',
  inputHint: '{ "file": "src/utils.ts", "outputPath": "src/utils.test.ts" }',
  risk: 'write',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.file !== 'string' || !record.file.trim()) {
      throw new Error('file path is required');
    }
    return {
      file: record.file.trim(),
      outputPath: typeof record.outputPath === 'string' && record.outputPath.trim()
        ? record.outputPath.trim()
        : undefined,
      framework: typeof record.framework === 'string' &&
        ['jest', 'vitest', 'mocha', 'node:test'].includes(record.framework)
        ? (record.framework as 'jest' | 'vitest' | 'mocha' | 'node:test')
        : undefined,
    };
  },

  async execute(input, context) {
    const filePath = resolve(context.workspaceRoot, input.file);
    
    // 检测测试框架
    const framework = input.framework ?? await detectTestFramework(context.workspaceRoot);

    // 提取可测试实体
    let entities: Awaited<ReturnType<typeof extractTestableEntities>>;
    try {
      entities = await extractTestableEntities(filePath, context.workspaceRoot);
    } catch (error) {
      return {
        ok: false,
        output: `Failed to parse source file: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (entities.functions.length === 0 && entities.classes.length === 0) {
      return {
        ok: true,
        output: `No exported functions or classes found in ${input.file} — nothing to test.`,
        data: { framework, entities: 0 },
      };
    }

    // 生成测试骨架
    const testCode = generateTestSkeleton(entities, filePath, framework);
    const outputPath = input.outputPath ?? suggestTestPath(filePath, context.workspaceRoot);

    return {
      ok: true,
      output: `Generated test skeleton for ${input.file} (${entities.functions.length} functions, ${entities.classes.length} classes).\n\nSuggested path: ${outputPath}\n\nReview the generated code and fill in TODO placeholders with actual test logic.`,
      data: {
        framework,
        outputPath,
        testCode,
        entities: {
          functions: entities.functions.length,
          classes: entities.classes.length,
        },
      },
    };
  },
};

type TestFailure = {
  testName: string;
  error: string;
  stackTrace?: string;
};

/**
 * 解析测试失败输出（支持 node:test、Jest、Vitest 常见格式）。
 */
function parseTestFailures(output: string): TestFailure[] {
  const failures: TestFailure[] = [];
  const lines = output.split('\n');
  let current: Partial<TestFailure> | null = null;

  for (const line of lines) {
    // node:test: ✖ test name (duration)
    if (line.match(/^✖\s+(.+?)\s+\(\d/)) {
      if (current) failures.push(current as TestFailure);
      current = { testName: line.match(/^✖\s+(.+?)\s+\(/)?.[1] ?? 'unknown', error: '' };
    }
    // Jest/Vitest: ● test suite › test name
    else if (line.match(/^●\s+(.+)/)) {
      if (current) failures.push(current as TestFailure);
      current = { testName: line.match(/^●\s+(.+)/)?.[1] ?? 'unknown', error: '' };
    }
    // Error message lines
    else if (current && line.trim() && !line.match(/^(at |>)/)) {
      current.error += (current.error ? '\n' : '') + line.trim();
    }
    // Stack trace
    else if (current && line.match(/^\s+at /)) {
      current.stackTrace = (current.stackTrace ?? '') + line + '\n';
    }
  }
  if (current) failures.push(current as TestFailure);
  return failures.filter((f) => f.testName && f.error);
}

/**
 * 基于失败信息生成修复建议。
 */
function suggestFixes(failures: TestFailure[]): string[] {
  const suggestions: string[] = [];
  for (const failure of failures) {
    const msg = failure.error.toLowerCase();
    if (msg.includes('expected') && msg.includes('received')) {
      suggestions.push(`${failure.testName}: 断言期望值不符，检查预期输出是否正确或输入数据是否有效。`);
    } else if (msg.includes('undefined') || msg.includes('null')) {
      suggestions.push(`${failure.testName}: 遇到 undefined/null，检查对象是否已初始化或 mock 是否到位。`);
    } else if (msg.includes('timeout') || msg.includes('timed out')) {
      suggestions.push(`${failure.testName}: 测试超时，检查异步操作是否未 await 或陷入死循环。`);
    } else if (msg.includes('mock') || msg.includes('spy')) {
      suggestions.push(`${failure.testName}: Mock/spy 问题，检查 mock 返回值、调用次数是否符合预期。`);
    } else {
      suggestions.push(`${failure.testName}: ${failure.error.slice(0, 80)}...`);
    }
  }
  return suggestions;
}

export const testFixTool: ToolDefinition<{
  output: string;
  testFile?: string;
}> = {
  name: 'test_fix',
  description: '分析失败的测试输出，给出修复建议（断言、mock、数据）',
  inputHint: '{ "output": "<test failure output>", "testFile": "src/utils.test.ts" }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.output !== 'string' || !record.output.trim()) {
      throw new Error('test output is required');
    }
    return {
      output: record.output,
      testFile: typeof record.testFile === 'string' && record.testFile.trim()
        ? record.testFile.trim()
        : undefined,
    };
  },

  async execute(input, context) {
    const failures = parseTestFailures(input.output);
    if (failures.length === 0) {
      return {
        ok: true,
        output: 'No test failures detected in the provided output. All tests may have passed.',
        data: { failures: 0 },
      };
    }

    const suggestions = suggestFixes(failures);
    const lines: string[] = [
      `Found ${failures.length} test failure(s)${input.testFile ? ` in ${input.testFile}` : ''}:`,
      '',
      ...suggestions.map((s, i) => `${i + 1}. ${s}`),
      '',
      'Review the suggestions above and update the test file or source code accordingly.',
    ];

    return {
      ok: true,
      output: lines.join('\n'),
      data: { failures: failures.length, suggestions },
    };
  },
};

export const testTools = [testGenerateTool, testFixTool];
