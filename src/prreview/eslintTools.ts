import type { ToolDefinition } from '../tools/types.js';
import { suggestEslintConfig } from './eslintConfig.js';

export const generateEslintConfigTool: ToolDefinition<{ write?: boolean }> = {
  name: 'generate_eslint_config',
  description: '基于 package.json 信号推荐 ESLint flat config（eslint.config.js 文本与所需依赖）',
  inputHint: '{ "write": false }  预览（推荐）或写出到 workspace 根',
  risk: 'write',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    return { write: record.write === true };
  },

  async execute(input, context) {
    const suggestion = await suggestEslintConfig(context.workspaceRoot);

    const lines: string[] = [
      `## ESLint 推荐配置（${suggestion.ecosystem}）`,
      '',
      '### 需要的 devDependencies',
      ...suggestion.requires.map((d) => `- ${d}`),
      '',
      '### 说明',
      ...(suggestion.notes.length > 0 ? suggestion.notes.map((n) => `- ${n}`) : ['- 无额外提示']),
      '',
      '### eslint.config.js 预览',
      '```js',
      suggestion.configSource,
      '```',
    ];

    return {
      ok: true,
      output: lines.join('\n'),
      data: { suggestion, wouldWrite: input.write },
    };
  },
};

export const eslintTools = [generateEslintConfigTool];
