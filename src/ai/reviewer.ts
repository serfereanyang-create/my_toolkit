/**
 * reviewer.ts — AI 代码审查助手
 * 
 * 使用 LLM 进行代码审查，检查：
 * - 安全漏洞
 * - 性能问题
 * - 代码风格和可读性
 * - 最佳实践违规
 * - 潜在 bug
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import { createProviderForConfig } from './provider-adapter.js';
import { analyzeFileComplexity } from '../analysis/complexity.js';
import { analyzeFileSmells } from '../analysis/smells.js';

/**
 * 审查严重级别
 */
export type ReviewSeverity = 'info' | 'warning' | 'error' | 'critical';

/**
 * 审查类别
 */
export type ReviewCategory = 
  | 'security'        // 安全问题
  | 'performance'     // 性能问题
  | 'maintainability' // 可维护性
  | 'correctness'     // 正确性
  | 'style'           // 代码风格
  | 'best-practice';  // 最佳实践

/**
 * 审查意见
 */
export interface ReviewComment {
  category: ReviewCategory;
  severity: ReviewSeverity;
  line: number;
  message: string;
  suggestion?: string;
  example?: string;
}

/**
 * 代码审查结果
 */
export interface CodeReviewResult {
  /** 总体评分 (0-100) */
  score: number;
  /** 总体评价 */
  summary: string;
  /** 具体审查意见 */
  comments: ReviewComment[];
  /** 优点 */
  strengths: string[];
  /** 需要改进的地方 */
  improvements: string[];
  /** 静态分析结果 */
  staticAnalysis?: {
    complexity: any;
    smells: any;
  };
}

/**
 * 审查配置
 */
export interface ReviewOptions {
  /** 关注的类别 */
  categories?: ReviewCategory[];
  /** 是否包含静态分析 */
  includeStaticAnalysis?: boolean;
  /** 是否生成示例代码 */
  includeExamples?: boolean;
  /** 语言 */
  language?: 'zh' | 'en';
}

/**
 * 构建审查提示词
 */
function buildReviewPrompt(
  code: string,
  options: ReviewOptions,
  staticAnalysis?: { complexity: any; smells: any }
): string {
  const parts: string[] = [];
  
  if (options.language === 'zh') {
    parts.push('你是一位资深代码审查专家。请仔细审查以下代码，从多个维度给出专业意见。');
  } else {
    parts.push('You are a senior code review expert. Please carefully review the following code and provide professional feedback from multiple dimensions.');
  }
  
  parts.push('');
  parts.push('Code to review:');
  parts.push('```typescript');
  parts.push(code);
  parts.push('```');
  parts.push('');
  
  // 静态分析结果
  if (staticAnalysis) {
    if (options.language === 'zh') {
      parts.push('静态分析发现：');
      
      if (staticAnalysis.complexity) {
        const avgCyclomatic = staticAnalysis.complexity.averageCyclomatic || 0;
        const avgCognitive = staticAnalysis.complexity.averageCognitive || 0;
        parts.push(`- 平均圈复杂度: ${avgCyclomatic.toFixed(2)}`);
        parts.push(`- 平均认知复杂度: ${avgCognitive.toFixed(2)}`);
        
        if (staticAnalysis.complexity.highRiskCount > 0) {
          parts.push(`- 高风险函数: ${staticAnalysis.complexity.highRiskCount} 个`);
        }
      }
      
      if (staticAnalysis.smells && staticAnalysis.smells.smells.length > 0) {
        parts.push(`- 代码异味: ${staticAnalysis.smells.smells.length} 处`);
        const topSmells = staticAnalysis.smells.smells.slice(0, 3);
        for (const smell of topSmells) {
          parts.push(`  * ${smell.type}: ${smell.message}`);
        }
      }
    } else {
      parts.push('Static analysis found:');
      // 英文版本类似
    }
    
    parts.push('');
  }
  
  // 审查要求
  if (options.language === 'zh') {
    parts.push('请按以下格式返回审查结果：');
    parts.push('');
    parts.push('## 总体评分');
    parts.push('评分: [0-100]');
    parts.push('评价: [一段话总结代码质量]');
    parts.push('');
    parts.push('## 优点');
    parts.push('- [优点1]');
    parts.push('- [优点2]');
    parts.push('');
    parts.push('## 需要改进');
    parts.push('- [改进点1]');
    parts.push('- [改进点2]');
    parts.push('');
    parts.push('## 具体问题');
    
    const categories = options.categories || ['security', 'performance', 'maintainability', 'correctness', 'style', 'best-practice'];
    
    for (const cat of categories) {
      const catName = {
        security: '安全性',
        performance: '性能',
        maintainability: '可维护性',
        correctness: '正确性',
        style: '代码风格',
        'best-practice': '最佳实践',
      }[cat];
      
      parts.push('');
      parts.push(`### ${catName}`);
      parts.push('[如果有问题，以 "行X: [严重级别] 问题描述 → 建议" 格式列出]');
      if (options.includeExamples) {
        parts.push('[如需要，提供修改示例代码]');
      }
    }
  } else {
    parts.push('Please return review results in the following format:');
    // 英文版本
  }
  
  return parts.join('\n');
}

