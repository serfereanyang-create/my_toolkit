/**
 * envContract.ts — .env.example 与代码读取键的契约核对（纯文本，无执行）。
 *
 * 三方比对：
 *  - .env.example 声明的键（文档契约）
 *  - 源码中 process.env.X / env("X") 读取的键（代码事实）
 *  - .env 本地文件存在的键（可选；只看键名，绝不读取/报告值）
 * 输出：代码用了但 example 没声明、example 声明了但代码没用、.env 缺失的键。
 *
 * 纯文本扫描器必须同时做两件事：
 *  1. 不漏 —— 除字面成员访问外，代码里真实存在的还有
 *     `process.env?.X`、`process.env[\`X\`]`、`env[X]`（X 为常量）、
 *     `readIntEnv(env, 'X', ...)` / `envPositiveInt('X', ...)` 这类把键名当参数的
 *     辅助函数，以及 `process.env[\`${provider}_MODEL\`]` 这种拼接（键族）。
 *     旧实现只认三种形态，本仓库 29/52 个键没被看见，报告因此是错的。
 *  2. 不误报 —— 它自己的源码里就写着 `indexOf('process.env')`、`text.includes('getEnv(')`。
 *     旧实现把 `text.includes(` 当成了 `getEnv(` 调用，把后续整段源码当成"键名"
 *     写进报告（探针：codeKeys 里出现包含换行的 200+ 字符字符串）。所以扫描前
 *     先抹掉注释与字符串，再在抹平后的文本上定位语法结构，用原文本取字面量。
 */

import { readFile } from 'node:fs/promises';
import { glob } from 'glob';
import { existsSync } from 'node:fs';
import { relative, join } from 'node:path';

export interface EnvContractIssue {
  kind: 'undocumented' | 'unused' | 'missing-local' | 'bad-name';
  key: string;
  detail: string;
  /** 读取该键的文件（相对工作区），便于定位。 */
  sources?: string[];
}

export interface EnvContractReport {
  ok: boolean;
  exampleFile: string | null;
  exampleKeys: string[];
  codeKeys: string[];
  localKeys: string[];
  /**
   * 无法静态枚举的读取：拼接键族（`process.env[\`${provider}_MODEL\`]`）、
   * 变量下标（`env[KEY]` 之外的 `env[name]`）、整对象读取（`const e = process.env`
   * 后随 `e[...]`）。只作提示，不算 undocumented——它们没有确定的键名。
   */
  dynamicReads: string[];
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

/**
 * 把注释和字符串替换成空白（保留长度与换行），供语法扫描跳过它们。
 * 模板字符串里的 `${...}` 表达式会一并被抹掉——本文件只关心"这里有个字符串"
 * 这一点结构信息，字面量内容之后从原文本按同一偏移取回。
 */
export function blankOutCommentsAndStrings(source: string): string {
  const out: string[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') { out.push(' '); index += 1; }
      continue;
    }
    if (char === '/' && next === '*') {
      out.push(' ', ' ');
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        out.push(source[index] === '\n' ? '\n' : ' ');
        index += 1;
      }
      if (index < source.length) { out.push(' ', ' '); index += 2; }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      out.push(' ');
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\' && index + 1 < source.length) {
          out.push(' ', ' ');
          index += 2;
          continue;
        }
        out.push(source[index] === '\n' ? '\n' : ' ');
        index += 1;
      }
      if (index < source.length) { out.push(' '); index += 1; }
      continue;
    }
    out.push(char);
    index += 1;
  }
  return out.join('');
}

export type CodeEnvReads = {
  /** 能静态确定的键。 */
  keys: string[];
  /** 无法静态枚举的读取（键族/变量下标/整对象读取），只作提示。 */
  dynamic: string[];
};

const HELPER_FUNCS = ['readIntEnv', 'readFloatEnv', 'envPositiveInt', 'positiveInt', 'envInt', 'envBool'];
/** `process.env` 上的方法访问（不是键）。 */
const ENV_METHODS = new Set(['replace', 'slice', 'toUpperCase', 'toString', 'valueOf', 'hasOwnProperty', 'includes', 'match', 'startsWith', 'endsWith', 'trim']);

