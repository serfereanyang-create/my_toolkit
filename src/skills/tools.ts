/**
 * tools.ts — 技能管理工具：skill_list / skill_show。
 *
 * 技能的激活是自动的（prompt 触发词匹配）；这两个工具供模型/用户
 * 显式查看工作区里有哪些技能与完整指令内容。
 */

import type { ToolDefinition } from '../tools/types.js';
import { scanSkills, findSkillByName } from './loader.js';

export const skillListTool: ToolDefinition<Record<string, never>> = {
  name: 'skill_list',
  description: '列出工作区 .aicode/skills/ 下所有可用技能（名称、描述、触发词）',
  inputHint: '{}',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    return {};
  },

  async execute(_input, context) {
    const { skills, errors } = await scanSkills(context.workspaceRoot);
    if (skills.length === 0 && errors.length === 0) {
      return {
        ok: true,
        output: '当前工作区没有技能。可在 .aicode/skills/<name>/SKILL.md 创建（frontmatter: name/description/triggers，正文为操作指令）。',
      };
    }
    const lines: string[] = [`## 工作区技能（${skills.length} 个）`, ''];
    for (const skill of skills) {
      const triggerText = skill.triggers.length > 0 ? `（触发: ${skill.triggers.join(', ')}）` : '';
      lines.push(`- **${skill.name}** — ${skill.description || '（无描述）'}${triggerText}`);
    }
    if (errors.length > 0) {
      lines.push('', '### 加载失败的技能');
      for (const e of errors) lines.push(`- ${e.path}: ${e.reason}`);
    }
    return { ok: true, output: lines.join('\n'), data: { skills, errors } };
  },
};

export const skillShowTool: ToolDefinition<{ name: string }> = {
  name: 'skill_show',
  description: '查看指定技能的完整指令内容',
  inputHint: '{ "name": "release-checklist" }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.name !== 'string' || !record.name.trim()) throw new Error('missing name');
    return { name: record.name.trim() };
  },

  async execute(input, context) {
    const skill = await findSkillByName(context.workspaceRoot, input.name);
    if (!skill) {
      return { ok: false, output: `找不到技能 "${input.name}"（可用 skill_list 查看）` };
    }
    const lines = [
      `## 技能: ${skill.name}`,
      '',
      `- 描述: ${skill.description || '（无）'}`,
      `- 触发词: ${skill.triggers.length > 0 ? skill.triggers.join(', ') : '（无）'}`,
      `- 来源: ${skill.sourcePath}`,
      '',
      '### 指令内容',
      '',
      skill.instructions,
    ];
    return { ok: true, output: lines.join('\n'), data: skill };
  },
};

export const skillTools = [skillListTool, skillShowTool];
