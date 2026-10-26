/**
 * discover.ts - Monorepo workspace discovery and package listing.
 *
 * 识别 npm / pnpm / yarn / bun workspace，列出每个 sub-package 的
 * name/version/路径/source 出口/依赖引用。仅只读，不修改。
 */

import { readFile } from 'node:fs/promises';
import { join, relative, dirname, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { glob } from 'glob';

export type WorkspaceTool = 'npm' | 'pnpm' | 'yarn' | 'yarn-classic' | 'bun' | 'nx' | 'turbo' | 'lerna' | 'unknown';

export interface WorkspacePackage {
  /** package.json 的 name 字段 */
  name: string;
  version: string;
  /** 相对 workspaceRoot 的路径（posix 风格） */
  dir: string;
  isPrivate: boolean;
  /** 声明的 exports / main / types 等入口 */
  entryPoints: {
    main?: string;
    module?: string;
    types?: string;
    exportsField?: boolean;
    bin?: Record<string, string>;
  };
  /** 声明的 dependencies 名字（含 dev/peer/optional） */
  dependencies: string[];
  devDependencies: string[];
  peerDependencies: string[];
  optionalDependencies: string[];
}

export interface WorkspaceDiscovery {
  tool: WorkspaceTool;
  /** 工作区根（绝对路径） */
  root: string;
  /** 包 patterns（如 'packages/*'） */
  patterns: string[];
  packages: WorkspacePackage[];
  /** 配置来源文件（pnpm-workspace.yaml / package.json 等） */
  configFile: string | null;
}

/** 从 package.json 提取 workspaces 字段（npm/yarn 都用） */
export function parseNpmWorkspacesField(pkg: Record<string, unknown>): string[] {
  const raw = pkg.workspaces;
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  if (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).packages)) {
    return ((raw as Record<string, unknown>).packages as unknown[]).filter(
      (x): x is string => typeof x === 'string',
    );
  }
  return [];
}

/** pnpm-workspace.yaml 极简解析（仅 packages: 列表） */
export function parsePnpmWorkspaceYaml(text: string): string[] {
  const out: string[] = [];
  let inPackages = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('packages:')) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      if (!line.startsWith('-')) {
        inPackages = false;
        continue;
      }
      const value = line.replace(/^-\s*/, '').replace(/^['"]|['"]$/g, '').trim();
      if (value) out.push(value);
    }
  }
  return out;
}

/** 从根 package.json 探测工具与 workspace patterns */
export async function detectWorkspaceTool(root: string): Promise<{
  tool: WorkspaceTool;
  patterns: string[];
  configFile: string | null;
}> {
  const pkgPath = join(root, 'package.json');
  const pnpmYaml = join(root, 'pnpm-workspace.yaml');
  const lernaJson = join(root, 'lerna.json');
  const nxJson = join(root, 'nx.json');
  const turboJson = join(root, 'turbo.json');

  if (existsSync(pnpmYaml)) {
    try {
      const text = await readFile(pnpmYaml, 'utf-8');
      return { tool: 'pnpm', patterns: parsePnpmWorkspaceYaml(text), configFile: 'pnpm-workspace.yaml' };
    } catch {
      return { tool: 'pnpm', patterns: [], configFile: 'pnpm-workspace.yaml' };
    }
  }

  if (existsSync(pkgPath)) {
    try {
      const raw = await readFile(pkgPath, 'utf-8');
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      const patterns = parseNpmWorkspacesField(pkg);
      if (patterns.length > 0) {
        const pkgManager = typeof pkg.packageManager === 'string' ? pkg.packageManager : '';
        let tool: WorkspaceTool = 'npm';
        if (pkgManager.startsWith('pnpm')) tool = 'pnpm';
        else if (pkgManager.startsWith('yarn')) tool = 'yarn';
        else if (pkgManager.startsWith('bun')) tool = 'bun';
        return { tool, patterns, configFile: 'package.json' };
      }
    } catch {
      // 非 package.json 环境
    }
  }

  if (existsSync(nxJson)) return { tool: 'nx', patterns: ['packages/*', 'apps/*', 'libs/*'], configFile: 'nx.json' };
  if (existsSync(turboJson)) return { tool: 'turbo', patterns: ['packages/*', 'apps/*'], configFile: 'turbo.json' };
  if (existsSync(lernaJson)) {
    try {
      const lerna = JSON.parse(await readFile(lernaJson, 'utf-8')) as { packages?: string[] };
      return { tool: 'lerna', patterns: lerna.packages ?? ['packages/*'], configFile: 'lerna.json' };
    } catch {
      return { tool: 'lerna', patterns: ['packages/*'], configFile: 'lerna.json' };
    }
  }
  return { tool: 'unknown', patterns: [], configFile: null };
}

