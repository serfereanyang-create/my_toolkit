/**
 * scaffoldTool.ts — scaffold_project 工具注册。
 *
 * 从内置模板生成项目骨架：列出模板（read）与生成（write，绝不覆盖已有文件）。
 */

import type { ToolDefinition } from '../tools/types.js';
import { listPresetSummaries } from './presets.js';
import { generateProject, sanitizeProjectName, readGeneratedReadme } from './generate.js';

export const scaffoldListTool: ToolDefinition<Record<string, never>> = {
  name: 'scaffold_list',
  description: '列出可用的项目脚手架模板（node-lib / node-cli / static-site）',
  inputHint: '{}',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    return {};
  },

  async execute() {
    const presets = listPresetSummaries();
    const lines = ['## 可用脚手架模板', ''];
    for (const p of presets) {
      lines.push(`- **${p.id}**（${p.label}）— ${p.description}（${p.fileCount} 个文件）`);
    }
    return { ok: true, output: lines.join('\n'), data: { presets } };
  },
};

export const scaffoldProjectTool: ToolDefinition<{
  preset: string;
  projectName: string;
  targetDir?: string;
}> = {
  name: 'scaffold_project',
  description: '从模板生成项目骨架到工作区目录；已有文件一律跳过，绝不覆盖',
  inputHint: '{ "preset": "node-lib", "projectName": "my-lib", "targetDir": "my-lib" }',
  risk: 'write',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.preset !== 'string' || !record.preset.trim()) throw new Error('missing preset');
    if (typeof record.projectName !== 'string' || !record.projectName.trim()) throw new Error('missing projectName');
    const targetDir = typeof record.targetDir === 'string' ? record.targetDir : undefined;
    if (targetDir !== undefined && (targetDir.includes('..') || /^([a-zA-Z]:)?[\\/]/.test(targetDir))) {
      throw new Error('targetDir 必须是工作区内的相对路径');
    }
    return {
      preset: record.preset.trim(),
      projectName: record.projectName,
      targetDir: targetDir ?? sanitizeProjectName(record.projectName),
    };
  },

  async execute(input, context) {
    const result = await generateProject({
      workspaceRoot: context.workspaceRoot,
      targetDir: input.targetDir!,
      presetId: input.preset,
      projectName: input.projectName,
    });

    const lines: string[] = [
      `## 脚手架生成 — ${result.presetId}`,
      '',
      `- 目标: ${result.target}`,
      `- 新建 ${result.created.length} 个文件`,
      `- 跳过 ${result.skipped.length} 个已存在文件（不覆盖）`,
    ];
    if (result.created.length > 0) {
      lines.push('', '### 已创建');
      for (const f of result.created) lines.push(`- ${f}`);
    }
    if (result.skipped.length > 0) {
      lines.push('', '### 已跳过（存在）');
      for (const f of result.skipped) lines.push(`- ${f}`);
    }
    if (result.errors.length > 0) {
      lines.push('', '### 错误');
      for (const e of result.errors) lines.push(`- ${e}`);
    }
    if (result.created.includes('README.md')) {
      const preview = await readGeneratedReadme(context.workspaceRoot, input.targetDir!);
      if (preview) lines.push('', '### README 预览', '```', preview, '```');
    }
    return { ok: result.ok, output: lines.join('\n'), data: result };
  },
};

export const scaffoldTools = [scaffoldListTool, scaffoldProjectTool];
