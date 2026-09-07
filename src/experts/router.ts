import type { ExpertProfile, ExpertIntent, ExpertRoutingContext, ExpertRoutingResult } from './types.js';
import { allExperts, generalExpert } from './profiles.js';

/**
 * 核心路由函数 - 根据任务信息选择最合适的专家
 * 
 * 路由策略：
 * 1. 基于规则的关键词匹配（快速、确定性）
 * 2. 任务在板中的位置（第一个/最后一个任务）
 * 3. 前序任务的上下文（例如调研后通常是实现）
 * 4. 兜底：返回 generalExpert
 * 
 * 未来可扩展：如果规则不确定，调用小模型判断（预留接口）
 */
export function routeTaskToExpert(context: ExpertRoutingContext): ExpertRoutingResult {
  const { task, board } = context;
  const text = [task.title, task.detail, task.acceptance].filter(Boolean).join(' ').toLowerCase();
  
  // 规则 1: 明确的关键词 -> 直接路由
  const intent = classifyTaskIntent(text);
  if (intent !== 'unknown') {
    const profile = allExperts.find((e) => e.intent === intent);
    if (profile) {
      return {
        profile,
        routedBy: 'rule',
        confidence: 1.0,
        reason: `Keyword match: intent=${intent}`,
      };
    }
  }
  
  // 规则 2: 检查任务在板中的位置
  const taskIndex = board.tasks.findIndex((t) => t.id === task.id);
  const isFirstTask = taskIndex === 0;
  const isLastTask = taskIndex === board.tasks.length - 1;
  
  if (isFirstTask && hasAny(text, ['inspect', 'investigate', 'read', 'understand', '调研', '检查', '查看', '了解', '理解'])) {
    return {
      profile: allExperts.find((e) => e.intent === 'code_search')!,
      routedBy: 'rule',
      confidence: 0.9,
      reason: 'First task with inspection keywords',
    };
  }
  
  if (isLastTask && hasAny(text, ['verify', 'test', 'check', '验证', '测试', '检验', '确认'])) {
    return {
      profile: allExperts.find((e) => e.intent === 'test_verify')!,
      routedBy: 'rule',
      confidence: 0.9,
      reason: 'Last task with verification keywords',
    };
  }
  
  // 规则 3: 如果前序任务已经是代码调研，当前任务很可能是代码编辑
  if (taskIndex > 0) {
    const prevTask = board.tasks[taskIndex - 1];
    const prevIsSearch = prevTask.resultSummary && (
      prevTask.resultSummary.toLowerCase().includes('found') ||
      prevTask.resultSummary.toLowerCase().includes('located') ||
      prevTask.resultSummary.toLowerCase().includes('inspect')
    );
    if (prevIsSearch && hasAny(text, ['implement', 'fix', 'add', 'modify', 'change', 'update', '实现', '修复', '添加', '修改', '更新'])) {
      return {
        profile: allExperts.find((e) => e.intent === 'code_edit')!,
        routedBy: 'rule',
        confidence: 0.85,
        reason: 'Follow-up implementation after search task',
      };
    }
  }
  
  // 兜底：无法确定时返回通用专家
  return {
    profile: generalExpert,
    routedBy: 'fallback',
    confidence: 0.5,
    reason: 'No clear intent; using general expert',
  };
}

/**
 * 基于关键词的意图分类器（规则版本）
 * 
 * 优先级顺序（从高到低）：
 * git_ops > test_verify > doc_generation > shell_runtime > data_processing > code_edit > code_search
 */
function classifyTaskIntent(text: string): ExpertIntent | 'unknown' {
  // Git 操作关键词（最高优先级，因为最明确）
  if (hasAny(text, [
    'git add', 'git commit', 'git branch', 'git stash', 'git merge', 'git push', 'git pull',
    '提交代码', '创建分支', 'commit', 'stage changes', 'push to', 'create branch',
  ])) {
    return 'git_ops';
  }
  
  // 测试/验证关键词
  if (hasAny(text, [
    'test', 'verify', 'validation', 'typecheck', 'lint',
    '测试', '验证', '检验', 'run tests', 'write test', '补测试', '添加测试',
    'unit test', 'integration test', 'e2e test',
  ])) {
    return 'test_verify';
  }
  
  // 文档生成关键词
  if (hasAny(text, [
    'docx', 'pptx', 'xlsx', 'document', 'presentation', 'spreadsheet',
    '文档', 'word', 'ppt', 'excel', 'generate doc', '生成文档', 'create document',
  ])) {
    return 'doc_generation';
  }
  
  // Shell/运行时关键词
  if (hasAny(text, [
    'run command', 'execute', 'disk', 'process', 'environment',
    '运行', '执行', '磁盘', '进程', '环境', 'build', 'install', 'npm run', 'shell',
  ])) {
    return 'shell_runtime';
  }
  
  // 数据处理关键词
  if (hasAny(text, [
    'json', 'csv', 'yaml', 'xml', 'parse', 'transform',
    '转换', '解析', 'data file', '数据文件', 'convert data',
  ])) {
    return 'data_processing';
  }
  
  // 代码编辑关键词（需排除只读操作）
  const hasEditKeywords = hasAny(text, [
    'implement', 'fix', 'refactor', 'modify', 'change', 'add feature', 'update', 'edit',
    '实现', '修复', '重构', '修改', '添加', '更新', '编辑',
  ]);
  const hasReadOnlyKeywords = hasAny(text, [
    'inspect', 'read', 'find', 'search', 'locate', 'understand',
    '调研', '查找', '搜索', '查看', '了解', '理解', 'investigate',
  ]);
  
  if (hasEditKeywords && !hasReadOnlyKeywords) {
    return 'code_edit';
  }
  
  // 代码调研关键词（只读）
  if (hasReadOnlyKeywords) {
    return 'code_search';
  }
  
  return 'unknown';
}

/**
 * 辅助函数：检查文本是否包含任意关键词
 */
function hasAny(text: string, keywords: string[]): boolean {
  return keywords.some((kw) => text.includes(kw));
}
