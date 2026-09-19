/**
 * tools.ts — 反思管理工具：reflection_list / reflection_forget。
 *
 * 反思由失败自动沉淀；这两个工具让用户/模型查看与清理。
 */

import type { ToolDefinition } from '../tools/types.js';
import { ReflectionStore } from './store.js';

export const reflectionListTool: ToolDefinition<{ limit?: number }> = {
  name: 'reflection_list',
  description: '列出工作区沉淀的失败教训（.aicode/reflections.json），按最近与命中排序',
  inputHint: '{ "limit": 20 }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    return { limit: typeof record.limit === 'number' && record.limit > 0 ? Math.floor(record.limit) : 20 };
  },

  async execute(input, context) {
    const store = new ReflectionStore(context.workspaceRoot);
    const entries = await store.list();
    if (entries.length === 0) {
      return { ok: true, output: '尚无失败教训记录。任务失败时会自动沉淀到这里。' };
    }
    const sorted = [...entries].sort((a, b) => b.hits - a.hits || b.at.localeCompare(a.at));
    const lines: string[] = [`## 失败教训（${entries.length} 条，展示 ${Math.min(input.limit!, entries.length)}）`, ''];
    for (const e of sorted.slice(0, input.limit!)) {
      lines.push(`- **[${e.kind}]** ${e.topic}`);
      lines.push(`  - 失败: ${e.failure.slice(0, 100)}`);
      lines.push(`  - 教训: ${e.lesson}`);
      lines.push(`  - 命中 ${e.hits} 次 · ${e.at.slice(0, 10)} · id=${e.id.slice(0, 8)}`);
    }
    return { ok: true, output: lines.join('\n'), data: { entries: sorted.slice(0, input.limit!) } };
  },
};

export const reflectionForgetTool: ToolDefinition<{ id: string }> = {
  name: 'reflection_forget',
  description: '删除一条失败教训（按 id 前缀匹配）',
  inputHint: '{ "id": "a1b2c3d4" }',
  risk: 'write',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.id !== 'string' || !record.id.trim()) throw new Error('missing id');
    return { id: record.id.trim() };
  },

  async execute(input, context) {
    const store = new ReflectionStore(context.workspaceRoot);
    const entries = await store.list();
    const match = entries.find((e) => e.id === input.id || e.id.startsWith(input.id));
    if (!match) {
      return { ok: false, output: `找不到 id 以 "${input.id}" 开头的教训（reflection_list 查看）` };
    }
    const removed = await store.forget(match.id);
    return {
      ok: removed,
      output: removed ? `已删除教训「${match.topic.slice(0, 60)}」` : '删除失败',
    };
  },
};

export const reflectionTools = [reflectionListTool, reflectionForgetTool];
