import { randomUUID } from 'node:crypto';
import type { TaskBoard, TaskItem } from './types.js';

export function shouldUseTaskBoard(prompt: string): boolean {
  const normalized = normalizePlannerPrompt(prompt);
  if (!normalized) return false;

  const smallAsk = hasAny(normalized, [
    '读取', '打开', '查看', '搜索', '查找', '磁盘', '剩余空间', '多大', '你好', 'help',
    'read ', 'open ', 'show ', 'search ', 'find ', 'disk', 'free space', 'hello', 'hi',
  ]) && !hasAny(normalized, ['实现', '开发', '重构', '分步', '任务板', '并补', '并添加', 'implement', 'build', 'refactor', 'multi-step', 'task board']);
  if (smallAsk) return false;

  return hasAny(normalized, [
    '实现', '开发', '重构', '分步', '任务板', '完整', '并测试', '并补测试', '跨模块', '端到端',
    'implement', 'build', 'create a', 'add a feature', 'refactor', 'multi-step', 'end-to-end', 'task board', 'plan and',
  ]) || countSteps(normalized) >= 3;
}

export function planBoardFromGoal(goal: string, now = new Date()): TaskBoard {
  const createdAt = now.toISOString();
  const id = `board_${createdAt.replace(/[-:.TZ]/g, '').slice(0, 14)}_${randomUUID().slice(0, 8)}`;
  const titles = defaultTaskTitles(goal);
  const tasks: TaskItem[] = titles.map((title, index) => ({
    id: `task_${index + 1}`,
    title,
    detail: index === 0 ? `Goal: ${goal}` : undefined,
    status: 'pending',
    dependsOn: index === 0 ? [] : [`task_${index}`],
    acceptance: defaultAcceptance(title),
  }));

  return {
    id,
    title: summarizeTitle(goal),
    goal,
    status: 'draft',
    createdAt,
    updatedAt: createdAt,
    tasks,
  };
}

function defaultTaskTitles(goal: string): string[] {
  const normalized = goal.toLowerCase();
  if (hasAny(normalized, ['登录', 'login', 'auth'])) {
    return ['Inspect existing auth/login code', 'Implement login changes', 'Add or update tests', 'Verify login behavior'];
  }
  if (hasAny(normalized, ['任务板', 'task board', '看板'])) {
    return [
      'Design and persist task board model',
      'Implement plan confirm and auto-run loop',
      'Add /plan controls and resume support',
      'Cover with automated tests',
    ];
  }
  return [
    'Inspect relevant project context',
    'Implement the core change',
    'Add or update tests',
    'Verify the result and summarize',
  ];
}

function defaultAcceptance(title: string) {
  return `Done when: ${title.toLowerCase()} is complete and residual risks are noted.`;
}

function summarizeTitle(goal: string) {
  const compact = goal.replace(/\s+/g, ' ').trim();
  return compact.length <= 60 ? compact : `${compact.slice(0, 57)}...`;
}

function countSteps(value: string) {
  return value.split(/[，。；;\n]|然后|接着|并|and then|then/).map((part) => part.trim()).filter(Boolean).length;
}

function normalizePlannerPrompt(prompt: string) {
  const trimmed = prompt.trim();
  if (!trimmed) return '';
  const attachmentIndex = trimmed.search(/\n\s*\[attachments\]\s*(?:\n|$)/i);
  const withoutAttachments = attachmentIndex >= 0 ? trimmed.slice(0, attachmentIndex) : trimmed;
  return withoutAttachments.trim().toLowerCase();
}

function hasAny(value: string, needles: string[]) {
  return needles.some((needle) => value.includes(needle));
}
