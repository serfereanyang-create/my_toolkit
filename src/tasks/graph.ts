import type { TaskItem } from './types.js';

const statuses = new Set(['pending', 'in_progress', 'done', 'blocked', 'cancelled', 'skipped']);
export type TaskGraph = { tasks: TaskItem[]; issues: string[]; levels: Map<string, number> };

export function inspectTaskGraph(value: unknown): TaskGraph {
  const issues: string[] = [];
  const levels = new Map<string, number>();
  if (!Array.isArray(value)) return { tasks: [], issues: ['任务列表格式无效'], levels };
  if (!value.length) return { tasks: [], issues: ['任务计划没有任何任务'], levels };
  const tasks: TaskItem[] = [];
  const byId = new Map<string, TaskItem>();
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.id !== 'string' || !raw.id.trim() || typeof raw.title !== 'string' || !statuses.has(raw.status) || !Array.isArray(raw.dependsOn) || raw.dependsOn.some((dependency: unknown) => typeof dependency !== 'string' || !dependency.trim())) {
      issues.push(`第 ${index + 1} 个任务记录格式无效`);
      continue;
    }
    const task = raw as TaskItem;
    if (byId.has(task.id)) { issues.push(`任务编号重复：${task.id}`); continue; }
    byId.set(task.id, task);
    tasks.push(task);
  }
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    const dependencies = [...new Set(task.dependsOn)];
    indegree.set(task.id, dependencies.length);
    levels.set(task.id, 1);
    for (const dependency of dependencies) {
      if (!byId.has(dependency)) { issues.push(`依赖任务不存在：${task.id} → ${dependency}`); continue; }
      if (dependency === task.id) issues.push(`任务不能依赖自身：${task.id}`);
      const children = dependents.get(dependency) ?? [];
      children.push(task.id);
      dependents.set(dependency, children);
    }
  }
  if (issues.length) return { tasks, issues, levels };
  const ready = tasks.filter(task => indegree.get(task.id) === 0).map(task => task.id);
  for (let index = 0; index < ready.length; index += 1) {
    const id = ready[index];
    for (const child of dependents.get(id) ?? []) {
      levels.set(child, Math.max(levels.get(child)!, levels.get(id)! + 1));
      const remaining = indegree.get(child)! - 1;
      indegree.set(child, remaining);
      if (remaining === 0) ready.push(child);
    }
  }
  if (ready.length !== tasks.length) issues.push(`循环依赖导致任务无法排序：${tasks.filter(task => indegree.get(task.id)! > 0).map(task => task.id).join('、')}`);
  return { tasks, issues, levels };
}
