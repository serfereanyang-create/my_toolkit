/**
 * types.ts — 反思（Reflection）条目模型。
 *
 * 参考 Reflexion 论文：任务失败时把「目标 / 失败现象 / 教训」沉淀为结构化
 * 条目；后续相似任务开始时检索并注入，让智能体"记住上次为什么栽了"。
 */

export type ReflectionKind = 'tool_failure' | 'max_steps' | 'exception' | 'cancelled' | 'manual';

export interface ReflectionEntry {
  /** 稳定 id（randomUUID） */
  id: string;
  /** 触发任务的目标摘要（前 N 字符） */
  topic: string;
  /** 失败现象（错误消息 / 最后动作） */
  failure: string;
  /** 教训（启发式生成或人工补充） */
  lesson: string;
  kind: ReflectionKind;
  /** ISO 时间 */
  at: string;
  /** 命中次数：检索被注入时累加，用于排序 */
  hits: number;
}

/** 从失败现象提炼一句可操作教训（纯词法启发，无网络无模型）。 */
export function deriveLesson(failure: string, kind: ReflectionKind): string {
  const lower = failure.toLowerCase();
  const checks: Array<[string, string]> = [
    ['timeout', '同类操作请拆分步骤并预留超时控制，避免单步长时间挂起'],
    ['超时', '同类操作请拆分步骤并预留超时控制，避免单步长时间挂起'],
    ['denied', '该操作曾被审批拒绝：改走只读分析路径或提前向用户说明必要性'],
    ['拒绝', '该操作曾被审批拒绝：改走只读分析路径或提前向用户说明必要性'],
    ['unknown tool', '调用前先确认工具名与参数（可用工具列表以运行时注册表为准）'],
    ['not found', '引用前先用搜索确认目标存在，路径/名称不要凭记忆猜'],
    ['no such file', '操作文件前先确认工作区路径与文件真实存在'],
    ['max steps', '任务过大：先用子智能体或任务板拆分，再逐个击破'],
    ['permission', '权限失败：考虑降级为只读方案或请求用户授权'],
    ['econnrefused', '连接被拒：确认服务是否在运行、端口与地址是否正确'],
    ['enotfound', '域名解析失败：检查地址配置与网络环境'],
    ['json', '输出需为严格 JSON：用序列化而非手工拼接，避免尾逗号与单引号'],
  ];
  for (const [needle, lesson] of checks) {
    if (lower.includes(needle)) return lesson;
  }
  if (kind === 'max_steps') return '任务过大：先拆分为可独立验收的小步再执行';
  if (kind === 'cancelled') return '用户取消了该操作：执行破坏性动作前先展示计划并请求确认';
  return '重试前先复述失败现象，更换参数/工具/路径后小步验证，不要原样重试';
}

/** 反思块注入格式（与 memories/skills 块同一使用位置）。 */
export function formatReflections(reflections: ReflectionEntry[]): string {
  if (reflections.length === 0) return '';
  const lines = ['<past-reflections>'];
  lines.push('以下是此前相似任务的失败教训，执行前请规避：');
  for (const entry of reflections) {
    lines.push(`- [${entry.kind}] 任务「${entry.topic}」失败：${entry.failure.slice(0, 120)} → 教训：${entry.lesson}`);
  }
  lines.push('</past-reflections>');
  return lines.join('\n');
}