/**
 * 解析审查响应
 */
function parseReviewResponse(response: string, language: 'zh' | 'en' = 'zh'): Omit<CodeReviewResult, 'staticAnalysis'> {
  const comments: ReviewComment[] = [];
  const strengths: string[] = [];
  const improvements: string[] = [];
  
  // 提取评分
  const scoreMatch = response.match(/评分[：:]\s*(\d+)|Score[：:]\s*(\d+)/i);
  const score = scoreMatch ? parseInt(scoreMatch[1] || scoreMatch[2]) : 75;
  
  // 提取总体评价
  const summaryMatch = response.match(/评价[：:]\s*(.+)|Summary[：:]\s*(.+)/i);
  const summary = summaryMatch ? (summaryMatch[1] || summaryMatch[2]).trim() : '';
  
  // 提取优点
  const strengthsSection = response.match(/##\s*优点|##\s*Strengths([\s\S]*?)(?=##|$)/i);
  if (strengthsSection) {
    const lines = strengthsSection[1].split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('-') || trimmed.startsWith('*')) {
        strengths.push(trimmed.replace(/^[-*]\s*/, ''));
      }
    }
  }
  
  // 提取改进点
  const improvementsSection = response.match(/##\s*需要改进|##\s*Improvements([\s\S]*?)(?=##|$)/i);
  if (improvementsSection) {
    const lines = improvementsSection[1].split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('-') || trimmed.startsWith('*')) {
        improvements.push(trimmed.replace(/^[-*]\s*/, ''));
      }
    }
  }
  
  // 提取具体问题
  const categoryMap: Record<string, ReviewCategory> = {
    '安全性': 'security',
    'Security': 'security',
    '性能': 'performance',
    'Performance': 'performance',
    '可维护性': 'maintainability',
    'Maintainability': 'maintainability',
    '正确性': 'correctness',
    'Correctness': 'correctness',
    '代码风格': 'style',
    'Style': 'style',
    '最佳实践': 'best-practice',
    'Best Practice': 'best-practice',
  };
  
  const problemsSection = response.match(/##\s*具体问题|##\s*Issues([\s\S]*?)$/i);
  if (problemsSection) {
    const text = problemsSection[1];
    
    // 按分类提取
    for (const [catName, catType] of Object.entries(categoryMap)) {
      const regex = new RegExp(`###\\s*${catName}([\\s\\S]*?)(?=###|$)`, 'i');
      const match = text.match(regex);
      
      if (match) {
        const lines = match[1].split('\n');
        
        for (const line of lines) {
          // 匹配格式: "行X: [严重级别] 问题描述 → 建议"
          const issueMatch = line.match(/行\s*(\d+)[：:]\s*\[(.*?)\]\s*(.+?)(?:\s*(?:→|->)\s*(.+))?$/);
          if (issueMatch) {
            const [, lineNum, severityStr, message, suggestion] = issueMatch;
            
            const severity: ReviewSeverity =
              severityStr.includes('严重') || severityStr.includes('critical') ? 'critical' :
              severityStr.includes('错误') || severityStr.includes('error') ? 'error' :
              severityStr.includes('警告') || severityStr.includes('warning') ? 'warning' : 'info';
            
            comments.push({
              category: catType,
              severity,
              line: parseInt(lineNum),
              message: message.trim(),
              suggestion: suggestion?.trim(),
            });
          }
        }
      }
    }
  }
  
  return {
    score: Math.max(0, Math.min(100, score)),
    summary: summary || '代码质量一般，有改进空间',
    comments,
    strengths: strengths.length > 0 ? strengths : ['代码结构清晰'],
    improvements: improvements.length > 0 ? improvements : ['可以进一步优化'],
  };
}

