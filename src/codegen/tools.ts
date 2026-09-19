/**
 * codegen/tools.ts — 代码生成工具注册（CLI 工具）
 *
 * 将模板引擎 + 代码生成器注册为 CLI 工具供 agent 调用。
 * 所有文件写入默认落在 <workspace>/.aicode/generated/ 下，覆盖需要显式传 overwrite。
 */

import { defineTool } from '../tools/define.js';
import type { ToolResult } from '../tools/types.js';
import { join, resolve, sep } from 'node:path';
import { CodeGenerator, generateReactComponent, generateExpressRoute, generateInterface } from './code-generator.js';
import type { TemplateContext } from './template-engine.js';

/** Resolve outputDir inside the workspace; fall back to .aicode/generated. */
function safeOutputDir(cwd: string, requested: unknown): string {
  const fallback = join(cwd, '.aicode', 'generated');
  if (typeof requested !== 'string' || requested.trim() === '') return fallback;

  const resolvedRequest = resolve(cwd, requested);
  const resolvedRoot = resolve(cwd);
  const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  if (resolvedRequest !== resolvedRoot && !resolvedRequest.startsWith(rootWithSep)) {
    return fallback;
  }
  return resolvedRequest;
}

/** List generator template names. */
export const codegenListTemplatesTool = defineTool({
  name: 'codegen_list_templates',
  description: '列出代码生成器可用的内置模板（React 组件、Express 路由、TS 接口/类、jest/vitest 测试、package.json、tsconfig 等）',
  risk: 'read',
  input: {},
  examples: [{ input: {}, output: '返回模板名列表' }],

  async execute(): Promise<ToolResult> {
    const generator = new CodeGenerator({ outputDir: '.' });
    const names = generator.getTemplateNames();
    return {
      ok: true,
      output: '可用模板:\n' + names.map((n) => '  - ' + n).join('\n'),
      data: { templates: names },
    };
  },
});

/** Generate one file from a builtin/custom template. */
export const codegenGenerateTool = defineTool({
  name: 'codegen_generate',
  description: '用内置模板生成代码文件。默认输出到 .aicode/generated/，传 overwrite=true 才会覆盖已存在文件。',
  risk: 'write',
  input: {
    template: { type: 'string', description: '模板名，如 react-component / typescript-interface / vitest-test' },
    fileName: { type: 'string', description: '输出文件名，如 Button.tsx' },
    context: { type: 'object', description: '模板变量，如 {"name": "Button", "hasProps": true, "props": [{"name":"title","type":"string"}]}', optional: true },
    outputDir: { type: 'string', description: '输出目录（相对工作区，默认 .aicode/generated）', optional: true },
    overwrite: { type: 'boolean', description: '是否覆盖已存在文件，默认 false', optional: true },
  },
  examples: [
    {
      input: { template: 'typescript-interface', fileName: 'User.ts', context: { name: 'User', fields: [{ name: 'id', type: 'string' }] } },
      output: '生成 User.ts 接口文件',
    },
  ],

  async execute(input, context): Promise<ToolResult> {
    try {
      const generator = new CodeGenerator({
        outputDir: safeOutputDir(context.cwd, input.outputDir),
        overwrite: input.overwrite === true,
        context: input.context as TemplateContext | undefined,
      });

      const file = await generator.generate(input.template, input.fileName, input.context as TemplateContext | undefined);

      if (file.skipped) {
        return { ok: true, output: '跳过（文件已存在）: ' + file.path + '。传 overwrite=true 可覆盖。', data: file };
      }
      return { ok: true, output: '已生成: ' + file.path + '（' + file.content.split('\n').length + ' 行）', data: file };
    } catch (error) {
      return { ok: false, output: '生成失败: ' + (error instanceof Error ? error.message : String(error)) };
    }
  },
});

/** Batch generation. */
export const codegenGenerateBatchTool = defineTool({
  name: 'codegen_generate_batch',
  description: '批量生成多个代码文件。每项 {template, fileName, context?}。',
  risk: 'write',
  input: {
    items: {
      type: 'array',
      description: '生成项列表，如 [{"template":"typescript-interface","fileName":"A.ts","context":{"name":"A"}}]',
    },
    outputDir: { type: 'string', description: '输出目录（相对工作区，默认 .aicode/generated）', optional: true },
    overwrite: { type: 'boolean', description: '是否覆盖已存在文件，默认 false', optional: true },
  },
  examples: [
    {
      input: {
        items: [
          { template: 'typescript-interface', fileName: 'A.ts', context: { name: 'A' } },
          { template: 'typescript-interface', fileName: 'B.ts', context: { name: 'B' } },
        ],
      },
      output: '批量生成两个接口文件',
    },
  ],

  async execute(input, context): Promise<ToolResult> {
    try {
      const generator = new CodeGenerator({
        outputDir: safeOutputDir(context.cwd, input.outputDir),
        overwrite: input.overwrite === true,
      });

      const files = await generator.generateBatch(input.items);
      const created = files.filter((f) => f.created).length;
      const skipped = files.filter((f) => f.skipped).length;

      const lines = [
        '批量生成完成: ' + created + ' 创建, ' + skipped + ' 跳过',
        ...files.map((f) => '  ' + (f.skipped ? '[跳过] ' : '[创建] ') + f.path),
      ];
      return { ok: true, output: lines.join('\n'), data: { files } };
    } catch (error) {
      return { ok: false, output: '批量生成失败: ' + (error instanceof Error ? error.message : String(error)) };
    }
  },
});

