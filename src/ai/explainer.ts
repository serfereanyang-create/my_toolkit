/**
 * explainer.ts — AI 代码解释器
 * 
 * 使用 LLM 解释代码片段、函数、类的作用和实现逻辑
 * 支持生成流程图（Mermaid）、序列图等可视化
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import { createProviderForConfig } from './provider-adapter.js';

/**
 * 代码解释请求
 */
export interface ExplainRequest {
  /** 代码片段或文件路径 */
  code?: string;
  file?: string;
  /** 解释的详细程度 */
  level: 'brief' | 'detailed' | 'expert';
  /** 是否生成流程图 */
  includeFlowchart?: boolean;
  /** 是否生成序列图 */
  includeSequenceDiagram?: boolean;
  /** 语言（中文/英文） */
  language?: 'zh' | 'en';
  /** 特定关注点（如性能、安全性） */
  focus?: string[];
}

/**
 * 代码解释结果
 */
export interface ExplainResult {
  /** 解释文本 */
  explanation: string;
  /** 流程图（Mermaid 格式） */
  flowchart?: string;
  /** 序列图（Mermaid 格式） */
  sequenceDiagram?: string;
  /** 复杂度评估 */
  complexity?: {
    level: 'low' | 'medium' | 'high';
    reasoning: string;
  };
  /** 改进建议 */
  suggestions?: string[];
}

/**
 * 提取代码元数据
 */
function extractCodeMetadata(code: string): {
  type: 'function' | 'class' | 'interface' | 'snippet';
  name?: string;
  parameters?: string[];
  returnType?: string;
  methods?: string[];
} {
  const sourceFile = ts.createSourceFile(
    'temp.ts',
    code,
    ts.ScriptTarget.Latest,
    true
  );
  
  let result: ReturnType<typeof extractCodeMetadata> = { type: 'snippet' };
  
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node)) {
      result.type = 'function';
      result.name = node.name?.text;
      result.parameters = node.parameters.map(p => 
        ts.isIdentifier(p.name) ? p.name.text : '?'
      );
      result.returnType = node.type?.getText(sourceFile);
    } else if (ts.isClassDeclaration(node)) {
      result.type = 'class';
      result.name = node.name?.text;
      result.methods = node.members
        .filter(m => ts.isMethodDeclaration(m))
        .map(m => ts.isIdentifier(m.name) ? m.name.text : '?');
    } else if (ts.isInterfaceDeclaration(node)) {
      result.type = 'interface';
      result.name = node.name.text;
    }
    
    ts.forEachChild(node, visit);
  }
  
  visit(sourceFile);
  return result;
}

/**
 * 构建解释提示词
 */
