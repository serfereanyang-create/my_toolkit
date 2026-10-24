import type { ExpertProfile, ExpertIntent, ExpertRoutingContext, ExpertRoutingResult } from './types.js';
import { allExperts, generalExpert } from './profiles.js';

export function selectExpertForGoal(goal: string): ExpertProfile {
  const intent = classifyTaskIntent(goal.toLowerCase());
  return allExperts.find((expert) => expert.intent === intent) ?? generalExpert;
}

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

  const specialistRules: Array<[ExpertIntent, string[]]> = [
    ['security_review', ['security review', 'security audit', 'vulnerability', 'vulnerabilities', '安全审查', '安全审计', '漏洞', '权限审查']],
    ['architecture', ['architecture', 'system design', '架构', '模块边界', '接口设计', '技术方案']],
    ['web_research', ['web search', 'official docs', 'online research', '网上检索', '联网搜索', '官方文档', '资料检索']],
    ['performance', ['performance', 'benchmark', 'profiling', '性能', '慢路径', '内存泄漏', '资源占用']],
    ['devops', ['deployment', 'ci/cd', 'docker', 'pipeline', '运维', '部署', '打包', '构建流水线']],
    ['debugging', ['debug', 'reproduce', 'root cause', '排查', '复现', '根因', '诊断']],
    ['refactor', ['refactor', '重构', '提取方法', '符号重命名']],
  ];
  for (const [specialistIntent, keywords] of specialistRules) {
    if (hasAny(text, keywords)) return specialistIntent;
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
    'inspect', 'read', 'find', 'search', 'locate', 'understand', 'review',
    '调研', '查找', '搜索', '查看', '了解', '理解', '检查', '读取', '审查', '审阅', 'investigate',
  ]);

  if (!hasReadOnlyKeywords && hasAny(text, ['frontend', 'react', 'css', '前端', '页面交互', '界面', '可访问性'])) return 'frontend';
  if (!hasReadOnlyKeywords && hasAny(text, ['backend', 'api endpoint', 'database', '后端', '接口实现', '数据库'])) return 'backend';
  
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
 *
 * 英文关键词按**词边界**匹配，而不是裸的子串包含。roster 里有 read / test /
 * word / excel 这类短词，子串匹配会在无关词内部命中它们：thread 和 spread 命中
 * read，latest 和 contest 命中 test，password 命中 word，excellent 命中 excel。
 * 后果不是措辞问题——`Fix the spread operator bug` 会被路由到**只读**的调研专家，
 * 而它的 toolFilter 会滤掉所有写工具，任务根本无法完成。
 *
 * 允许一个常见的词形后缀，这样复数/进行时仍然匹配（tests、testing、implemented）。
 * 中文按子串匹配——中文没有词边界。
 */
const ENGLISH_WORD_PATTERN_CACHE = new Map<string, RegExp>();

function englishWordPattern(needle: string): RegExp {
  let pattern = ENGLISH_WORD_PATTERN_CACHE.get(needle);
  if (!pattern) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pattern = new RegExp(`\\b${escaped}(?:s|es|ed|d|ing)?\\b`);
    ENGLISH_WORD_PATTERN_CACHE.set(needle, pattern);
  }
  return pattern;
}

function hasChineseCharacter(value: string): boolean {
  return /[一-鿿]/.test(value);
}

function hasAny(text: string, keywords: string[]): boolean {
  const value = text.toLowerCase();
  return keywords.some((keyword) => {
    const needle = keyword.toLowerCase();
    return hasChineseCharacter(needle)
      ? value.includes(needle)
      : englishWordPattern(needle).test(value);
  });
}
