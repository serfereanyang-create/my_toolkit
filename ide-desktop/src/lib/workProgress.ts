import type { ToolChatItem } from '../types';

export function formatWorkDuration(milliseconds: number): string {
  const total = Number.isFinite(milliseconds) ? Math.max(0, Math.floor(milliseconds / 1000)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

export function turnStatusLabel(steps: ReadonlyArray<Pick<ToolChatItem, 'status'>>, running: boolean, cancelled = false): string {
  if (cancelled) return '已停止';
  if (running) return steps.length ? '执行中' : '思考中';
  const failures = steps.filter((step) => step.status === 'failed').length;
  if (failures) return `${failures} 个步骤失败`;
  if (!steps.length) return '本轮已结束';
  return steps.every((step) => step.status === 'done') ? `已完成 ${steps.length} 个步骤` : `已结束 ${steps.length} 个步骤`;
}