/** Convenience wrappers exposed as tools. */
export const codegenReactComponentTool = defineTool({
  name: 'codegen_react_component',
  description: '生成 React 组件文件（函数组件，可带 props/state/样式）',
  risk: 'write',
  input: {
    name: { type: 'string', description: '组件名，如 Button' },
    withProps: { type: 'boolean', description: '是否生成 Props 接口', optional: true },
    withState: { type: 'boolean', description: '是否生成 useState', optional: true },
    withStyles: { type: 'boolean', description: '是否生成 CSS 文件引用', optional: true },
    props: { type: 'array', description: 'props 列表 [{"name":"title","type":"string"}]', optional: true },
    outputDir: { type: 'string', description: '输出目录（默认 .aicode/generated）', optional: true },
  },
  examples: [{ input: { name: 'Button' }, output: '生成 Button.tsx' }],

  async execute(input, context): Promise<ToolResult> {
    try {
      const file = await generateReactComponent(input.name, safeOutputDir(context.cwd, input.outputDir), {
        withProps: input.withProps,
        withState: input.withState,
        withStyles: input.withStyles,
        props: input.props,
      });
      return { ok: true, output: '已生成组件: ' + file.path, data: file };
    } catch (error) {
      return { ok: false, output: '生成失败: ' + (error instanceof Error ? error.message : String(error)) };
    }
  },
});

export const codegenExpressRouteTool = defineTool({
  name: 'codegen_express_route',
  description: '生成 Express 路由文件（可带鉴权/校验）',
  risk: 'write',
  input: {
    path: { type: 'string', description: '路由路径，如 /api/users' },
    hasAuth: { type: 'boolean', description: '是否包含鉴权中间件', optional: true },
    hasValidation: { type: 'boolean', description: '是否包含请求校验', optional: true },
    validationFields: { type: 'array', description: '校验字段 [{"name":"email","required":true}]', optional: true },
    outputDir: { type: 'string', description: '输出目录（默认 .aicode/generated）', optional: true },
  },
  examples: [{ input: { path: '/api/users' }, output: '生成 api-users.route.ts' }],

  async execute(input, context): Promise<ToolResult> {
    try {
      const file = await generateExpressRoute(input.path, safeOutputDir(context.cwd, input.outputDir), {
        hasAuth: input.hasAuth,
        hasValidation: input.hasValidation,
        validationFields: input.validationFields,
      });
      return { ok: true, output: '已生成路由: ' + file.path, data: file };
    } catch (error) {
      return { ok: false, output: '生成失败: ' + (error instanceof Error ? error.message : String(error)) };
    }
  },
});

export const codegenInterfaceTool = defineTool({
  name: 'codegen_interface',
  description: '生成 TypeScript 接口文件',
  risk: 'write',
  input: {
    name: { type: 'string', description: '接口名，如 User' },
    fields: { type: 'array', description: '字段 [{"name":"id","type":"string","optional":false}]' },
    description: { type: 'string', description: '接口说明', optional: true },
    outputDir: { type: 'string', description: '输出目录（默认 .aicode/generated）', optional: true },
  },
  examples: [
    { input: { name: 'User', fields: [{ name: 'id', type: 'string' }] }, output: '生成 User.ts' },
  ],

  async execute(input, context): Promise<ToolResult> {
    try {
      const file = await generateInterface(input.name, input.fields, safeOutputDir(context.cwd, input.outputDir), {
        description: input.description,
      });
      return { ok: true, output: '已生成接口: ' + file.path, data: file };
    } catch (error) {
      return { ok: false, output: '生成失败: ' + (error instanceof Error ? error.message : String(error)) };
    }
  },
});

export const codegenTools = [
  codegenListTemplatesTool,
  codegenGenerateTool,
  codegenGenerateBatchTool,
  codegenReactComponentTool,
  codegenExpressRouteTool,
  codegenInterfaceTool,
];
