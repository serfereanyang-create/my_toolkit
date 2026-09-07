import type { AutomationTask } from './types.js';

/**
 * 交互式任务创建助手
 * 提供友好的问答式界面来创建自动化任务
 */
export class InteractiveTaskCreator {
  /**
   * 解析触发器类型
   */
  parseTriggerType(input: string): 'cron' | 'file_watch' | 'git_event' | 'manual' | null {
    const normalized = input.toLowerCase().trim();
    
    if (normalized.includes('cron') || normalized.includes('time') || normalized.includes('schedule')) {
      return 'cron';
    }
    if (normalized.includes('file') || normalized.includes('watch')) {
      return 'file_watch';
    }
    if (normalized.includes('git') || normalized.includes('commit') || normalized.includes('push')) {
      return 'git_event';
    }
    if (normalized.includes('manual')) {
      return 'manual';
    }
    
    return null;
  }

  /**
   * 构建触发器配置
   */
  buildTriggerConfig(type: 'cron' | 'file_watch' | 'git_event' | 'manual', params: Record<string, any>): AutomationTask['trigger'] {
    switch (type) {
      case 'cron':
        return {
          type: 'cron',
          expression: params.expression || '0 9 * * *',
        };
      
      case 'file_watch':
        return {
          type: 'file_watch',
          patterns: params.patterns || ['src/**/*.ts'],
          events: params.events || ['modify'],
          debounceMs: params.debounceMs || 1000,
        };
      
      case 'git_event':
        return {
          type: 'git_event',
          events: params.events || ['commit'],
          branches: params.branches,
        };
      
      case 'manual':
        return {
          type: 'manual',
        };
    }
  }

  /**
   * 生成创建指南
   */
  getCreationGuide(): string {
    return `
# 自动化任务创建指南

通过 AutomationManager API 创建任务：

\`\`\`typescript
import { AutomationManager } from './automation/manager.js';

const manager = new AutomationManager(workspaceRoot, runtime);

// 示例1: 定时任务 (Cron)
await manager.createTask({
  name: '每日测试',
  description: '每天早上9点运行测试',
  trigger: {
    type: 'cron',
    expression: '0 9 * * *',  // 每天9:00
  },
  goal: '运行所有单元测试和集成测试',
  confirmPlan: true,
  maxTasks: 10,
});

// 示例2: 文件监听
await manager.createTask({
  name: '代码变更自动测试',
  trigger: {
    type: 'file_watch',
    patterns: ['src/**/*.ts', 'tests/**/*.test.ts'],
    events: ['modify'],
    debounceMs: 2000,
  },
  goal: '运行受影响的测试用例',
  confirmPlan: true,
});

// 示例3: Git 事件
await manager.createTask({
  name: '提交后自动检查',
  trigger: {
    type: 'git_event',
    events: ['commit'],
    branches: ['main', 'develop'],
  },
  goal: '运行代码检查和测试',
  confirmPlan: true,
});

// 示例4: 手动触发
await manager.createTask({
  name: '部署准备',
  trigger: {
    type: 'manual',
  },
  goal: '构建项目并生成部署清单',
  confirmPlan: true,
});
\`\`\`

## Cron 表达式示例

- \`0 9 * * *\` - 每天9:00
- \`*/30 * * * *\` - 每30分钟
- \`0 0 * * 1\` - 每周一午夜
- \`0 */2 * * *\` - 每2小时

## 常用文件模式

- \`src/**/*.ts\` - 所有 TypeScript 源文件
- \`tests/**/*.test.ts\` - 所有测试文件
- \`*.config.js\` - 根目录配置文件
- \`docs/**/*.md\` - 所有文档

## Git 事件类型

- \`commit\` - 本地提交
- \`push\` - 推送到远程（需要定期检查）
- \`pull\` - 从远程拉取（需要定期检查）

启动任务后使用：
- \`/automate list\` - 查看所有任务
- \`/automate start <task-id>\` - 启动任务
- \`/automate status <task-id>\` - 查看详细状态
`;
  }

  /**
   * 快速创建模板
   */
  getQuickTemplates(): Array<{ name: string; description: string; config: any }> {
    return [
      {
        name: '每日测试',
        description: '每天早上9点自动运行测试',
        config: {
          name: '每日测试',
          trigger: { type: 'cron', expression: '0 9 * * *' },
          goal: '运行所有单元测试和集成测试，生成测试报告',
          confirmPlan: true,
        },
      },
      {
        name: '代码变更测试',
        description: 'TypeScript 文件修改时自动测试',
        config: {
          name: '代码变更自动测试',
          trigger: {
            type: 'file_watch',
            patterns: ['src/**/*.ts'],
            events: ['modify'],
            debounceMs: 2000,
          },
          goal: '运行受影响的测试用例',
          confirmPlan: true,
        },
      },
      {
        name: '提交后检查',
        description: 'Git 提交后自动运行检查',
        config: {
          name: '提交后自动检查',
          trigger: {
            type: 'git_event',
            events: ['commit'],
          },
          goal: '运行代码检查、类型检查和测试',
          confirmPlan: true,
        },
      },
      {
        name: '文档同步',
        description: 'API 代码变化时自动更新文档',
        config: {
          name: 'API 文档同步',
          trigger: {
            type: 'file_watch',
            patterns: ['src/api/**/*.ts'],
            events: ['modify', 'create'],
            debounceMs: 5000,
          },
          goal: '根据代码注释生成 API 文档并更新 docs/api.md',
          confirmPlan: true,
        },
      },
    ];
  }
}