function buildExplanationPrompt(
  code: string,
  metadata: ReturnType<typeof extractCodeMetadata>,
  options: ExplainRequest
): string {
  const parts: string[] = [];
  
  // 系统提示
  if (options.language === 'zh') {
    parts.push('你是一位经验丰富的代码解释专家。用清晰、准确的中文解释代码的作用、实现逻辑和设计思路。');
  } else {
    parts.push('You are an experienced code explanation expert. Explain the code clearly and accurately.');
  }
  
  parts.push('');
  
  // 代码上下文
  if (metadata.type === 'function' && metadata.name) {
    parts.push(`Function: ${metadata.name}`);
    if (metadata.parameters) {
      parts.push(`Parameters: ${metadata.parameters.join(', ')}`);
    }
    if (metadata.returnType) {
      parts.push(`Return type: ${metadata.returnType}`);
    }
  } else if (metadata.type === 'class' && metadata.name) {
    parts.push(`Class: ${metadata.name}`);
    if (metadata.methods) {
      parts.push(`Methods: ${metadata.methods.join(', ')}`);
    }
  }
  
  parts.push('');
  parts.push('Code to explain:');
  parts.push('```typescript');
  parts.push(code);
  parts.push('```');
  parts.push('');
  
  // 解释要求
  if (options.language === 'zh') {
    parts.push('请按以下结构解释：');
    parts.push('');
    
    if (options.level === 'brief') {
      parts.push('1. **功能概述**：一句话说明这段代码做什么');
      parts.push('2. **关键逻辑**：主要的实现步骤（2-3点）');
    } else if (options.level === 'detailed') {
      parts.push('1. **功能概述**：详细说明代码的用途和目标');
      parts.push('2. **实现逻辑**：逐步解释代码的执行流程');
      parts.push('3. **设计考虑**：为什么这样实现，有哪些设计决策');
      parts.push('4. **边界情况**：如何处理特殊情况或错误');
    } else {
      parts.push('1. **架构分析**：代码在系统中的角色和职责');
      parts.push('2. **详细实现**：深入解释每个关键步骤和算法');
      parts.push('3. **性能考虑**：时间/空间复杂度分析');
      parts.push('4. **潜在问题**：可能的边界情况、错误处理、并发问题');
      parts.push('5. **改进建议**：如何优化或重构这段代码');
    }
    
    if (options.focus && options.focus.length > 0) {
      parts.push('');
      parts.push(`特别关注：${options.focus.join('、')}`);
    }
    
    if (options.includeFlowchart) {
      parts.push('');
      parts.push('**流程图**：使用 Mermaid 语法生成执行流程图（flowchart TD）');
    }
    
    if (options.includeSequenceDiagram) {
      parts.push('');
      parts.push('**序列图**：如果涉及多个对象交互，使用 Mermaid 语法生成序列图（sequenceDiagram）');
    }
  } else {
    parts.push('Please explain following this structure:');
    parts.push('');
    
    if (options.level === 'brief') {
      parts.push('1. **Purpose**: One-line summary of what this code does');
      parts.push('2. **Key Logic**: Main implementation steps (2-3 points)');
    } else if (options.level === 'detailed') {
      parts.push('1. **Overview**: Detailed purpose and objectives');
      parts.push('2. **Implementation**: Step-by-step execution flow');
      parts.push('3. **Design**: Why implemented this way, design decisions');
      parts.push('4. **Edge Cases**: How special cases or errors are handled');
    } else {
      parts.push('1. **Architecture**: Role and responsibilities in the system');
      parts.push('2. **Deep Dive**: Detailed explanation of key steps and algorithms');
      parts.push('3. **Performance**: Time/space complexity analysis');
      parts.push('4. **Issues**: Edge cases, error handling, concurrency concerns');
      parts.push('5. **Improvements**: Optimization or refactoring suggestions');
    }
    
    if (options.focus && options.focus.length > 0) {
      parts.push('');
      parts.push(`Focus on: ${options.focus.join(', ')}`);
    }
    
    if (options.includeFlowchart) {
      parts.push('');
      parts.push('**Flowchart**: Generate execution flowchart using Mermaid syntax (flowchart TD)');
    }
    
    if (options.includeSequenceDiagram) {
      parts.push('');
      parts.push('**Sequence Diagram**: If multiple objects interact, generate sequence diagram using Mermaid syntax');
    }
  }
  
  return parts.join('\n');
}

/**
 * 解析 AI 响应
 */
function parseExplanationResponse(response: string): Omit<ExplainResult, 'explanation'> {
  const result: Omit<ExplainResult, 'explanation'> = {};
  
  // 提取 Mermaid 流程图
  const flowchartMatch = response.match(/```mermaid\s*\n(flowchart\s+[^\n]+[\s\S]*?)```/);
  if (flowchartMatch) {
    result.flowchart = flowchartMatch[1].trim();
  }
  
  // 提取序列图
  const sequenceMatch = response.match(/```mermaid\s*\n(sequenceDiagram[\s\S]*?)```/);
  if (sequenceMatch) {
    result.sequenceDiagram = sequenceMatch[1].trim();
  }
  
  // 提取复杂度评估
  const complexityMatch = response.match(/复杂度[：:]\s*(低|中|高|low|medium|high)/i);
  if (complexityMatch) {
    const level = complexityMatch[1].toLowerCase();
    result.complexity = {
      level: (level === '低' || level === 'low') ? 'low' :
             (level === '高' || level === 'high') ? 'high' : 'medium',
      reasoning: '基于代码结构和逻辑复杂性评估',
    };
  }
  
  // 提取改进建议
  const suggestionsSection = response.match(/改进建议|优化建议|Improvements|Suggestions[：:]([\s\S]*?)(?=\n\n|$)/i);
  if (suggestionsSection) {
    const suggestions = suggestionsSection[1]
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('-') || line.match(/^\d+\./))
      .map(line => line.replace(/^[-\d+.]\s*/, '').trim());
    
    if (suggestions.length > 0) {
      result.suggestions = suggestions;
    }
  }
  
  return result;
}

