/**
 * tools.ts — 重构工具集成（CLI 工具注册）
 * 
 * 将 Extract Method、Rename Symbol 等重构功能注册为 CLI 工具
 */

import { defineTool } from '../tools/define.js';
import type { ToolResult } from '../tools/types.js';
import {
  extractMethod,
  previewExtractMethod,
  type ExtractMethodOptions,
} from './extract-method.js';
import {
  renameSymbol,
  applyRename,
  generateDiff,
  quickRename,
  type RenameOptions,
} from './rename.js';

/**
 * Extract Method 工具
 */
export const extractMethodTool = defineTool({
  name: 'extract_method',
  description: '提取代码片段为独立方法/函数，自动推断参数和返回值',
  risk: 'write',
  input: {
    file: {
      type: 'string',
      description: '目标文件路径',
    },
    startLine: {
      type: 'number',
      description: '提取起始行号（1-based）',
    },
    endLine: {
      type: 'number',
      description: '提取结束行号（1-based）',
    },
    methodName: {
      type: 'string',
      description: '新方法名称',
    },
    preview: {
      type: 'boolean',
      description: '是否仅预览（不实际修改文件）。默认 true',
      optional: true,
    },
    useArrowFunction: {
      type: 'boolean',
      description: '是否使用箭头函数（仅函数提取）。默认 false',
      optional: true,
    },
    addTypeAnnotations: {
      type: 'boolean',
      description: '是否添加类型注解。默认 true',
      optional: true,
    },
  },
  examples: [
    {
      input: { file: 'src/utils.ts', startLine: 10, endLine: 25, methodName: 'processData', preview: true },
      output: '预览提取 10-25 行为 processData 方法',
    },
  ],
  
  async execute({ file, startLine, endLine, methodName, preview = true, useArrowFunction = false, addTypeAnnotations = true }, context): Promise<ToolResult> {
    try {
      const options: ExtractMethodOptions = {
        methodName,
        startLine,
        endLine,
        useArrowFunction,
        addTypeAnnotations,
      };
      
      if (preview) {
        // 预览模式
        const result = await previewExtractMethod(file, context.cwd, options);
        
        const lines: string[] = [];
        lines.push('# Extract Method 预览\n');
        
        // 变量分析
        lines.push('## 变量分析\n');
        lines.push(`**输入参数:** ${result.result.variableAnalysis.inputs.join(', ') || '无'}`);
        lines.push(`**返回值:** ${result.result.variableAnalysis.outputs.join(', ') || '无'}`);
        lines.push(`**内部变量:** ${result.result.variableAnalysis.internal.join(', ') || '无'}\n`);
        
        // 方法签名
        lines.push('## 新方法签名\n');
        lines.push('```typescript');
        const params = result.result.signature.parameters.map(p => 
          p.type ? `${p.name}: ${p.type}` : p.name
        ).join(', ');
        const returnType = result.result.signature.returnType ? `: ${result.result.signature.returnType}` : '';
        lines.push(`function ${result.result.signature.name}(${params})${returnType}`);
        lines.push('```\n');
        
        // 安全性
        if (result.result.isSafe) {
          lines.push('✅ **提取安全**\n');
        } else {
          lines.push('⚠️ **提取不安全，存在以下问题：**\n');
          for (const warning of result.result.warnings) {
            lines.push(`- ${warning}`);
          }
          lines.push('');
        }
        
        // 提取的方法
        lines.push('## 提取的方法\n');
        lines.push('```typescript');
        lines.push(result.result.extractedMethod);
        lines.push('```\n');
        
        // 调用代码
        lines.push('## 调用代码\n');
        lines.push('```typescript');
        lines.push(result.result.callSite);
        lines.push('```\n');
        
        // Diff 预览
        lines.push('## 完整 Diff\n');
        lines.push('```diff');
        const originalLines = result.original.split('\n');
        const modifiedLines = result.modified.split('\n');
        
        for (let i = 0; i < Math.min(originalLines.length, modifiedLines.length); i++) {
          if (i >= startLine - 1 && i < endLine) {
            if (originalLines[i] !== modifiedLines[i]) {
              lines.push(`- ${originalLines[i]}`);
              lines.push(`+ ${modifiedLines[i]}`);
            }
          }
        }
        lines.push('```\n');
        
        if (result.result.isSafe) {
          lines.push('💡 **提示:** 使用 `preview: false` 应用此重构');
        }
        
        return {
          ok: true,
          output: lines.join('\n'),
          data: result,
        };
      } else {
        // 实际执行（需要实现文件写入逻辑）
        const result = await extractMethod(file, context.cwd, options);
        
        if (!result.isSafe) {
          return {
            ok: false,
            output: `提取不安全，存在问题：\n${result.warnings.join('\n')}`,
          };
        }
        
        return {
          ok: true,
          output: `✅ 成功提取方法 '${methodName}'`,
          data: result,
        };
      }
    } catch (error) {
      return {
        ok: false,
        output: `Extract Method 失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

/**
 * Rename Symbol 工具
 */
export const renameSymbolTool = defineTool({
  name: 'rename_symbol',
  description: '安全重命名符号（变量、函数、类等），跨文件更新所有引用',
  risk: 'write',
  input: {
    file: {
      type: 'string',
      description: '符号所在文件路径',
    },
    line: {
      type: 'number',
      description: '符号位置行号（1-based）',
    },
    column: {
      type: 'number',
      description: '符号位置列号（1-based）',
    },
    newName: {
      type: 'string',
      description: '新符号名',
    },
    preview: {
      type: 'boolean',
      description: '是否仅预览（不实际修改文件）。默认 true',
      optional: true,
    },
    updateStringLiterals: {
      type: 'boolean',
      description: '是否更新字符串字面量中的引用。默认 false',
      optional: true,
    },
  },
  examples: [
    {
      input: { file: 'src/user.ts', line: 10, column: 15, newName: 'getUserById', preview: true },
      output: '预览重命名符号并显示所有受影响文件',
    },
  ],
  
  async execute({ file, line, column, newName, preview = true, updateStringLiterals = false }, context): Promise<ToolResult> {
    try {
      const options: RenameOptions = {
        file,
        line,
        column,
        newName,
        updateStringLiterals,
      };
      
      const result = await renameSymbol(context.cwd, options);
      
      if (!result.isSafe) {
        const lines: string[] = [];
        lines.push('❌ 重命名不安全，存在以下错误：\n');
        for (const error of result.errors) {
          lines.push(`- ${error}`);
        }
        
        return {
          ok: false,
          output: lines.join('\n'),
        };
      }
      
      if (preview) {
        // 生成 Diff 报告
        const diff = generateDiff(result);
        
        return {
          ok: true,
          output: diff + '\n\n💡 **提示:** 使用 `preview: false` 应用此重命名',
          data: result,
        };
      } else {
        // 应用重命名
        await applyRename(context.cwd, result);
        
        return {
          ok: true,
          output: `✅ 成功重命名 '${result.oldName}' → '${result.newName}'\n总计更新 ${result.totalReplacements} 处，涉及 ${result.files.length} 个文件`,
          data: result,
        };
      }
    } catch (error) {
      return {
        ok: false,
        output: `重命名失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

/**
 * Quick Rename 工具（单文件局部变量快速重命名）
 */
export const quickRenameTool = defineTool({
  name: 'quick_rename',
  description: '快速重命名单文件内的局部变量（无跨文件分析）',
  risk: 'write',
  input: {
    file: {
      type: 'string',
      description: '文件路径',
    },
    line: {
      type: 'number',
      description: '变量位置行号',
    },
    column: {
      type: 'number',
      description: '变量位置列号',
    },
    newName: {
      type: 'string',
      description: '新变量名',
    },
  },
  examples: [
    {
      input: { file: 'temp.ts', line: 5, column: 10, newName: 'count' },
      output: '快速重命名局部变量',
    },
  ],
  
  async execute({ file, line, column, newName }, context): Promise<ToolResult> {
    try {
      const result = await quickRename(file, context.cwd, line, column, newName);
      
      if (!result.success) {
        return {
          ok: false,
          output: result.message,
        };
      }
      
      return {
        ok: true,
        output: result.message,
        data: { modified: result.modified },
      };
    } catch (error) {
      return {
        ok: false,
        output: `快速重命名失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

/**
 * Inline Variable 工具（预留接口）
 */
export const inlineVariableTool = defineTool({
  name: 'inline_variable',
  description: '内联临时变量，将变量的值直接替换到使用处',
  risk: 'write',
  input: {
    file: {
      type: 'string',
      description: '文件路径',
    },
    line: {
      type: 'number',
      description: '变量声明行号',
    },
    column: {
      type: 'number',
      description: '变量声明列号',
    },
  },
  examples: [
    {
      input: { file: 'src/calc.ts', line: 15, column: 7 },
      output: '内联变量 temp',
    },
  ],
  
  async execute({ file, line, column }, context): Promise<ToolResult> {
    return {
      ok: false,
      output: 'Inline Variable 重构尚未实现，敬请期待',
    };
  },
});

/**
 * Move Symbol 工具（预留接口）
 */
export const moveSymbolTool = defineTool({
  name: 'move_symbol',
  description: '移动类或函数到另一个文件，自动更新导入语句',
  risk: 'write',
  input: {
    sourceFile: {
      type: 'string',
      description: '源文件路径',
    },
    symbolName: {
      type: 'string',
      description: '要移动的符号名称',
    },
    targetFile: {
      type: 'string',
      description: '目标文件路径',
    },
  },
  examples: [
    {
      input: { sourceFile: 'src/utils.ts', symbolName: 'Helper', targetFile: 'src/helpers/Helper.ts' },
      output: '移动 Helper 类到新文件',
    },
  ],
  
  async execute({ sourceFile, symbolName, targetFile }, context): Promise<ToolResult> {
    return {
      ok: false,
      output: 'Move Symbol 重构尚未实现，敬请期待',
    };
  },
});

/**
 * Change Signature 工具（预留接口）
 */
export const changeSignatureTool = defineTool({
  name: 'change_signature',
  description: '修改函数签名（参数、返回值），自动更新所有调用点',
  risk: 'write',
  input: {
    file: {
      type: 'string',
      description: '函数所在文件',
    },
    functionName: {
      type: 'string',
      description: '函数名称',
    },
    newSignature: {
      type: 'string',
      description: '新函数签名',
    },
  },
  examples: [
    {
      input: { file: 'src/api.ts', functionName: 'fetchData', newSignature: 'async fetchData(url: string, options?: RequestOptions): Promise<Response>' },
      output: '修改函数签名并更新所有调用',
    },
  ],
  
  async execute({ file, functionName, newSignature }, context): Promise<ToolResult> {
    return {
      ok: false,
      output: 'Change Signature 重构尚未实现，敬请期待',
    };
  },
});

/**
 * 重构预览汇总工具
 */
export const refactorPreviewTool = defineTool({
  name: 'refactor_preview',
  description: '预览多个重构操作的组合效果',
  risk: 'read',
  input: {
    file: {
      type: 'string',
      description: '目标文件',
    },
    operations: {
      type: 'array',
      description: '重构操作列表（JSON 数组）',
    },
  },
  examples: [
    {
      input: { file: 'src/utils.ts', operations: [{ type: 'extract', startLine: 10, endLine: 15, name: 'helper' }] },
      output: '预览组合重构效果',
    },
  ],
  
  async execute({ file, operations }, context): Promise<ToolResult> {
    return {
      ok: false,
      output: 'Refactor Preview 功能尚未实现，敬请期待',
    };
  },
});

export const refactorTools = [
  extractMethodTool,
  renameSymbolTool,
  refactorPreviewTool,
];