/** 从 JS/TS 源码提取环境变量读取键（去重、排序）。 */
export function extractCodeEnvKeysDetailed(source: string): CodeEnvReads {
  const keys = new Set<string>();
  const dynamic = new Set<string>();
  const scanning = blankOutCommentsAndStrings(source);

  // ── process.env 成员 ─────────────────────────────────────────────────────
  scanMemberAccess(source, scanning, 'process.env', keys, dynamic, false);

  // ── 别名：const env = process.env / env: NodeJS.ProcessEnv = process.env ──
  // config.ts 的整层读取都写成 `env.AICODE_PROVIDER`；只认 `process.env.X`
  // 会让报告漏掉半个仓库（本仓库 31/51）。别名成员只认 UPPER_SNAKE，避免把
  // `env.get` / `env.replace` 这类方法当成键。
  for (const alias of collectEnvAliases(scanning)) {
    scanMemberAccess(source, scanning, alias, keys, dynamic, true);
  }

  // ── env[X] / env('X') / getEnv('X') / requireEnv('X') ────────────────────
  for (const match of scanning.matchAll(/(?<![\w$.])(getEnv|requireEnv|env)\s*(?:\.\s*get\s*)?[[(]/g)) {
    const start = (match.index ?? 0) + match[0].length;
    const close = match[0].endsWith('(') ? matchingParen(scanning, start - 1) : matchingBracket(scanning, start - 1);
    if (close < 0) continue;
    const raw = source.slice(start, close).trim();
    const literal = literalKey(raw);
    if (literal) keys.add(literal);
    else dynamic.add(`${match[1]}[]（非字面量下标）`);
  }

  // ── 辅助函数把键名当第一个字符串参数 ─────────────────────────────────────
  for (const fn of HELPER_FUNCS) {
    const pattern = new RegExp(`(?<![\\w$.])${fn}\\s*\\(`, 'g');
    for (const match of scanning.matchAll(pattern)) {
      const open = (match.index ?? 0) + match[0].length - 1;
      const close = matchingParen(scanning, open);
      if (close < 0) continue;
      const args = source.slice(open + 1, close);
      // 跳过可选的 env 参数，取第一个字符串字面量。
      const literal = args.match(/^\s*(?:[A-Za-z_$][\w$.]*\s*,\s*)?['"`]([A-Za-z_][\w]*)['"`]/);
      if (literal) keys.add(literal[1]!);
    }
  }

  return { keys: [...keys].sort(), dynamic: [...dynamic].sort() };
}

/** `const X = <...process.env...>` 与 `x: T = process.env` 绑定的读取器名字。 */
function collectEnvAliases(scanning: string): string[] {
  const aliases = new Set<string>();
  // Bounded character class: `[^;\n]*` let a long line pair a variable defined
  // earlier with an unrelated `process.env` read later.
  for (const match of scanning.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]{0,80}?\bprocess\.env\b/g)) {
    aliases.add(match[1]!);
  }
  for (const match of scanning.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$.<>[\]| ]*=\s*process\.env\b/g)) {
    aliases.add(match[1]!);
  }
  return [...aliases];
}

/**
 * Scan `token.NAME` / `token?.NAME` / `token["NAME"]` occurrences.
 * `upperOnly` restricts dot members to UPPER_SNAKE (alias readers), so method
 * calls on the alias object are not mistaken for keys.
 */
