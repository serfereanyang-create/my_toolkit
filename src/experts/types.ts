import type { TaskBoard, TaskItem } from '../tasks/types.js';

/**
 * 专家意图分类 - 定义任务级别的工具域划分
 * 与 toolStrategy 的 ToolIntent 互补但更粗粒度，专注任务板场景的专家分派
 */
export type ExpertIntent =
  | 'code_edit'       // 代码编辑/重构/修复
  | 'code_search'     // 代码调研/查找/理解
  | 'git_ops'         // git 操作（add/commit/branch/stash/merge）
  | 'test_verify'     // 测试编写/执行/验证
  | 'doc_generation'  // 文档生成（docx/pptx/xlsx/pdf/md）
  | 'shell_runtime'   // 运行时操作（shell/进程/环境/磁盘）
  | 'data_processing' // 数据处理（json/csv/yaml/xml 转换/查询）
  | 'general';        // 通用/混合任务（兜底）

/**
 * 专家配置 - 定义一个专家的工具权限、系统提示和优先级规则
 */
export type ExpertProfile = {
  /** 专家 ID，用于日志和调试 */
  id: string;
  /** 人类可读名称 */
  name: string;
  /** 简短描述，说明这个专家擅长什么 */
  description: string;
  /** 对应的意图标签 */
  intent: ExpertIntent;
  /** 
   * 工具过滤器 - 返回 true 的工具会被包含在这个专家的工具集中。
   * 接收 ToolDefinition 的基本信息，可以基于 name/risk/description 过滤。
   */
  toolFilter: (tool: { name: string; risk: string; description: string }) => boolean;
  /**
   * 专属系统提示 - 会追加到 buildTaskPrompt() 的输出后面，
   * 作为这个专家的"角色设定"和"工作重点"提示。
   */
  systemPrompt: string;
  /**
   * 推荐的工具作用域覆盖（可选）- 如果设置，会覆盖 resolveToolScope() 的自动判断。
   * 例如 test_verify 专家可能强制 'full' scope 以访问所有测试/验证工具。
   */
  toolScopeOverride?: 'compact' | 'standard' | 'full';
};

/**
 * 路由上下文 - 传递给路由器的任务信息
 */
export type ExpertRoutingContext = {
  /** 当前任务 */
  task: TaskItem;
  /** 整个任务板（用于理解上下文，例如前序任务的结果） */
  board: TaskBoard;
  /** 工作区根路径 */
  workspaceRoot: string;
};

/**
 * 路由结果
 */
export type ExpertRoutingResult = {
  /** 选中的专家 */
  profile: ExpertProfile;
  /** 路由方式：'rule' 基于规则, 'model' 通过小模型判断, 'fallback' 规则不确定时的默认 */
  routedBy: 'rule' | 'model' | 'fallback';
  /** 置信度 (0-1)，规则路由时为 1.0 或 0.0；模型路由时为模型给出的概率 */
  confidence: number;
  /** 可选的调试信息 */
  reason?: string;
};
