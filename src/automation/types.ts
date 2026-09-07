/**
 * 自动化任务触发器类型
 */
export type TriggerType = 'cron' | 'file_watch' | 'git_event' | 'manual';

/**
 * Cron 定时触发器
 */
export type CronTrigger = {
  type: 'cron';
  /** Cron 表达式，例如 "0 9 * * *" 表示每天9点 */
  expression: string;
};

/**
 * 文件监听触发器
 */
export type FileWatchTrigger = {
  type: 'file_watch';
  /** Glob 模式数组，例如 src slash star star slash star.ts */
  patterns: string[];
  /** 监听的事件类型 */
  events: ('create' | 'modify' | 'delete')[];
  /** 防抖时间（毫秒），默认 1000ms */
  debounceMs?: number;
};

/**
 * Git 事件触发器
 */
export type GitEventTrigger = {
  type: 'git_event';
  /** Git 事件类型 */
  events: ('commit' | 'push' | 'pull')[];
  /** 限定分支（可选），例如 main 或 develop */
  branches?: string[];
};

/**
 * 手动触发器（仅通过 CLI 或 UI 手动触发）
 */
export type ManualTrigger = {
  type: 'manual';
};

/**
 * 所有触发器类型的联合
 */
export type Trigger = CronTrigger | FileWatchTrigger | GitEventTrigger | ManualTrigger;

/**
 * 任务执行动作配置
 */
export type TaskBoardAction = {
  type: 'task_board';
  /** 任务板目标，会传给 planBoardFromGoal() */
  goal: string;
  /** 是否自动确认任务板（true 则自动执行，false 则需要手动确认） */
  confirmPlan: boolean;
  /** 最大任务数限制 */
  maxTasks?: number;
};

/**
 * 自动化任务定义
 */
export type AutomationTask = {
  /** 任务唯一ID */
  id: string;
  /** 任务名称 */
  name: string;
  /** 任务描述（可选） */
  description?: string;
  /** 是否启用 */
  enabled: boolean;
  /** 触发器配置 */
  trigger: Trigger;
  /** 执行动作配置 */
  action: TaskBoardAction;
  /** 关联的 Cron 自动化 ID（由系统 CronCreate 返回） */
  cronAutomationId?: string;
  /** 最后执行时间 */
  lastRunAt?: string;
  /** 最后执行状态 */
  lastRunStatus?: 'success' | 'failed' | 'blocked';
  /** 最后执行错误信息 */
  lastRunError?: string;
  /** 连续失败次数 */
  consecutiveFailures?: number;
  /** 创建时间 */
  createdAt: string;
  /** 更新时间 */
  updatedAt: string;
};

/**
 * 任务执行结果
 */
export type ExecutionResult = {
  /** 执行状态 */
  status: 'success' | 'failed' | 'blocked';
  /** 关联的任务板 ID */
  boardId?: string;
  /** 错误信息（如果失败） */
  error?: string;
  /** 执行时间戳 */
  executedAt: string;
};

/**
 * 任务执行历史记录
 */
export type ExecutionHistory = {
  taskId: string;
  results: ExecutionResult[];
};