function scanMemberAccess(
  source: string,
  scanning: string,
  token: string,
  keys: Set<string>,
  dynamic: Set<string>,
  upperOnly: boolean,
): void {
  let idx = 0;
  while (true) {
    const at = scanning.indexOf(token, idx);
    if (at < 0) break;
    idx = at + token.length;
    // 前后都必须是词边界：`myprocess.env` / `process.environment` / `process.envX` 不算。
    if (/[A-Za-z0-9_$.]/.test(scanning[at - 1] ?? '')) continue;
    if (/[A-Za-z0-9_$]/.test(scanning[idx] ?? '')) continue;

    let cursor = idx;
    if (scanning[cursor] === '?') cursor += 1;
    if (scanning[cursor] === '.') cursor += 1;
    else if (scanning[cursor] === '[') {
      readBracketAccess(source, scanning, cursor, keys, dynamic);
      continue;
    } else {
      // 整对象读取：`const x = process.env`、`...(process.env)`、`Object.keys(process.env)`。
      if (!upperOnly) dynamic.add(`${token}（整对象读取）`);
      continue;
    }

    const rest = scanning.slice(cursor);
    const ident = rest.match(/^([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (!ident) continue;
    const name = ident[1]!;
    let after = cursor + name.length;
    while (after < scanning.length && /\s/.test(scanning[after]!)) after += 1;
    if (scanning[after] === '(' || ENV_METHODS.has(name)) continue; // 方法调用
    if (upperOnly && !/^[A-Z][A-Z0-9_]*$/.test(name)) continue; // alias 只认 UPPER_SNAKE
    keys.add(name);
  }
}

/** 旧接口：只返回静态键（保留给既有调用方与测试）。 */
export function extractCodeEnvKeys(source: string): string[] {
  return extractCodeEnvKeysDetailed(source).keys;
}

function readBracketAccess(
  source: string,
  scanning: string,
  open: number,
  keys: Set<string>,
  dynamic: Set<string>,
): void {
  const close = matchingBracket(scanning, open);
  if (close < 0) return;
  const raw = source.slice(open + 1, close).trim();
  const literal = literalKey(raw);
  if (literal) {
    keys.add(literal);
    return;
  }
  // 模板拼接：process.env[`${provider}_MODEL`] → 记录键族片段。
  if (raw.startsWith('`')) {
    const pieces = raw.slice(1, -1).split(/\$\{[^}]*\}/).map((part) => part.trim()).filter(Boolean);
    for (const piece of pieces) dynamic.add(`process.env[] 键族片段 "${piece}"`);
    if (pieces.length === 0) dynamic.add('process.env[]（纯变量下标）');
    return;
  }
  // 字符串拼接：process.env['X_' + kind] → 记录字面量片段。
  const quoted = [...raw.matchAll(/['"]([A-Za-z_][\w]*)['"]/g)].map((m) => m[1]!);
  if (quoted.length > 0) for (const piece of quoted) dynamic.add(`process.env[] 键族片段 "${piece}"`);
  else dynamic.add('process.env[]（非字面量下标）');
}

/** 读取方括号内的字面量键；模板/拼接/纯变量返回 null。 */
function literalKey(raw: string): string | null {
  const quoted = raw.match(/^(['"`])([A-Za-z_$][\w$]*)\1$/);
  if (quoted) {
    const body = quoted[2]!;
    return /[A-Za-z]/.test(body) ? body : null;
  }
  return null;
}

/** 从 `(` / `[` 的位置找到配对的 `)` / `]`（跳过被抹成空白的字符串内容）。 */
function matchingParen(scanning: string, open: number): number {
  if (scanning[open] !== '(') return -1;
  let depth = 0;
  for (let index = open; index < scanning.length; index += 1) {
    const char = scanning[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function matchingBracket(scanning: string, open: number): number {
  if (scanning[open] !== '[') return -1;
  let depth = 0;
  for (let index = open; index < scanning.length; index += 1) {
    const char = scanning[index];
    if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
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

  const codeKeySet = new Map<string, string[]>();
  const dynamicReads = new Set<string>();
  const files = await glob(sourcePattern, { cwd: workspaceRoot, nodir: true, absolute: true });
  // 不再有 800 文件的静默上限：超过上限的文件没扫，"三方一致 ✓" 对它们就是错的。
  // 每个文件只有一次字符串遍历，文件集合已经由 glob 界定。
  for (const file of files) {
    try {
      const text = await readFile(file, 'utf-8');
      if (!/(process\.env|\benv\s*[[(]|getEnv\(|requireEnv\()/.test(text)) continue;
      const reads = extractCodeEnvKeysDetailed(text);
      const rel = relative(workspaceRoot, file).split('\\').join('/');
      for (const key of reads.keys) {
        const list = codeKeySet.get(key) ?? [];
        if (!list.includes(rel)) list.push(rel);
        codeKeySet.set(key, list);
      }
      for (const entry of reads.dynamic) dynamicReads.add(`${rel}: ${entry}`);
    } catch { /* ignore unreadable */ }
  }
  const codeKeys = [...codeKeySet.keys()].sort();

  const issues: EnvContractIssue[] = [];
  const exampleSet = new Set(exampleKeys);
  const localSet = new Set(localKeys);
  for (const key of codeKeys) {
    if (!ENV_NAME_RE.test(key)) {
      issues.push({ kind: 'bad-name', key, detail: '键名不符合 UPPER_SNAKE 约定', sources: codeKeySet.get(key) });
    }
    if (!exampleSet.has(key)) {
      issues.push({ kind: 'undocumented', key, detail: '代码读取了该变量但 .env.example 未声明', sources: codeKeySet.get(key) });
    }
    if (localKeys.length > 0 && !localSet.has(key)) {
      issues.push({ kind: 'missing-local', key, detail: '本地 .env 缺少该键（启动可能报错）', sources: codeKeySet.get(key) });
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
    dynamicReads: [...dynamicReads].sort(),
    issues,
  };
}