/**
 * 解释代码
 */
export async function explainCode(
  request: ExplainRequest,
  context: { cwd: string; providerConfig: any }
): Promise<ExplainResult> {
  // 获取代码
  let code = request.code;
  
  if (!code && request.file) {
    const filePath = resolve(context.cwd, request.file);
    code = await readFile(filePath, 'utf-8');
  }
  
  if (!code) {
    throw new Error('必须提供 code 或 file 参数');
  }
  
  // 提取元数据
  const metadata = extractCodeMetadata(code);
  
  // 构建提示词
  const prompt = buildExplanationPrompt(code, metadata, request);
  
  // 调用 LLM
  const provider = createProviderForConfig(context.providerConfig, context.cwd);
  
  const response = await provider.complete({
    messages: [
      { role: 'user', content: prompt },
    ],
    model: context.providerConfig.model || 'gpt-4',
    temperature: 0.3, // 较低温度保证解释准确性
    maxTokens: 2000,
  });
  
  if (!response.content) {
    throw new Error('AI 响应为空');
  }
  
  // 解析响应
  const parsed = parseExplanationResponse(response.content);
  
  return {
    explanation: response.content,
    ...parsed,
  };
}

/**
 * 生成函数文档注释
 */
export async function generateDocComment(
  code: string,
  context: { cwd: string; providerConfig: any }
): Promise<string> {
  const sourceFile = ts.createSourceFile(
    'temp.ts',
    code,
    ts.ScriptTarget.Latest,
    true
  );
  
  // 查找第一个函数
  let found: ts.FunctionDeclaration | undefined;
  
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && !found) {
      found = node;
    }
    ts.forEachChild(node, visit);
  }
  
  visit(sourceFile);
  
  if (!found) {
    throw new Error('未找到函数定义');
  }
  
  const functionNode: ts.FunctionDeclaration = found;
  const name = functionNode.name?.text || 'anonymous';
  const params = functionNode.parameters.map(p => ({
    name: ts.isIdentifier(p.name) ? p.name.text : '?',
    type: p.type?.getText(sourceFile),
  }));
  const returnType = functionNode.type?.getText(sourceFile);
  
  // 构建提示词
  const prompt = `生成 JSDoc 注释，要求：
1. 一句话描述函数功能
2. 每个参数的 @param 说明（包括类型）
3. @returns 说明返回值
4. 如果有异常，添加 @throws 说明
5. 如果有示例，添加 @example

Function:
\`\`\`typescript
${code}
\`\`\`

仅返回 JSDoc 注释文本，不要包含代码。`;
  
  const provider = createProviderForConfig(context.providerConfig, context.cwd);
  
  const response = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    model: context.providerConfig.model || 'gpt-4',
    temperature: 0.2,
    maxTokens: 500,
  });
  
  return response.content || '';
}

/**
 * 比较两段代码的差异（语义级别）
 */
export async function explainCodeDiff(
  oldCode: string,
  newCode: string,
  context: { cwd: string; providerConfig: any }
): Promise<string> {
  const prompt = `分析以下代码修改，说明：
1. 做了哪些改动（功能层面，不是逐行对比）
2. 为什么要这样改（改进了什么）
3. 是否有潜在问题或需要注意的地方

旧代码：
\`\`\`typescript
${oldCode}
\`\`\`

新代码：
\`\`\`typescript
${newCode}
\`\`\``;
  
  const provider = createProviderForConfig(context.providerConfig, context.cwd);
  
  const response = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    model: context.providerConfig.model || 'gpt-4',
    temperature: 0.3,
    maxTokens: 1000,
  });
  
  return response.content || '';
}

