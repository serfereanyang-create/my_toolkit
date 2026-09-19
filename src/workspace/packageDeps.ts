/**
 * packageDeps.ts - Cross-package import consistency check.
 *
 * 对 workspace 中的每个包，扫描其 .ts 源码里的 import 语句：
 *  - 如果 import 的是同 workspace 里的另一个包，但当前包未声明这个依赖 → 报"missing dependency"
 *  - 如果当前包声明了 workspace 里的依赖但源码里从未 import 它 → 报"unused declaration"
 *  - 第三方包必须出现在 dependencies 中（不应只在 devDependencies 里 import 运行时代码）
 *
 * 输出三类违规。仅分析源码 import specifier，不判定解析。
 */

import * as ts from 'typescript';
import { readFile } from 'node:fs/promises';
import { glob } from 'glob';
import { join } from 'node:path';
import type { WorkspacePackage } from './discover.js';

export type DepViolationKind =
  | 'missing-dependency'       // 用了同 workspace 包但没声明
  | 'undeclared-external'      // 用了第三方包但 dependencies 没声明
  | 'unused-declared-dep'      // 声明了 workspace 依赖但源码没 import
  | 'dep-only-in-dev';         // 仅在 devDependencies 出现，但生产源码 import

export interface DepViolation {
  kind: DepViolationKind;
  /** 出问题的包（被检查的） */
  packageName: string;
  /** 涉及的依赖名 */
  depName: string;
  /** 出问题的文件（如果适用） */
  file?: string;
  line?: number;
  message: string;
}

export interface PackageDepsReport {
  packagesScanned: number;
  filesScanned: number;
  violations: DepViolation[];
  byKind: Record<string, number>;
}

/** 收集单文件中的所有 import specifier（import/require/export-from） */
export function collectImportSpecifiers(source: string): string[] {
  const sf = ts.createSourceFile('m.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const specs: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]!)
    ) {
      specs.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return specs;
}

/** 从 specifier 提取包名（处理 scoped 与 path-suffix） */
export function specifierToPackageName(spec: string): string | null {
  if (!spec) return null;
  if (spec.startsWith('.')) return null; // 相对路径
  if (spec.startsWith('/')) return null; // 绝对
  const parts = spec.split('/');
  if (spec.startsWith('@')) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec;
  }
  return parts[0] ?? null;
}

/** 单包分析：扫所有 ts/js 文件，推断 imports */
async function scanPackageImports(
  pkg: WorkspacePackage,
  workspaceRoot: string,
): Promise<Array<{ file: string; line: number; spec: string }>> {
  const pkgDirAbs = join(workspaceRoot, pkg.dir);
  const hits: Array<{ file: string; line: number; spec: string }> = [];
  const pattern = '**/*.{ts,tsx,js,mjs,cjs}';
  const files = await glob(pattern, { cwd: pkgDirAbs, nodir: true, absolute: true });
  for (const f of files.slice(0, 200)) {
    let source: string;
    try {
      source = await readFile(f, 'utf-8');
    } catch {
      continue;
    }
    const specs = collectImportSpecifiers(source);
    for (const spec of specs) {
      hits.push({ file: f, line: 0, spec });
    }
  }
  return hits;
}

export async function analyzeWorkspaceDeps(
  packages: WorkspacePackage[],
  workspaceRoot: string,
): Promise<PackageDepsReport> {
  const byName = new Map(packages.map((p) => [p.name, p]));
  const violations: DepViolation[] = [];
  let filesScanned = 0;

  for (const pkg of packages) {
    const imports = await scanPackageImports(pkg, workspaceRoot);
    filesScanned += imports.length;

    const usedWorkspaceDeps = new Set<string>();
    const usedExternalDeps = new Set<string>();

    for (const hit of imports) {
      const depName = specifierToPackageName(hit.spec);
      if (!depName) continue;
      if (byName.has(depName)) {
        usedWorkspaceDeps.add(depName);
      } else {
        usedExternalDeps.add(depName);
      }
    }

    // 1) missing-dependency: 用了同 workspace 包但当前包未声明
    const declaredWorkspace = new Set([
      ...pkg.dependencies.filter((d) => byName.has(d)),
      ...pkg.devDependencies.filter((d) => byName.has(d)),
      ...pkg.peerDependencies.filter((d) => byName.has(d)),
      ...pkg.optionalDependencies.filter((d) => byName.has(d)),
    ]);
    for (const used of usedWorkspaceDeps) {
      if (!declaredWorkspace.has(used)) {
        violations.push({
          kind: 'missing-dependency',
          packageName: pkg.name,
          depName: used,
          message: `源码 import 了 "${used}" 但 package.json 未声明`,
        });
      }
    }

    // 2) unused declared workspace dep
    for (const declared of declaredWorkspace) {
      if (!usedWorkspaceDeps.has(declared)) {
        violations.push({
          kind: 'unused-declared-dep',
          packageName: pkg.name,
          depName: declared,
          message: `package.json 声明了 "${declared}" 但源码中未 import`,
        });
      }
    }

    // 3) undeclared external：使用了第三方包但完全没有 dependencies
    const declaredDepsSet = new Set(pkg.dependencies);
    const declaredDevSet = new Set(pkg.devDependencies);
    for (const ext of usedExternalDeps) {
      if (!declaredDepsSet.has(ext)) {
        // 看看在 devDependencies 里
        if (declaredDevSet.has(ext)) {
          violations.push({
            kind: 'dep-only-in-dev',
            packageName: pkg.name,
            depName: ext,
            message: `"${ext}" 只在 devDependencies 中声明，但生产源码 import`,
          });
        } else {
          violations.push({
            kind: 'undeclared-external',
            packageName: pkg.name,
            depName: ext,
            message: `import 了 "${ext}" 但未声明（也不在 devDependencies）`,
          });
        }
      }
    }
  }

  const byKind: Record<string, number> = {};
  for (const v of violations) byKind[v.kind] = (byKind[v.kind] ?? 0) + 1;

  return {
    packagesScanned: packages.length,
    filesScanned,
    violations,
    byKind,
  };
}
