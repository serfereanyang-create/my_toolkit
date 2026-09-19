/**
 * reviewChecklist.ts — 从变更统计生成评审重点清单（纯启发式）。
 *
 * 输入结构化 diff（复用 diffModel），按变更面输出分级检查项：
 *  安全面 / 数据面 / 并发面 / 接口面 / 测试面 / 文档面。
 * 供 review_pr 之后的人工核对，或 PR 模板自动填充。
 */

import type { FileDiff } from './diffModel.js';
import { parseUnifiedDiff } from './diffModel.js';

export interface ChecklistItem {
  priority: 'P0' | 'P1' | 'P2';
  area: string;
  item: string;
  /** 触发的文件（证据） */
  files: string[];
}

export interface ChecklistResult {
  items: ChecklistItem[];
  riskScore: number; // 0-100
  stats: { files: number; added: number; removed: number };
}

function matchesPattern(file: FileDiff, needles: string[]): boolean {
  const path = file.path.toLowerCase();
  const body = file.hunks.flatMap((h) => h.changes).join('\n').toLowerCase();
  return needles.some((n) => path.includes(n) || body.includes(n));
}

function addedLines(file: FileDiff): string {
  return file.hunks.flatMap((h) => h.changes.filter((c) => c.startsWith('+'))).join('\n');
}

export function buildChecklistFromDiff(diffText: string): ChecklistResult {
  const parsed = parseUnifiedDiff(diffText);
  const items: ChecklistItem[] = [];
  const files = parsed.files;

  const security = files.filter((f) => matchesPattern(f, ['auth', 'token', 'session', 'password', 'secret', 'cors', 'permission']));
  if (security.length > 0) {
    items.push({ priority: 'P0', area: '安全', item: '核对鉴权边界：新路径是否要求认证/授权，错误响应是否泄露内部信息', files: security.map((f) => f.path) });
    const hasKeyish = security.some((f) => /(api[_-]?key|secret|password|token)\s*[:=]/i.test(addedLines(f)));
    if (hasKeyish) {
      items.push({ priority: 'P0', area: '安全', item: '检查新增常量/默认值：确认没有硬编码凭据（应为环境变量或密钥服务）', files: security.map((f) => f.path) });
    }
  }

  const data = files.filter((f) => matchesPattern(f, ['migration', 'schema', 'model', 'database', 'store', 'persist']));
  if (data.length > 0) {
    items.push({ priority: 'P0', area: '数据', item: '确认向后兼容：字段增删是否有迁移/默认值，回滚路径是否安全', files: data.map((f) => f.path) });
  }

  const concurrency = files.filter((f) => matchesPattern(f, ['queue', 'lock', 'worker', 'job', 'async', 'timer', 'interval']));
  if (concurrency.length > 0) {
    items.push({ priority: 'P1', area: '并发', item: '检查竞态与取消：共享状态是否有保护，任务中断是否可恢复', files: concurrency.map((f) => f.path) });
  }

  const api = files.filter((f) => matchesPattern(f, ['route', 'controller', 'endpoint', 'handler', 'ipc', 'api']));
  if (api.length > 0) {
    items.push({ priority: 'P1', area: '接口', item: '核对外部契约：请求/响应形状、错误码与文档是否同步，是否破坏既有调用方', files: api.map((f) => f.path) });
  }

  const deletedHeavy = files.filter((f) => f.removedLines > 80);
  if (deletedHeavy.length > 0) {
    items.push({ priority: 'P1', area: '删除', item: '确认被删代码没有存量引用（grep 调用方、检查动态导入/配置引用）', files: deletedHeavy.map((f) => f.path) });
  }

  const touchedSrc = files.filter((f) => !/\.(md|txt)$/.test(f.path));
  const withTests = touchedSrc.some((f) => /\.test\.|\.spec\.|^tests?\//.test(f.path));
  if (touchedSrc.length > 0 && !withTests) {
    items.push({ priority: 'P1', area: '测试', item: '本变更未包含测试：为核心路径补一个能复现原问题的用例', files: touchedSrc.slice(0, 8).map((f) => f.path) });
  }

  const huge = files.filter((f) => f.addedLines + f.removedLines > 400);
  if (huge.length > 0) {
    items.push({ priority: 'P2', area: '可读性', item: '单文件改动过大：建议拆分 PR 或至少添加结构性说明注释', files: huge.map((f) => f.path) });
  }

  const renamed = files.filter((f) => f.kind === 'renamed');
  if (renamed.length > 0) {
    items.push({ priority: 'P2', area: '重命名', item: '确认 git 识别为重命名（而非删+加），保留 blame 历史', files: renamed.map((f) => f.path) });
  }

  items.push({ priority: 'P2', area: '通用', item: '运行完整测试与类型检查；抽查一条真实端到端路径', files: [] });

  const riskScore = Math.min(100, items.reduce((n, i) => n + (i.priority === 'P0' ? 30 : i.priority === 'P1' ? 15 : 5), 0));
  return {
    items,
    riskScore,
    stats: { files: parsed.files.length, added: parsed.totalAdded, removed: parsed.totalRemoved },
  };
}

/** 渲染 markdown 清单（直接可贴进 PR）。 */
export function renderChecklist(result: ChecklistResult): string {
  const lines: string[] = [
    `## 评审清单（风险 ${result.riskScore}/100，${result.stats.files} 文件 +${result.stats.added}/-${result.stats.removed}）`,
    '',
  ];
  for (const item of result.items) {
    lines.push(`- [ ] **${item.priority} · ${item.area}** ${item.item}`);
    if (item.files.length > 0) {
      lines.push(`      证据: ${item.files.slice(0, 5).join(', ')}${item.files.length > 5 ? ' …' : ''}`);
    }
  }
  return lines.join('\n');
}
