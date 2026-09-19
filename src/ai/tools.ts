/**
 * tools.ts — AI 辅助工具集成（CLI 工具注册）
 * 
 * 将 AI 代码解释、审查、文档生成等功能注册为 CLI 工具
 */

import { defineTool } from '../tools/define.js';
import type { ToolResult } from '../tools/types.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  explainCode,
  generateDocComment,
  explainCodeDiff,
  generateLearningPath,
  explainFile,
  type ExplainRequest,
} from './explainer.js';
import {
  reviewCode,
  reviewFile,
  reviewDiff,
  generateReviewReport,
  quickSecurityCheck,
  type ReviewOptions,
} from './reviewer.js';

/**
 * 代码解释工具
 */
export const explainCodeTool = defineTool({
  name: 'explain_code',
  description: 'AI 解释代码片段、函数或类的作用和实现逻辑，可生成流程图',
  risk: 'read',
  input: {
    code: {
      type: 'string',
      description: '要解释的代码片段',
      optional: true,
    },
    file: {
      type: 'string',
      description: '要解释的文件路径（与 code 二选一）',
      optional: true,
    },
    level: {
      type: 'string',
      description: '解释详细程度: brief | detailed | expert。默认 detailed',
      optional: true,
    },
    flowchart: {
      type: 'boolean',
      description: '是否生成 Mermaid 流程图。默认 false',
      optional: true,
    },
    language: {
      type: 'string',
      description: '输出语言: zh | en。默认 zh',
      optional: true,
    },
  },
  examples: [
    {
      input: { file: 'src/utils/parser.ts', level: 'detailed' },
      output: '详细解释 parser.ts 的实现逻辑',
    },
    {
      input: { code: 'function quickSort(arr) { ... }', level: 'brief', flowchart: true },
      output: '简要解释快速排序并生成流程图',
    },
  ],
  
  async execute({ code, file, level = 'detailed', flowchart = false, language = 'zh' }, context): Promise<ToolResult> {
    try {
      if (!code && !file) {
        return {
          ok: false,
          output: '必须提供 code 或 file 参数',
        };
      }
      
      const request: ExplainRequest = {
        code,
        file,
        level: level as 'brief' | 'detailed' | 'expert',
        includeFlowchart: flowchart,
        language: language as 'zh' | 'en',
      };
      
      const result = await explainCode(request, {
        cwd: context.cwd,
        providerConfig: context.providerConfig || {},
      });
      
      const lines: string[] = [];
      lines.push('# 代码解释\n');
      lines.push(result.explanation);
      lines.push('');
      
      if (result.flowchart) {
        lines.push('## 流程图\n');
        lines.push('```mermaid');
        lines.push(result.flowchart);
        lines.push('```\n');
      }
      
      if (result.sequenceDiagram) {
        lines.push('## 序列图\n');
        lines.push('```mermaid');
        lines.push(result.sequenceDiagram);
        lines.push('```\n');
      }
      
      if (result.complexity) {
        lines.push('## 复杂度评估\n');
        lines.push(`**级别:** ${result.complexity.level}`);
        lines.push(`**说明:** ${result.complexity.reasoning}\n`);
      }
      
      if (result.suggestions && result.suggestions.length > 0) {
        lines.push('## 改进建议\n');
        for (const suggestion of result.suggestions) {
          lines.push(`- ${suggestion}`);
        }
        lines.push('');
      }
      
      return {
        ok: true,
        output: lines.join('\n'),
        data: result,
      };
    } catch (error) {
      return {
        ok: false,
        output: `代码解释失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

/**
 * 代码审查工具
 */
export const reviewCodeTool = defineTool({
  name: 'review_code',
  description: 'AI 代码审查，检查安全、性能、可维护性、最佳实践等问题',
  risk: 'read',
  input: {
    code: {
      type: 'string',
      description: '要审查的代码',
      optional: true,
    },
    file: {
      type: 'string',
      description: '要审查的文件路径（与 code 二选一）',
      optional: true,
    },
    categories: {
      type: 'array',
      description: '关注的审查类别数组，可选: security, performance, maintainability, correctness, style, best-practice。默认全部',
      optional: true,
    },
    includeStaticAnalysis: {
      type: 'boolean',
      description: '是否包含静态分析结果。默认 true',
      optional: true,
    },
  },
  examples: [
    {
      input: { file: 'src/api/auth.ts', categories: ['security', 'best-practice'] },
      output: '审查认证代码的安全性和最佳实践',
    },
    {
      input: { code: 'function process(data) { ... }', includeStaticAnalysis: true },
      output: '审查函数并包含静态分析',
    },
  ],
  
  async execute({ code, file, categories, includeStaticAnalysis = true }, context): Promise<ToolResult> {
    try {
      if (!code && !file) {
        return {
          ok: false,
          output: '必须提供 code 或 file 参数',
        };
      }
      
      let codeToReview = code;
      if (!codeToReview && file) {
        const filePath = resolve(context.cwd, file);
        codeToReview = await readFile(filePath, 'utf-8');
      }
      
      const options: ReviewOptions = {
        categories: categories as any,
        includeStaticAnalysis,
        includeExamples: true,
        language: 'zh',
      };
      
      const result = await reviewCode(codeToReview!, options, {
        cwd: context.cwd,
        providerConfig: context.providerConfig || {},
      });
      
      const report = generateReviewReport(result, 'zh');
      
      return {
        ok: true,
        output: report,
        data: result,
      };
    } catch (error) {
      return {
        ok: false,
        output: `代码审查失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

/**
 * 生成文档注释工具
 */
export const generateDocTool = defineTool({
  name: 'generate_doc_comment',
  description: '为函数自动生成 JSDoc 注释，包括参数、返回值、示例',
  risk: 'read',
  input: {
    code: {
      type: 'string',
      description: '函数代码',
    },
  },
  examples: [
    {
      input: { code: 'function calculateTotal(items: Item[], tax: number): number { ... }' },
      output: '生成完整的 JSDoc 注释',
    },
  ],
  
  async execute({ code }, context): Promise<ToolResult> {
    try {
      const docComment = await generateDocComment(code, {
        cwd: context.cwd,
        providerConfig: context.providerConfig || {},
      });
      
      return {
        ok: true,
        output: `生成的 JSDoc 注释：\n\n${docComment}`,
        data: { docComment },
      };
    } catch (error) {
      return {
        ok: false,
        output: `文档生成失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

/**
 * 代码差异解释工具
 */
export const explainDiffTool = defineTool({
  name: 'explain_code_diff',
  description: '解释代码修改的意图和影响（语义级别，非逐行对比）',
  risk: 'read',
  input: {
    oldCode: {
      type: 'string',
      description: '修改前的代码',
    },
    newCode: {
      type: 'string',
      description: '修改后的代码',
    },
  },
  examples: [
    {
      input: { oldCode: 'function old() { ... }', newCode: 'function new() { ... }' },
      output: '解释代码改动的目的和影响',
    },
  ],
  
  async execute({ oldCode, newCode }, context): Promise<ToolResult> {
    try {
      const explanation = await explainCodeDiff(oldCode, newCode, {
        cwd: context.cwd,
        providerConfig: context.providerConfig || {},
      });
      
      return {
        ok: true,
        output: `代码变更分析：\n\n${explanation}`,
        data: { explanation },
      };
    } catch (error) {
      return {
        ok: false,
        output: `差异解释失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

/**
 * 学习路径生成工具
 */
export const generateLearningPathTool = defineTool({
  name: 'generate_learning_path',
  description: '为复杂代码生成学习路径，帮助理解',
  risk: 'read',
  input: {
    code: {
      type: 'string',
      description: '要学习的复杂代码',
    },
  },
  examples: [
    {
      input: { code: 'class ComplexAlgorithm { ... }' },
      output: '生成循序渐进的学习步骤',
    },
  ],
  
  async execute({ code }, context): Promise<ToolResult> {
    try {
      const path = await generateLearningPath(code, {
        cwd: context.cwd,
        providerConfig: context.providerConfig || {},
      });
      
      const lines: string[] = [];
      lines.push('# 学习路径\n');
      
      if (path.prerequisites.length > 0) {
        lines.push('## 前置知识\n');
        for (const prereq of path.prerequisites) {
          lines.push(`- ${prereq}`);
        }
        lines.push('');
      }
      
      lines.push('## 学习步骤\n');
      for (let i = 0; i < path.steps.length; i++) {
        const step = path.steps[i];
        lines.push(`### ${i + 1}. ${step.title}`);
        lines.push(step.description);
        lines.push('');
      }
      
      if (path.resources.length > 0) {
        lines.push('## 推荐资源\n');
        for (const resource of path.resources) {
          lines.push(`- ${resource}`);
        }
        lines.push('');
      }
      
      return {
        ok: true,
        output: lines.join('\n'),
        data: path,
      };
    } catch (error) {
      return {
        ok: false,
        output: `学习路径生成失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

/**
 * 文件解释工具
 */
export const explainFileTool = defineTool({
  name: 'explain_file',
  description: '解释整个文件的结构和功能，包括所有函数和类',
  risk: 'read',
  input: {
    file: {
      type: 'string',
      description: '要解释的文件路径',
    },
  },
  examples: [
    {
      input: { file: 'src/core/engine.ts' },
      output: '解释文件的整体架构和每个组件',
    },
  ],
  
  async execute({ file }, context): Promise<ToolResult> {
    try {
      const result = await explainFile(file, {
        cwd: context.cwd,
        providerConfig: context.providerConfig || {},
      }, { language: 'zh' });
      
      const lines: string[] = [];
      lines.push('# 文件解释\n');
      lines.push('## 概述\n');
      lines.push(result.overview);
      lines.push('');
      
      if (result.functions.length > 0) {
        lines.push('## 函数\n');
        for (const func of result.functions) {
          lines.push(`### ${func.name}`);
          lines.push(func.explanation);
          lines.push('');
        }
      }
      
      if (result.classes.length > 0) {
        lines.push('## 类\n');
        for (const cls of result.classes) {
          lines.push(`### ${cls.name}`);
          lines.push(cls.explanation);
          lines.push('');
        }
      }
      
      return {
        ok: true,
        output: lines.join('\n'),
        data: result,
      };
    } catch (error) {
      return {
        ok: false,
        output: `文件解释失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

/**
 * Git diff 审查工具
 */
export const reviewDiffTool = defineTool({
  name: 'review_git_diff',
  description: '审查 Git diff，评估代码变更的质量和影响',
  risk: 'read',
  input: {
    diff: {
      type: 'string',
      description: 'Git diff 内容（可通过 git diff 命令获取）',
    },
  },
  examples: [
    {
      input: { diff: 'diff --git a/... (git diff output)' },
      output: '审查代码变更',
    },
  ],
  
  async execute({ diff }, context): Promise<ToolResult> {
    try {
      const result = await reviewDiff(diff, {
        includeStaticAnalysis: false,
        language: 'zh',
      }, {
        cwd: context.cwd,
        providerConfig: context.providerConfig || {},
      });
      
      const lines: string[] = [];
      lines.push('# Git Diff 审查\n');
      lines.push('## 总体评估\n');
      lines.push(result.overallAssessment);
      lines.push('');
      
      if (result.fileReviews.length > 0) {
        lines.push('## 具体问题\n');
        for (const fileReview of result.fileReviews) {
          lines.push(`### ${fileReview.file}\n`);
          
          for (const comment of fileReview.comments) {
            const icon = 
              comment.severity === 'critical' ? '🔴' :
              comment.severity === 'error' ? '🟠' :
              comment.severity === 'warning' ? '🟡' : 'ℹ️';
            
            lines.push(`${icon} **行 ${comment.line}** [${comment.severity}]`);
            lines.push(`  ${comment.message}`);
            
            if (comment.suggestion) {
              lines.push(`  💡 ${comment.suggestion}`);
            }
            
            lines.push('');
          }
        }
      }
      
      return {
        ok: true,
        output: lines.join('\n'),
        data: result,
      };
    } catch (error) {
      return {
        ok: false,
        output: `Diff 审查失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

/**
 * 快速安全检查工具
 */
export const securityCheckTool = defineTool({
  name: 'quick_security_check',
  description: '快速安全检查，专注于常见安全漏洞（SQL注入、XSS、CSRF等）',
  risk: 'read',
  input: {
    code: {
      type: 'string',
      description: '要检查的代码',
      optional: true,
    },
    file: {
      type: 'string',
      description: '要检查的文件路径（与 code 二选一）',
      optional: true,
    },
  },
  examples: [
    {
      input: { file: 'src/api/user.ts' },
      output: '快速检查用户 API 的安全问题',
    },
  ],
  
  async execute({ code, file }, context): Promise<ToolResult> {
    try {
      if (!code && !file) {
        return {
          ok: false,
          output: '必须提供 code 或 file 参数',
        };
      }
      
      let codeToCheck = code;
      if (!codeToCheck && file) {
        const filePath = resolve(context.cwd, file);
        codeToCheck = await readFile(filePath, 'utf-8');
      }
      
      const comments = await quickSecurityCheck(codeToCheck!, {
        cwd: context.cwd,
        providerConfig: context.providerConfig || {},
      });
      
      if (comments.length === 0) {
        return {
          ok: true,
          output: '✅ 未发现明显的安全问题',
          data: { comments },
        };
      }
      
      const lines: string[] = [];
      lines.push(`⚠️ 发现 ${comments.length} 个安全问题：\n`);
      
      for (const comment of comments) {
        const icon = 
          comment.severity === 'critical' ? '🔴' :
          comment.severity === 'error' ? '🟠' : '🟡';
        
        lines.push(`${icon} **行 ${comment.line}** [${comment.severity}]`);
        lines.push(`  ${comment.message}`);
        
        if (comment.suggestion) {
          lines.push(`  💡 **修复建议:** ${comment.suggestion}`);
        }
        
        lines.push('');
      }
      
      return {
        ok: true,
        output: lines.join('\n'),
        data: { comments },
      };
    } catch (error) {
      return {
        ok: false,
        output: `安全检查失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

export const aiTools = [
  explainCodeTool,
  reviewCodeTool,
  securityCheckTool,
];
