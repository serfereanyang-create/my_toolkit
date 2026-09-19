/**
 * define.ts — 简化的工具定义适配器
 * 
 * 将声明式的工具定义（input spec + examples + execute(input, {cwd})）转换为
 * registry 需要的 ToolDefinition（inputHint + validate + execute(input, ToolContext)）。
 * 
 * 新增的分析/重构/AI/测试/性能/文档工具都通过这个适配器注册，
 * 避免每个工具手写 validate 和 inputHint。
 */

import type { ToolRisk } from '../safety/policy.js';
import type { ToolContext, ToolDefinition, ToolResult } from './types.js';

/**
 * 输入字段规格
 */
export interface InputFieldSpec {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  optional?: boolean;
}

/**
 * 简化的工具执行上下文（新模块使用 cwd 语义）
 */
export interface SimpleToolContext {
  /** 工作区根目录（映射自 ToolContext.workspaceRoot） */
  cwd: string;
  /** LLM provider 配置（AI 工具使用；由 runtime 注入，可能为空对象） */
  providerConfig: Record<string, unknown>;
  /** 原始 ToolContext，需要审批/hook 等高级能力时使用 */
  raw: ToolContext;
}

/**
 * 简化的工具定义
 */
export interface SimpleToolSpec<TInput extends Record<string, any> = Record<string, any>> {
  name: string;
  description: string;
  risk: ToolRisk;
  input: Record<string, InputFieldSpec>;
  examples?: Array<{ input: Record<string, unknown>; output: string }>;
  execute(input: TInput, context: SimpleToolContext): Promise<ToolResult>;
}

/**
 * 根据字段类型生成示例值（用于 inputHint）
 */
function exampleValueFor(field: InputFieldSpec): unknown {
  switch (field.type) {
    case 'string': return 'value';
    case 'number': return 1;
    case 'boolean': return false;
    case 'array': return [];
    case 'object': return {};
  }
}

/**
 * 从 input spec 生成 inputHint JSON 示例。
 * 优先使用第一个 example 的输入，否则按字段类型构造。
 */
function buildInputHint(spec: SimpleToolSpec): string {
  if (spec.examples && spec.examples.length > 0) {
    return JSON.stringify(spec.examples[0].input);
  }
  
  const example: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(spec.input)) {
    if (!field.optional) {
      example[key] = exampleValueFor(field);
    }
  }
  return JSON.stringify(example);
}

/**
 * 单字段校验：类型不匹配时返回错误消息，通过时返回 null
 */
function checkField(key: string, value: unknown, field: InputFieldSpec): string | null {
  if (value === undefined || value === null) {
    return field.optional ? null : `missing required field "${key}"`;
  }
  
  switch (field.type) {
    case 'string':
      return typeof value === 'string' ? null : `"${key}" must be a string`;
    case 'number':
      return (typeof value === 'number' && Number.isFinite(value)) ? null : `"${key}" must be a number`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `"${key}" must be a boolean`;
    case 'array':
      return Array.isArray(value) ? null : `"${key}" must be an array`;
    case 'object':
      return (typeof value === 'object' && !Array.isArray(value)) ? null : `"${key}" must be an object`;
  }
}

/**
 * 将简化工具定义转换为 registry 可注册的 ToolDefinition
 */
export function defineTool<TInput extends Record<string, any> = Record<string, any>>(
  spec: SimpleToolSpec<TInput>
): ToolDefinition<TInput> {
  return {
    name: spec.name,
    description: spec.description,
    inputHint: buildInputHint(spec as SimpleToolSpec),
    risk: spec.risk,
    
    validate(input: unknown): TInput {
      const record = (typeof input === 'object' && input !== null && !Array.isArray(input))
        ? input as Record<string, unknown>
        : {};
      
      const errors: string[] = [];
      const cleaned: Record<string, unknown> = {};
      
      for (const [key, field] of Object.entries(spec.input)) {
        const error = checkField(key, record[key], field);
        if (error) {
          errors.push(error);
        } else if (record[key] !== undefined && record[key] !== null) {
          cleaned[key] = record[key];
        }
      }
      
      if (errors.length > 0) {
        throw new Error(errors.join('; '));
      }
      
      return cleaned as TInput;
    },
    
    async execute(input: TInput, context: ToolContext): Promise<ToolResult> {
      const simpleContext: SimpleToolContext = {
        cwd: context.workspaceRoot,
        providerConfig: ((context as unknown as Record<string, unknown>).providerConfig as Record<string, unknown>) ?? {},
        raw: context,
      };
      
      try {
        return await spec.execute(input, simpleContext);
      } catch (error) {
        return {
          ok: false,
          output: `${spec.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}