/**
 * 生成学习路径（对复杂代码）
 */
export async function generateLearningPath(
  code: string,
  context: { cwd: string; providerConfig: any }
): Promise<{
  prerequisites: string[];
  steps: Array<{ title: string; description: string }>;
  resources: string[];
}> {
  const prompt = `这段代码较为复杂，生成一个学习路径，帮助新手理解：

\`\`\`typescript
${code}
\`\`\`

返回 JSON 格式：
{
  "prerequisites": ["需要先了解的概念1", "概念2"],
  "steps": [
    { "title": "步骤1标题", "description": "详细说明" },
    { "title": "步骤2标题", "description": "详细说明" }
  ],
  "resources": ["推荐资源1", "资源2"]
}`;
  
  const provider = createProviderForConfig(context.providerConfig, context.cwd);
  
  const response = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    model: context.providerConfig.model || 'gpt-4',
    temperature: 0.4,
    maxTokens: 1000,
  });
  
  try {
    const jsonMatch = response.content?.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch {
    // JSON 解析失败，返回默认值
  }
  
  return {
    prerequisites: [],
    steps: [{ title: '理解代码', description: response.content || '' }],
    resources: [],
  };
}

/**
 * 批量解释（用于整个文件）
 */
export async function explainFile(
  filePath: string,
  context: { cwd: string; providerConfig: any },
  options: { language?: 'zh' | 'en' } = {}
): Promise<{
  overview: string;
  functions: Array<{ name: string; explanation: string }>;
  classes: Array<{ name: string; explanation: string }>;
}> {
  const absolutePath = resolve(context.cwd, filePath);
  const content = await readFile(absolutePath, 'utf-8');
  
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true
  );
  
  const functions: Array<{ name: string; code: string }> = [];
  const classes: Array<{ name: string; code: string }> = [];
  
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      functions.push({
        name: node.name.text,
        code: node.getText(sourceFile),
      });
    } else if (ts.isClassDeclaration(node) && node.name) {
      classes.push({
        name: node.name.text,
        code: node.getText(sourceFile),
      });
    }
    ts.forEachChild(node, visit);
  }
  
  visit(sourceFile);
  
  // 生成文件概述
  const overviewPrompt = options.language === 'zh'
    ? `用一段话概述这个文件的作用和主要功能：\n\n\`\`\`typescript\n${content.substring(0, 1000)}...\n\`\`\``
    : `Summarize the purpose and main functionality of this file:\n\n\`\`\`typescript\n${content.substring(0, 1000)}...\n\`\`\``;
  
  const provider = createProviderForConfig(context.providerConfig, context.cwd);
  
  const overviewResponse = await provider.complete({
    messages: [{ role: 'user', content: overviewPrompt }],
    model: context.providerConfig.model || 'gpt-4',
    temperature: 0.3,
    maxTokens: 300,
  });
  
  // 解释每个函数和类（并发处理）
  const functionExplanations = await Promise.all(
    functions.slice(0, 10).map(async (func) => {
      const result = await explainCode(
        {
          code: func.code,
          level: 'brief',
          language: options.language,
        },
        context
      );
      return {
        name: func.name,
        explanation: result.explanation,
      };
    })
  );
  
  const classExplanations = await Promise.all(
    classes.slice(0, 10).map(async (cls) => {
      const result = await explainCode(
        {
          code: cls.code,
          level: 'brief',
          language: options.language,
        },
        context
      );
      return {
        name: cls.name,
        explanation: result.explanation,
      };
    })
  );
  
  return {
    overview: overviewResponse.content || '',
    functions: functionExplanations,
    classes: classExplanations,
  };
}