/** 解析单个 package.json 为 WorkspacePackage */
export async function readPackageAt(pkgJsonPath: string, root: string): Promise<WorkspacePackage | null> {
  if (!existsSync(pkgJsonPath)) return null;
  try {
    const raw = await readFile(pkgJsonPath, 'utf-8');
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const dir = dirname(pkgJsonPath);
    const relDir = relative(root, dir).split(sep).join('/');

    const binValue = pkg.bin;
    const bin: Record<string, string> = {};
    if (typeof binValue === 'string') {
      bin[typeof pkg.name === 'string' ? (pkg.name as string) : ''] = binValue;
    } else if (binValue && typeof binValue === 'object') {
      for (const [k, v] of Object.entries(binValue as Record<string, unknown>)) {
        if (typeof v === 'string') bin[k] = v;
      }
    }

    return {
      name: typeof pkg.name === 'string' ? (pkg.name as string) : relDir,
      version: typeof pkg.version === 'string' ? (pkg.version as string) : '0.0.0',
      dir: relDir,
      isPrivate: pkg.private === true,
      entryPoints: {
        main: typeof pkg.main === 'string' ? pkg.main : undefined,
        module: typeof pkg.module === 'string' ? pkg.module : undefined,
        types: typeof pkg.types === 'string' ? pkg.types : undefined,
        exportsField: Boolean(pkg.exports),
        bin: Object.keys(bin).length > 0 ? bin : undefined,
      },
      dependencies: Object.keys((pkg.dependencies as Record<string, string> | undefined) ?? {}),
      devDependencies: Object.keys((pkg.devDependencies as Record<string, string> | undefined) ?? {}),
      peerDependencies: Object.keys((pkg.peerDependencies as Record<string, string> | undefined) ?? {}),
      optionalDependencies: Object.keys((pkg.optionalDependencies as Record<string, string> | undefined) ?? {}),
    };
  } catch {
    return null;
  }
}

/** 完整 workspace 发现：确定工具 + 列出全部 sub-package */
export async function discoverWorkspace(root: string, maxPatterns: number = 32): Promise<WorkspaceDiscovery> {
  const { tool, patterns, configFile } = await detectWorkspaceTool(root);
  if (patterns.length === 0) {
    // 非 monorepo：单包
    const single = await readPackageAt(join(root, 'package.json'), root);
    return {
      tool: 'unknown',
      root,
      patterns: [],
      packages: single ? [single] : [],
      configFile: 'package.json',
    };
  }

  const packages: WorkspacePackage[] = [];
  const capped = patterns.slice(0, maxPatterns);
  for (const pattern of capped) {
    const normalized = pattern.endsWith('/package.json') ? pattern : `${pattern}/package.json`;
    const matches = await glob(normalized, { cwd: root, nodir: false, absolute: true });
    for (const pkgJsonPath of matches.slice(0, 50)) {
      const pkg = await readPackageAt(pkgJsonPath, root);
      if (pkg) packages.push(pkg);
    }
  }
  return { tool, root, patterns, packages, configFile };
}
