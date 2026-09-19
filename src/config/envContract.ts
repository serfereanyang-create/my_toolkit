/**
 * envContract.ts — .env.example 与代码读取键的契约核对（纯文本，无执行）。
 *
 * 三方比对：
 *  - .env.example 声明的键（文档契约）
 *  - 源码中 process.env.X / env("X") 读取的键（代码事实）
 *  - .env 本地文件存在的键（可选；只看键名，绝不读取/报告值）
 * 输出：代码用了但 example 没声明、example 声明了但代码没用、.env 缺失的键。
 */

import { readFile } from 'node:fs/promises';
import { glob } from 'glob';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface EnvContractIssue {
  kind: 'undocumented' | 'unused' | 'missing-local' | 'bad-name';
  key: string;
  detail: string;
}

export interface EnvContractReport {
  ok: boolean;
  exampleFile: string | null;
  exampleKeys: string[];
  codeKeys: string[];
  localKeys: string[];
  issues: EnvContractIssue[];
}

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** 解析 dotenv 风格文本的键名列表（跳过注释/空行/插值值，只取键）。 */
export function parseEnvKeys(text: string): string[] {
  const keys: string[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (key) keys.push(key);
  }
  return keys;
}

/** 从 JS/TS 源码提取环境变量读取键：process.env.NAME / process.env["NAME"] / env('NAME')。 */
export function extractCodeEnvKeys(source: string): string[] {
  const found = new Set<string>();
  // 手工扫描避免回溯正则；三种形态逐一查找。
  let idx = 0;
  while (true) {
    const at = source.indexOf('process.env', idx);
    if (at < 0) break;
    idx = at + 11;
    let rest = source.slice(idx);
    if (rest.startsWith('[')) {
      const quote = rest[1];
      if (quote === '"' || quote === "'") {
        const close = rest.indexOf(quote, 2);
        if (close > 0) found.add(rest.slice(2, close));
      }
      continue;
    }
    if (rest.startsWith('.')) rest = rest.slice(1);
    else continue;
    // 点号形态：读标识符
    let end = 0;
    while (end < rest.length && /[A-Za-z0-9_]/.test(rest[end]!)) end += 1;
    if (end > 0) found.add(rest.slice(0, end));
  }
  // env("X") / env.get('X') 包装形态
  for (const fn of ['env(', 'getEnv(', 'requireEnv(']) {
    let cursor = 0;
    while (true) {
      const pos = source.indexOf(fn, cursor);
      if (pos < 0) break;
      cursor = pos + fn.length;
      const after = source.slice(cursor);
      const quote = after[0];
      if (quote !== '"' && quote !== "'" && quote !== '`') continue;
      const close = after.indexOf(quote, 1);
      if (close > 0) found.add(after.slice(1, close));
    }
  }
  return [...found].filter(Boolean);
}

export async function checkEnvContract(workspaceRoot: string, sourcePattern = 'src/**/*.{ts,tsx,js,mjs,cjs}'): Promise<EnvContractReport> {
  const examplePath = join(workspaceRoot, '.env.example');
  const localPath = join(workspaceRoot, '.env');

  let exampleKeys: string[] = [];
  let exampleFile: string | null = null;
  if (existsSync(examplePath)) {
    exampleFile = '.env.example';
    exampleKeys = parseEnvKeys(await readFile(examplePath, 'utf-8'));
  }

  let localKeys: string[] = [];
  if (existsSync(localPath)) {
    // 只看键名用于"缺失"提示；不读取也不报告任何值。
    localKeys = parseEnvKeys(await readFile(localPath, 'utf-8'));
  }

  const codeKeySet = new Set<string>();
  const files = await glob(sourcePattern, { cwd: workspaceRoot, nodir: true, absolute: true });
  for (const file of files.slice(0, 800)) {
    try {
      const text = await readFile(file, 'utf-8');
      if (!text.includes('process.env') && !text.includes('getEnv(') && !text.includes('requireEnv(')) continue;
      for (const key of extractCodeEnvKeys(text)) codeKeySet.add(key);
    } catch { /* ignore unreadable */ }
  }
  const codeKeys = [...codeKeySet].sort();

  const issues: EnvContractIssue[] = [];
  const exampleSet = new Set(exampleKeys);
  const localSet = new Set(localKeys);
  for (const key of codeKeys) {
    if (!ENV_NAME_RE.test(key)) {
      issues.push({ kind: 'bad-name', key, detail: '键名不符合 UPPER_SNAKE 约定' });
    }
    if (!exampleSet.has(key)) {
      issues.push({ kind: 'undocumented', key, detail: '代码读取了该变量但 .env.example 未声明' });
    }
    if (localKeys.length > 0 && !localSet.has(key)) {
      issues.push({ kind: 'missing-local', key, detail: '本地 .env 缺少该键（启动可能报错）' });
    }
  }
  for (const key of exampleKeys) {
    if (!codeKeys.includes(key)) {
      issues.push({ kind: 'unused', key, detail: '.env.example 声明了但源码从未读取（可能已废弃）' });
    }
  }

  return {
    ok: issues.filter((i) => i.kind === 'undocumented').length === 0,
    exampleFile,
    exampleKeys,
    codeKeys,
    localKeys,
    issues,
  };
}
