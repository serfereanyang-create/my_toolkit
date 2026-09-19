/**
 * eslintConfig.ts - Generate ESLint flat config based on detected project signals.
 *
 * 读 package.json 判断 react/vue/node/test-framework，生成匹配的
 * eslint.config.js 模板。不运行 ESLint，不修改文件；返回建议文本。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type Ecosystem = 'node' | 'react' | 'vue' | 'angular' | 'node-ts' | 'react-ts' | 'vue-ts' | 'universal';

export interface EslintSuggestion {
  ecosystem: Ecosystem;
  /** eslint.config.js 推荐配置文本 */
  configSource: string;
  requires: string[];
  notes: string[];
}

export interface ProjectSignals {
  isTs: boolean;
  hasReact: boolean;
  hasVue: boolean;
  hasAngular: boolean;
  hasJest: boolean;
  hasVitest: boolean;
  hasMocha: boolean;
  hasPlaywright: boolean;
  hasPrettier: boolean;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun';
}

export async function detectProjectSignals(root: string): Promise<ProjectSignals> {
  let packageJson: Record<string, unknown> = {};
  try {
    packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf-8')) as Record<string, unknown>;
  } catch {
    // 保持空
  }

  const allDeps = {
    ...(packageJson.dependencies as Record<string, string> | undefined),
    ...(packageJson.devDependencies as Record<string, string> | undefined),
  };
  const isTs = !!allDeps.typescript;
  const hasReact = !!allDeps.react;
  const hasVue = !!allDeps.vue;
  const hasAngular = !!Object.keys(allDeps).some((k) => k.startsWith('@angular/'));
  const hasJest = !!allDeps.jest;
  const hasVitest = !!allDeps.vitest;
  const hasMocha = !!allDeps.mocha;
  const hasPlaywright = !!allDeps['@playwright/test'] || !!allDeps.playwright;
  const hasPrettier = !!allDeps.prettier;

  let packageManager: ProjectSignals['packageManager'] = 'npm';
  if (allDeps.pnpm || packageJson.packageManager?.toString?.().startsWith('pnpm')) packageManager = 'pnpm';
  else if (packageJson.packageManager?.toString?.().startsWith('yarn')) packageManager = 'yarn';
  else if (packageJson.packageManager?.toString?.().startsWith('bun')) packageManager = 'bun';

  return { isTs, hasReact, hasVue, hasAngular, hasJest, hasVitest, hasMocha, hasPlaywright, hasPrettier, packageManager };
}

export function determineEcosystem(s: ProjectSignals): Ecosystem {
  if (s.hasAngular) return 'angular';
  if (s.hasReact) return s.isTs ? 'react-ts' : 'react';
  if (s.hasVue) return s.isTs ? 'vue-ts' : 'vue';
  if (s.isTs) return 'node-ts';
  return 'node';
}

export function buildConfigSource(signals: ProjectSignals, eco: Ecosystem): EslintSuggestion {
  const requires: string[] = ['@eslint/js', 'typescript-eslint'];
  const notes: string[] = [];
  const plugins: string[] = [];
  const extendsRules: string[] = ['js.configs.recommended'];

  if (signals.isTs) extendsRules.push('...tseslint.configs.recommended');
  if (eco === 'react' || eco === 'react-ts') {
    plugins.push('react');
    requires.push('eslint-plugin-react', 'eslint-plugin-react-hooks');
    extendsRules.push('react.configs.recommended', '"plugin:react-hooks/recommended"');
  }
  if (eco === 'vue' || eco === 'vue-ts') {
    plugins.push('vue');
    requires.push('eslint-plugin-vue');
  }
  if (eco === 'angular') {
    plugins.push('angular');
    requires.push('@angular-eslint/eslint-plugin', '@angular-eslint/eslint-plugin-template');
  }
  if (signals.hasPrettier) {
    notes.push('检测到 Prettier，可考虑 eslint-config-prettier 关闭与 Prettier 冲突的格式化规则');
    requires.push('eslint-config-prettier');
  }
  if (signals.hasVitest) notes.push('Vitest 项目：添加 globals 或 eslint-plugin-vitest');
  if (signals.hasJest) notes.push('Jest 项目：添加 globals 或 eslint-plugin-jest');

  const source = `// eslint.config.js (generated)
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['dist/', 'node_modules/', 'coverage/'] },
  ${extendsRules.join(',\n  ')},
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
    },
  },
];
`;
  return { ecosystem: eco, configSource: source, requires, notes };
}

export async function suggestEslintConfig(root: string): Promise<EslintSuggestion> {
  const signals = await detectProjectSignals(root);
  const eco = determineEcosystem(signals);
  return buildConfigSource(signals, eco);
}