/**
 * 审查代码
 */
export async function reviewCode(
  code: string,
  options: ReviewOptions,
  context: { cwd: string; providerConfig: any }
): Promise<CodeReviewResult> {
  let staticAnalysis: CodeReviewResult['staticAnalysis'];
  
  // 静态分析
  if (options.includeStaticAnalysis) {
    try {
      const sourceFile = ts.createSourceFile(
        'temp.ts',
        code,
        ts.ScriptTarget.Latest,
        true
      );
      
      const complexity = analyzeFileComplexity(sourceFile);
      const smells = analyzeFileSmells(sourceFile);
      
      staticAnalysis = { complexity, smells };
    } catch (err) {
      // 静态分析失败，继续进行 AI 审查
    }
  }
  
  // 构建提示词
  const prompt = buildReviewPrompt(code, options, staticAnalysis);
  
  // 调用 LLM
  const provider = createProviderForConfig(context.providerConfig, context.cwd);
  
  const response = await provider.complete({
    messages: [
      { role: 'user', content: prompt },
    ],
    model: context.providerConfig.model || 'gpt-4',
    temperature: 0.3,
    maxTokens: 2500,
  });
  
  if (!response.content) {
    throw new Error('AI 审查响应为空');
  }
  
  // 解析响应
  const parsed = parseReviewResponse(response.content, options.language);
  
  return {
    ...parsed,
    staticAnalysis,
  };
}

/**
 * 审查文件
 */
export async function reviewFile(
  filePath: string,
  options: ReviewOptions,
  context: { cwd: string; providerConfig: any }
): Promise<CodeReviewResult> {
  const absolutePath = resolve(context.cwd, filePath);
  const code = await readFile(absolutePath, 'utf-8');
  
  return reviewCode(code, options, context);
}

/**
 * 审查 Git diff
 */
