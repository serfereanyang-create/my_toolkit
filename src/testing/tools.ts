/**
 * tools.ts — 测试工具集成（CLI 工具注册）
 * 
 * 将测试生成器、覆盖率分析等功能注册为 CLI 工具
 */

import { defineTool } from '../tools/define.js';
import type { ToolResult } from '../tools/types.js';
import { globSync } from 'glob';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  generateTests,
  generateTestForFunction,
  type TestFramework,
} from './test-generator.js';
import {
  analyzeFileCoverage,
  analyzeProjectCoverage,
  generateCoverageReport,
  analyzeIncrementalCoverage,
  generateCoverageBadge,
  parseLcovCoverage,
} from './coverage.js';

/**
 * 生成测试工具
 */
export const generateTestsTool = defineTool({
  name: 'generate_tests',
  description: '自动生成单元测试框架和测试用例，包括边界值和异常测试',
  risk: 'write',
  input: {
    file: {
      type: 'string',
      description: '要生成测试的文件路径',
    },
    framework: {
      type: 'string',
      description: '测试框架: jest | vitest | mocha | node-test。默认 vitest',
      optional: true,
    },
    writeToFile: {
      type: 'boolean',
      description: '是否写入测试文件。默认 false（仅预览）',
      optional: true,
    },
  },
  examples: [
    {
      input: { file: 'src/utils/math.ts', framework: 'vitest' },
      output: '为 math.ts 生成 Vitest 测试',
    },
  ],
  
  async execute({ file, framework = 'vitest', writeToFile = false }, context): Promise<ToolResult> {
    try {
      const result = await generateTests(file, context.cwd, {
        framework: framework as TestFramework,
      });
      
      const lines: string[] = [];
      lines.push('# 测试生成结果\n');
      lines.push(`**源文件:** ${file}`);
      lines.push(`**测试文件建议路径:** ${result.suggestedPath}`);
      lines.push(`**测试框架:** ${framework}\n`);
      
      lines.push('## 生成的测试函数\n');
      for (const func of result.functions) {
        lines.push(`### ${func.name}`);
        lines.push(`- 参数: ${func.parameters.map(p => `${p.name}: ${p.type}`).join(', ')}`);
        lines.push(`- 返回类型: ${func.returnType}`);
        lines.push(`- 纯函数: ${func.isPure ? '✅' : '❌'}`);
        lines.push(`- 测试用例数: ${func.testCases.length}`);
        
        if (func.dependencies.length > 0) {
          lines.push(`- 依赖: ${func.dependencies.join(', ')}`);
        }
        
        lines.push('');
      }
      
      if (result.mocks.length > 0) {
        lines.push('## 需要 Mock 的依赖\n');
        for (const mock of result.mocks) {
          lines.push(`- ${mock}`);
        }
        lines.push('');
      }
      
      lines.push('## 生成的测试代码\n');
      lines.push('```typescript');
      lines.push(result.testCode);
      lines.push('```\n');
      
      if (writeToFile) {
        const testFilePath = resolve(context.cwd, result.suggestedPath);
        await writeFile(testFilePath, result.testCode, 'utf-8');
        lines.push(`✅ 已写入测试文件: ${result.suggestedPath}`);
      } else {
        lines.push('💡 **提示:** 使用 `writeToFile: true` 写入测试文件');
      }
      
      return {
        ok: true,
        output: lines.join('\n'),
        data: result,
      };
    } catch (error) {
      return {
        ok: false,
        output: `测试生成失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

/**
 * 生成单个函数测试工具
 */
export const generateFunctionTestTool = defineTool({
  name: 'generate_function_test',
  description: '为指定函数生成测试用例',
  risk: 'read',
  input: {
    file: {
      type: 'string',
      description: '函数所在文件',
    },
    functionName: {
      type: 'string',
      description: '函数名称',
    },
    framework: {
      type: 'string',
      description: '测试框架，默认 vitest',
      optional: true,
    },
  },
  examples: [
    {
      input: { file: 'src/utils.ts', functionName: 'calculate' },
      output: '为 calculate 函数生成测试',
    },
  ],
  
  async execute({ file, functionName, framework = 'vitest' }, context): Promise<ToolResult> {
    try {
      const testCode = await generateTestForFunction(
        file,
        functionName,
        context.cwd,
        framework as TestFramework
      );
      
      return {
        ok: true,
        output: `# ${functionName} 的测试代码\n\n\`\`\`typescript\n${testCode}\n\`\`\``,
        data: { testCode },
      };
    } catch (error) {
      return {
        ok: false,
        output: `测试生成失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

/**
 * 覆盖率分析工具
 */
export const analyzeCoverageTool = defineTool({
  name: 'analyze_coverage',
  description: '分析代码覆盖率，识别未覆盖的代码区域',
  risk: 'read',
  input: {
    pattern: {
      type: 'string',
      description: 'Glob 模式匹配文件。默认 "src/**/*.{ts,tsx,js,jsx}"',
      optional: true,
    },
    lcovFile: {
      type: 'string',
      description: 'lcov 覆盖率报告文件路径（可选）',
      optional: true,
    },
  },
  examples: [
    {
      input: { pattern: 'src/**/*.ts' },
      output: '分析所有 TypeScript 文件的覆盖率',
    },
    {
      input: { pattern: 'src/**/*.ts', lcovFile: 'coverage/lcov.info' },
      output: '基于 lcov 报告分析覆盖率',
    },
  ],
  
  async execute({ pattern = 'src/**/*.{ts,tsx,js,jsx}', lcovFile }, context): Promise<ToolResult> {
    try {
      const files = globSync(pattern, {
        cwd: context.cwd,
        ignore: ['**/node_modules/**', '**/dist/**', '**/*.test.ts', '**/*.spec.ts'],
      });
      
      if (files.length === 0) {
        return {
          ok: true,
          output: `未找到匹配的文件: ${pattern}`,
        };
      }
      
      let coverageData: Map<string, any> | undefined;
      
      if (lcovFile) {
        try {
          const { readFile } = await import('node:fs/promises');
          const lcovPath = resolve(context.cwd, lcovFile);
          const lcovContent = await readFile(lcovPath, 'utf-8');
          const parsed = parseLcovCoverage(lcovContent);
          coverageData = parsed as any;
        } catch (err) {
          return {
            ok: false,
            output: `无法读取 lcov 文件: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
      
      const coverage = await analyzeProjectCoverage(files, context.cwd, coverageData);
      const report = generateCoverageReport(coverage);
      
      return {
        ok: true,
        output: report,
        data: coverage,
      };
    } catch (error) {
      return {
        ok: false,
        output: `覆盖率分析失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

/**
 * 文件覆盖率详情工具
 */
export const fileCoverageTool = defineTool({
  name: 'file_coverage',
  description: '查看单个文件的详细覆盖率信息',
  risk: 'read',
  input: {
    file: {
      type: 'string',
      description: '文件路径',
    },
  },
  examples: [
    {
      input: { file: 'src/utils/parser.ts' },
      output: '查看 parser.ts 的覆盖率详情',
    },
  ],
  
  async execute({ file }, context): Promise<ToolResult> {
    try {
      const coverage = await analyzeFileCoverage(file, context.cwd);
      
      const lines: string[] = [];
      lines.push(`# ${coverage.path} 覆盖率详情\n`);
      
      lines.push('## 概览\n');
      lines.push(`- 行覆盖率: ${coverage.lineCoverage.toFixed(2)}% (${coverage.coveredLines}/${coverage.totalLines})`);
      lines.push(`- 分支覆盖率: ${coverage.branchCoverage.toFixed(2)}% (${coverage.coveredBranches}/${coverage.totalBranches})`);
      lines.push(`- 函数覆盖率: ${coverage.functionCoverage.toFixed(2)}% (${coverage.coveredFunctions}/${coverage.totalFunctions})\n`);
      
      if (coverage.uncoveredFunctions.length > 0) {
        lines.push('## 未覆盖的函数\n');
        for (const func of coverage.uncoveredFunctions) {
          lines.push(`- ${func.name} (行 ${func.line})`);
        }
        lines.push('');
      }
      
      if (coverage.uncoveredLines.length > 0) {
        lines.push('## 未覆盖的行\n');
        if (coverage.uncoveredLines.length <= 50) {
          lines.push(coverage.uncoveredLines.join(', '));
        } else {
          lines.push(`共 ${coverage.uncoveredLines.length} 行未覆盖`);
          lines.push(`前 20 行: ${coverage.uncoveredLines.slice(0, 20).join(', ')}`);
        }
        lines.push('');
      }
      
      if (coverage.lineCoverage < 80) {
        lines.push('## 💡 建议\n');
        lines.push(`当前覆盖率 ${coverage.lineCoverage.toFixed(1)}%，建议提升至 80% 以上`);
        lines.push('可以使用 `generate_tests` 工具自动生成测试用例');
      }
      
      return {
        ok: true,
        output: lines.join('\n'),
        data: coverage,
      };
    } catch (error) {
      return {
        ok: false,
        output: `覆盖率分析失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

/**
 * 增量覆盖率工具
 */
export const incrementalCoverageTool = defineTool({
  name: 'incremental_coverage',
  description: '分析增量代码的覆盖率（仅统计变更的行）',
  risk: 'read',
  input: {
    files: {
      type: 'array',
      description: '变更的文件列表',
    },
    changedLines: {
      type: 'object',
      description: '每个文件的变更行号映射（JSON 对象）',
    },
  },
  examples: [
    {
      input: { 
        files: ['src/api.ts', 'src/utils.ts'], 
        changedLines: { 'src/api.ts': [10, 11, 12], 'src/utils.ts': [5] }
      },
      output: '分析这些变更行的覆盖率',
    },
  ],
  
  async execute({ files, changedLines }, context): Promise<ToolResult> {
    try {
      const changedLinesMap = new Map<string, number[]>();
      for (const [file, lines] of Object.entries(changedLines as Record<string, number[]>)) {
        changedLinesMap.set(file, lines);
      }
      
      const result = await analyzeIncrementalCoverage(
        files as string[],
        changedLinesMap,
        context.cwd
      );
      
      const lines: string[] = [];
      lines.push('# 增量覆盖率\n');
      lines.push(`**变更行总数:** ${result.changedLinesTotal}`);
      lines.push(`**已覆盖行数:** ${result.changedLinesCovered}`);
      lines.push(`**增量覆盖率:** ${result.incrementalCoverage.toFixed(2)}%\n`);
      
      const icon = result.incrementalCoverage >= 80 ? '✅' : 
                   result.incrementalCoverage >= 60 ? '⚠️' : '❌';
      
      lines.push(`${icon} 增量覆盖率 ${result.incrementalCoverage >= 80 ? '达标' : '不达标'}（目标 80%）`);
      
      return {
        ok: true,
        output: lines.join('\n'),
        data: result,
      };
    } catch (error) {
      return {
        ok: false,
        output: `增量覆盖率分析失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

/**
 * 生成覆盖率徽章工具
 */
export const generateCoverageBadgeTool = defineTool({
  name: 'generate_coverage_badge',
  description: '生成覆盖率徽章 SVG（用于 README）',
  risk: 'write',
  input: {
    pattern: {
      type: 'string',
      description: 'Glob 模式匹配文件，用于计算覆盖率',
      optional: true,
    },
    outputFile: {
      type: 'string',
      description: '徽章输出文件路径。默认 coverage-badge.svg',
      optional: true,
    },
  },
  examples: [
    {
      input: { pattern: 'src/**/*.ts', outputFile: 'badges/coverage.svg' },
      output: '生成覆盖率徽章',
    },
  ],
  
  async execute({ pattern = 'src/**/*.{ts,tsx,js,jsx}', outputFile = 'coverage-badge.svg' }, context): Promise<ToolResult> {
    try {
      const files = globSync(pattern, {
        cwd: context.cwd,
        ignore: ['**/node_modules/**', '**/dist/**', '**/*.test.ts'],
      });
      
      const coverage = await analyzeProjectCoverage(files, context.cwd);
      const badge = generateCoverageBadge(coverage.summary.lineCoverage);
      
      const badgePath = resolve(context.cwd, outputFile);
      await writeFile(badgePath, badge, 'utf-8');
      
      return {
        ok: true,
        output: `✅ 覆盖率徽章已生成: ${outputFile}\n覆盖率: ${coverage.summary.lineCoverage.toFixed(2)}%\n\nMarkdown 引用:\n\`\`\`markdown\n![Coverage](${outputFile})\n\`\`\``,
        data: { coverage: coverage.summary.lineCoverage, badgePath },
      };
    } catch (error) {
      return {
        ok: false,
        output: `徽章生成失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

/**
 * 测试覆盖率门禁工具
 */
export const coverageGateTool = defineTool({
  name: 'coverage_gate',
  description: '检查覆盖率是否达标（CI/CD 门禁）',
  risk: 'read',
  input: {
    pattern: {
      type: 'string',
      description: 'Glob 模式',
      optional: true,
    },
    minLine: {
      type: 'number',
      description: '最低行覆盖率要求（百分比）。默认 80',
      optional: true,
    },
    minBranch: {
      type: 'number',
      description: '最低分支覆盖率要求。默认 70',
      optional: true,
    },
    minFunction: {
      type: 'number',
      description: '最低函数覆盖率要求。默认 80',
      optional: true,
    },
  },
  examples: [
    {
      input: { pattern: 'src/**/*.ts', minLine: 80, minBranch: 70 },
      output: '检查覆盖率是否达到 80% 行覆盖和 70% 分支覆盖',
    },
  ],
  
  async execute({ pattern = 'src/**/*.{ts,tsx,js,jsx}', minLine = 80, minBranch = 70, minFunction = 80 }, context): Promise<ToolResult> {
    try {
      const files = globSync(pattern, {
        cwd: context.cwd,
        ignore: ['**/node_modules/**', '**/dist/**', '**/*.test.ts'],
      });
      
      const coverage = await analyzeProjectCoverage(files, context.cwd);
      
      const lines: string[] = [];
      lines.push('# 覆盖率门禁检查\n');
      
      const checks = [
        { name: '行覆盖率', actual: coverage.summary.lineCoverage, required: minLine },
        { name: '分支覆盖率', actual: coverage.summary.branchCoverage, required: minBranch },
        { name: '函数覆盖率', actual: coverage.summary.functionCoverage, required: minFunction },
      ];
      
      let allPass = true;
      
      for (const check of checks) {
        const pass = check.actual >= check.required;
        const icon = pass ? '✅' : '❌';
        lines.push(`${icon} **${check.name}**: ${check.actual.toFixed(2)}% (要求 ≥ ${check.required}%)`);
        if (!pass) allPass = false;
      }
      
      lines.push('');
      
      if (allPass) {
        lines.push('🎉 所有覆盖率指标达标！');
        return {
          ok: true,
          output: lines.join('\n'),
          data: { passed: true, coverage: coverage.summary },
        };
      } else {
        lines.push('❌ 覆盖率未达标，请补充测试');
        return {
          ok: false,
          output: lines.join('\n'),
          data: { passed: false, coverage: coverage.summary },
        };
      }
    } catch (error) {
      return {
        ok: false,
        output: `门禁检查失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

export const testingTools = [
  generateTestsTool,
  generateFunctionTestTool,
  analyzeCoverageTool,
  fileCoverageTool,
  incrementalCoverageTool,
  generateCoverageBadgeTool,
  coverageGateTool,
];
