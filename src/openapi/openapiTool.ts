/**
 * openapiTool.ts — openapi_ts 工具注册。
 *
 * 输入 OpenAPI 3.x 规范（JSON 内联或文件路径），生成 TypeScript 类型定义。
 * 默认只读返回；writeToFile 时输出到工作区（不覆盖已存在文件）。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import type { ToolDefinition } from '../tools/types.js';
import { generateTypes } from './openapiTypes.js';

export const openapiTsTool: ToolDefinition<{
  spec?: string;
  specPath?: string;
  writeToFile?: boolean;
  outputFile?: string;
}> = {
  name: 'openapi_ts',
  description: '从 OpenAPI 3.x 规范的 components.schemas 生成 TypeScript 类型（interface/type + JSDoc，依赖排序）',
  inputHint: '{ "specPath": "openapi.json", "writeToFile": true, "outputFile": "src/types/api.ts" } 或 { "spec": "<JSON 文本>" }',
  risk: 'write',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.spec !== 'string' && typeof record.specPath !== 'string') {
      throw new Error('需要 spec（内联 JSON 文本）或 specPath（规范文件路径）之一');
    }
    const outputFile = typeof record.outputFile === 'string' && record.outputFile.trim()
      ? record.outputFile.trim()
      : 'src/types/api-generated.ts';
    if (outputFile.includes('..') || /^([a-zA-Z]:)?[\\/]/.test(outputFile)) {
      throw new Error('outputFile 必须是工作区内的相对路径');
    }
    return {
      spec: typeof record.spec === 'string' ? record.spec : undefined,
      specPath: typeof record.specPath === 'string' ? record.specPath : undefined,
      writeToFile: record.writeToFile === true,
      outputFile,
    };
  },

  async execute(input, context) {
    let specText = input.spec;
    if (!specText && input.specPath) {
      const specAbs = resolve(context.workspaceRoot, input.specPath);
      if (!specAbs.startsWith(resolve(context.workspaceRoot) + sep) && specAbs !== resolve(context.workspaceRoot)) {
        return { ok: false, output: 'specPath 越出工作区，已拒绝。' };
      }
      if (!existsSync(specAbs)) {
        return { ok: false, output: `规范文件不存在: ${input.specPath}` };
      }
      specText = await readFile(specAbs, 'utf-8');
    }
    if (!specText) return { ok: false, output: 'spec 为空。' };

    let spec: unknown;
    try {
      spec = JSON.parse(specText);
    } catch (err) {
      return { ok: false, output: `spec 不是合法 JSON: ${err instanceof Error ? err.message : String(err)}` };
    }

    const generated = generateTypes(spec);
    if (!generated.ok && generated.typeCount === 0) {
      return { ok: false, output: generated.errors.join('\n') };
    }

    if (!input.writeToFile) {
      const lines = [
        `## 生成的 TypeScript 类型（${generated.typeCount} 个）`,
        '',
        '```typescript',
        generated.source,
        '```',
        '',
        '传 writeToFile: true 可写入 ' + input.outputFile,
      ];
      return { ok: true, output: lines.join('\n'), data: { typeCount: generated.typeCount, source: generated.source } };
    }

    const outAbs = resolve(context.workspaceRoot, input.outputFile!);
    if (!outAbs.startsWith(resolve(context.workspaceRoot) + sep)) {
      return { ok: false, output: '输出路径越出工作区。' };
    }
    if (existsSync(outAbs)) {
      return { ok: false, output: `输出文件已存在，为防覆盖已跳过: ${input.outputFile}（请换一个文件名或先删除）` };
    }
    await mkdir(dirname(outAbs), { recursive: true });
    await writeFile(outAbs, generated.source, 'utf-8');
    return {
      ok: true,
      output: `已生成 ${generated.typeCount} 个类型 → ${input.outputFile}`,
      data: { typeCount: generated.typeCount, path: input.outputFile },
    };
  },
};

export const openapiTools = [openapiTsTool];
