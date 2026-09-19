/**
 * presets.ts — 脚手架项目模板。
 *
 * 每个 preset 描述一组要生成的文件（相对路径 → 内容模板）。
 * 模板变量用 {{name}} 占位，由 generate.ts 注入项目名等元数据。
 * 内容均为静态字符串：无命令执行、无网络。
 */

export interface ScaffoldFile {
  /** 相对于目标目录的路径（posix 风格） */
  path: string;
  content: string;
}

export interface ScaffoldPreset {
  id: string;
  label: string;
  description: string;
  files: (vars: ScaffoldVars) => ScaffoldFile[];
}

export interface ScaffoldVars {
  projectName: string;
}

const pkgJson = (name: string, extra: Record<string, unknown>): string =>
  JSON.stringify({ name, version: '0.1.0', private: true, ...extra }, null, 2) + '\n';

const GITIGNORE = ['node_modules/', 'dist/', 'coverage/', '.env', '.aicode/', ''].join('\n');

const TS_CONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      outDir: 'dist',
      rootDir: 'src',
      esModuleInterop: true,
      skipLibCheck: true,
    },
    include: ['src/**/*.ts'],
  },
  null,
  2,
) + '\n';

function readme(name: string, description: string): string {
  return `# ${name}\n\n${description}\n\n## 开发\n\n\`\`\`bash\nnpm install\nnpm run build\n\`\`\`\n`;
}

export const SCAFFOLD_PRESETS: Record<string, ScaffoldPreset> = {
  'node-lib': {
    id: 'node-lib',
    label: 'Node TypeScript 库',
    description: '带 tsconfig、vitest 与双入口（ESM/CJS 友好）的最小 TypeScript 库骨架',
    files: ({ projectName }) => [
      { path: 'package.json', content: pkgJson(projectName, { main: 'dist/index.js', types: 'dist/index.d.ts', scripts: { build: 'tsc -p tsconfig.json', test: 'vitest run' } }) },
      { path: 'tsconfig.json', content: TS_CONFIG },
      { path: 'src/index.ts', content: `/** ${projectName} 入口 */\nexport function hello(who = 'world'): string {\n  return \`hello \${who}\`;\n}\n` },
      { path: 'tests/index.test.ts', content: `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { hello } from '../src/index.js';\n\ntest('hello greets', () => {\n  assert.equal(hello('yoy'), 'hello yoy');\n});\n` },
      { path: 'README.md', content: readme(projectName, '一个 TypeScript 库骨架。') },
      { path: '.gitignore', content: GITIGNORE },
    ],
  },

  'node-cli': {
    id: 'node-cli',
    label: 'Node 命令行工具',
    description: '支持参数解析与子命令分发的 TypeScript CLI 骨架',
    files: ({ projectName }) => [
      { path: 'package.json', content: pkgJson(projectName, { type: 'module', bin: { [projectName]: 'dist/main.js' }, scripts: { build: 'tsc -p tsconfig.json', start: 'node dist/main.js' } }) },
      { path: 'tsconfig.json', content: TS_CONFIG },
      { path: 'src/main.ts', content: `#!/usr/bin/env node\n/** ${projectName} CLI 入口 */\nimport { runCommand } from './commands.js';\n\nconst argv = process.argv.slice(2);\nconst exitCode = await runCommand(argv);\nprocess.exitCode = exitCode;\n` },
      { path: 'src/commands.ts', content: `/** 子命令分发。返回进程退出码。 */\nexport async function runCommand(argv: string[]): Promise<number> {\n  const [cmd = 'help', ...rest] = argv;\n  switch (cmd) {\n    case 'help':\n      console.log('用法: ${projectName} <command> [args]');\n      return 0;\n    case 'greet':\n      console.log(\`hello \${rest[0] ?? 'world'}\`);\n      return 0;\n    default:\n      console.error(\`未知命令: \${cmd}\`);\n      return 1;\n  }\n}\n` },
      { path: 'README.md', content: readme(projectName, '一个命令行工具骨架。运行 `npm run build` 后可用 `node dist/main.js help`。') },
      { path: '.gitignore', content: GITIGNORE },
    ],
  },

  'static-site': {
    id: 'static-site',
    label: '静态站点',
    description: '零依赖的 HTML/CSS/JS 静态页面骨架，可直接用预览栏打开',
    files: ({ projectName }) => [
      {
        path: 'index.html',
        content: `<!doctype html>\n<html lang="zh-CN">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${projectName}</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <main class="card">\n    <h1>${projectName}</h1>\n    <p>由 YOYcode 脚手架生成的静态页面。</p>\n    <button id="ping" type="button">点我</button>\n  </main>\n  <script src="main.js"></script>\n</body>\n</html>\n`,
      },
      {
        path: 'style.css',
        content: `body {\n  margin: 0;\n  min-height: 100vh;\n  display: grid;\n  place-items: center;\n  font-family: system-ui, sans-serif;\n  background: #f5f6f8;\n}\n.card {\n  padding: 2rem 2.5rem;\n  border-radius: 14px;\n  background: #fff;\n  box-shadow: 0 8px 30px rgba(0,0,0,.08);\n  text-align: center;\n}\nbutton { padding: .5rem 1.2rem; border: 0; border-radius: 8px; cursor: pointer; }\n`,
      },
      {
        path: 'main.js',
        content: `const button = document.getElementById('ping');\nlet clicks = 0;\nbutton.addEventListener('click', () => {\n  clicks += 1;\n  button.textContent = \`点了 \${clicks} 次\`;\n});\n`,
      },
      { path: 'README.md', content: readme(projectName, '静态站点骨架，直接打开 index.html 或用预览栏查看。') },
    ],
  },
};

export function listPresetSummaries(): Array<{ id: string; label: string; description: string; fileCount: number }> {
  return Object.values(SCAFFOLD_PRESETS).map((preset) => ({
    id: preset.id,
    label: preset.label,
    description: preset.description,
    fileCount: preset.files({ projectName: 'demo' }).length,
  }));
}