export async function reviewDiff(
  diff: string,
  options: ReviewOptions,
  context: { cwd: string; providerConfig: any }
): Promise<{
  overallAssessment: string;
  fileReviews: Array<{
    file: string;
    comments: ReviewComment[];
  }>;
}> {
  const prompt = options.language === 'zh' 
    ? `审查以下 Git diff，关注新增和修改的代码：

\`\`\`diff
${diff}
\`\`\`

请评估：
1. 改动是否合理
2. 是否引入新问题（安全、性能、正确性）
3. 是否有更好的实现方式
4. 测试覆盖是否充分

格式：
## 总体评估
[一段话评价这次改动]

## 具体问题
[按文件列出问题，格式：文件名 行X: [级别] 问题 → 建议]`
    : `Review the following Git diff, focusing on new and modified code:

\`\`\`diff
${diff}
\`\`\``;
  
  const provider = createProviderForConfig(context.providerConfig, context.cwd);
  
  const response = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    model: context.providerConfig.model || 'gpt-4',
    temperature: 0.3,
    maxTokens: 2000,
  });
  
  const content = response.content || '';
  
  // 解析总体评估
  const assessmentMatch = content.match(/##\s*总体评估|##\s*Overall([\s\S]*?)(?=##|$)/i);
  const overallAssessment = assessmentMatch ? assessmentMatch[1].trim() : content.substring(0, 200);
  
  // 解析具体问题（按文件分组）
  const fileReviews: Array<{ file: string; comments: ReviewComment[] }> = [];
  
  // 简化版解析，实际可以更复杂
  const problemsMatch = content.match(/##\s*具体问题|##\s*Issues([\s\S]*?)$/i);
  if (problemsMatch) {
    const lines = problemsMatch[1].split('\n');
    
    for (const line of lines) {
      const match = line.match(/(.+?)\s+行\s*(\d+)[：:]\s*\[(.*?)\]\s*(.+)/);
      if (match) {
        const [, file, lineNum, severityStr, message] = match;
        
        let fileReview = fileReviews.find(fr => fr.file === file.trim());
        if (!fileReview) {
          fileReview = { file: file.trim(), comments: [] };
          fileReviews.push(fileReview);
        }
        
        const severity: ReviewSeverity =
          severityStr.includes('严重') || severityStr.includes('critical') ? 'critical' :
          severityStr.includes('错误') || severityStr.includes('error') ? 'error' :
          severityStr.includes('警告') || severityStr.includes('warning') ? 'warning' : 'info';
        
        fileReview.comments.push({
          category: 'best-practice',
          severity,
          line: parseInt(lineNum),
          message: message.trim(),
        });
      }
    }
  }
  
  return {
    overallAssessment,
    fileReviews,
  };
}

/**
 * 生成审查报告（Markdown）
 */
export function generateReviewReport(result: CodeReviewResult, language: 'zh' | 'en' = 'zh'): string {
  const lines: string[] = [];
  
  if (language === 'zh') {
    lines.push('# 代码审查报告\n');
    lines.push(`**评分:** ${result.score}/100`);
    lines.push(`**评价:** ${result.summary}\n`);
    
    if (result.strengths.length > 0) {
      lines.push('## ✅ 优点\n');
      for (const strength of result.strengths) {
        lines.push(`- ${strength}`);
      }
      lines.push('');
    }
    
    if (result.improvements.length > 0) {
      lines.push('## 🔧 需要改进\n');
      for (const improvement of result.improvements) {
        lines.push(`- ${improvement}`);
      }
      lines.push('');
    }
    
    if (result.comments.length > 0) {
      lines.push('## 📝 具体问题\n');
      
      // 按类别分组
      const byCategory = new Map<ReviewCategory, ReviewComment[]>();
      for (const comment of result.comments) {
        if (!byCategory.has(comment.category)) {
          byCategory.set(comment.category, []);
        }
        byCategory.get(comment.category)!.push(comment);
      }
      
      const catNames: Record<ReviewCategory, string> = {
        security: '安全性',
        performance: '性能',
        maintainability: '可维护性',
        correctness: '正确性',
        style: '代码风格',
        'best-practice': '最佳实践',
      };
      
      for (const [cat, comments] of byCategory) {
        lines.push(`### ${catNames[cat]}\n`);
        
        for (const comment of comments) {
          const icon = 
            comment.severity === 'critical' ? '🔴' :
            comment.severity === 'error' ? '🟠' :
            comment.severity === 'warning' ? '🟡' : 'ℹ️';
          
          lines.push(`${icon} **行 ${comment.line}** [${comment.severity}]`);
          lines.push(`  ${comment.message}`);
          
          if (comment.suggestion) {
            lines.push(`  💡 **建议:** ${comment.suggestion}`);
          }
          
          if (comment.example) {
            lines.push('  ```typescript');
            lines.push(`  ${comment.example}`);
            lines.push('  ```');
          }
          
          lines.push('');
        }
      }
    }
    
    // 静态分析摘要
    if (result.staticAnalysis) {
      lines.push('## 📊 静态分析\n');
      
      if (result.staticAnalysis.complexity) {
        const c = result.staticAnalysis.complexity;
        lines.push('**复杂度:**');
        lines.push(`- 平均圈复杂度: ${c.averageCyclomatic?.toFixed(2) || 'N/A'}`);
        lines.push(`- 平均认知复杂度: ${c.averageCognitive?.toFixed(2) || 'N/A'}`);
        lines.push(`- 高风险函数: ${c.highRiskCount || 0} 个\n`);
      }
      
      if (result.staticAnalysis.smells) {
        const s = result.staticAnalysis.smells;
        lines.push('**代码异味:**');
        lines.push(`- Critical: ${s.severityCounts?.critical || 0}`);
        lines.push(`- Major: ${s.severityCounts?.major || 0}`);
        lines.push(`- Minor: ${s.severityCounts?.minor || 0}\n`);
      }
    }
  } else {
    // 英文版本
    lines.push('# Code Review Report\n');
    lines.push(`**Score:** ${result.score}/100`);
    lines.push(`**Summary:** ${result.summary}\n`);
    // ... 类似中文版本
  }
  
  return lines.join('\n');
}

/**
 * 快速安全检查
 */
export async function quickSecurityCheck(
  code: string,
  context: { cwd: string; providerConfig: any }
): Promise<ReviewComment[]> {
  const result = await reviewCode(
    code,
    {
      categories: ['security'],
      includeStaticAnalysis: false,
      includeExamples: false,
      language: 'zh',
    },
    context
  );
  
  return result.comments.filter(c => c.category === 'security');
}
