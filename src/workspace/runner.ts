/**
 * runner.ts - Dependency-aware topological executor over workspace packages.
 *
 * Given a filtered set of packages, run the same script in each package using
 * the detected package manager, honoring dependency order (deps before
 * dependents). Supports parallel batches, fail-fast or continue-on-error.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { WorkspacePackage } from './discover.js';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface RunPlanStep {
  package: WorkspacePackage;
  scriptAvailable: boolean;
  order: number;
}

export interface RunPlan {
  /** Topological order respecting in-workspace deps */
  queue: RunPlanStep[];
  /** Packages Kahn-skipped because there is a cycle */
  cycleSkipped: WorkspacePackage[];
  /** The command prefix that will be used */
  command: string[];
}

export interface RunArtifact {
  pkg: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  skipped?: boolean;
  skipReason?: string;
}

export interface RunSummary {
  ok: number;
  failed: number;
  skipped: number;
  totalDurationMs: number;
  artifacts: RunArtifact[];
}

/** Topological sort of packages on their in-workspace dependency edges (Kahn). */
export function topoOrder(packages: WorkspacePackage[]): { sorted: WorkspacePackage[]; cyclic: WorkspacePackage[] } {
  const byName = new Map(packages.map((p) => [p.name, p]));
  const inDegree = new Map<string, number>();
  const edges = new Map<string, Set<string>>(); // dep -> dependents

  for (const pkg of packages) {
    inDegree.set(pkg.name, 0);
    edges.set(pkg.name, new Set());
  }
  for (const pkg of packages) {
    const local = [...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies]
      .filter((d) => byName.has(d));
    // "dep -> pkg" edge — pkg depends on dep
    for (const dep of local) {
      edges.get(dep)!.add(pkg.name);
      inDegree.set(pkg.name, (inDegree.get(pkg.name) ?? 0) + 1);
    }
  }

  const queue = packages.filter((p) => (inDegree.get(p.name) ?? 0) === 0).map((p) => p.name);
  const sorted: WorkspacePackage[] = [];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    sorted.push(byName.get(cur)!);
    for (const next of edges.get(cur) ?? []) {
      const d = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  const cyclic = packages.filter((p) => !seen.has(p.name));
  return { sorted, cyclic };
}

/** Package manager invocation for `run <script>` in a directory */
function buildArgs(pm: PackageManager, script: string): [string, ...string[]] {
  if (pm === 'pnpm') return ['pnpm', 'run', script];
  if (pm === 'yarn') return ['yarn', script];
  if (pm === 'bun') return ['bun', 'run', script];
  return ['npm', 'run', script];
}

/** Prefer packageManager from root package.json if available. */
export async function detectPackageManager(root: string): Promise<PackageManager> {
  try {
    const pkgJsonPath = join(root, 'package.json');
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(await readFile(pkgJsonPath, 'utf-8')) as { packageManager?: string };
    const pm = pkg.packageManager ?? '';
    if (pm.startsWith('pnpm')) return 'pnpm';
    if (pm.startsWith('yarn')) return 'yarn';
    if (pm.startsWith('bun')) return 'bun';
  } catch { /* default */ }
  return 'npm';
}

/** Build a RunPlan in topological order within the filtered set. */
export function planRun(
  selected: WorkspacePackage[],
  script: string,
  scriptsByDir: Map<string, Set<string>>,
): RunPlan {
  const { sorted, cyclic } = topoOrder(selected);
  const queue: RunPlanStep[] = sorted.map((pkg, idx) => ({
    package: pkg,
    scriptAvailable: scriptsByDir.get(pkg.dir)?.has(script) ?? false,
    order: idx,
  }));
  return {
    queue,
    cycleSkipped: cyclic,
    command: ['run', script],
  };
}

/** Execute one package's script. Returns full artifact. */
export async function runSingle(
  pm: PackageManager,
  pkg: WorkspacePackage,
  script: string,
  workspaceRoot: string,
  opts: { timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<RunArtifact> {
  const cwd = join(workspaceRoot, pkg.dir);
  const startedAt = Date.now();
  const args = buildArgs(pm, script);

  return new Promise((resolvePromise) => {
    const child = spawn(args[0]!, args.slice(1), {
      cwd,
      shell: process.platform === 'win32',
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const bufLimit = 1024 * 256;
    child.stdout?.on('data', (d) => {
      stdout += String(d);
      if (stdout.length > bufLimit) stdout = stdout.slice(-bufLimit);
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
      if (stderr.length > bufLimit) stderr = stderr.slice(-bufLimit);
    });
    const timer = setTimeout(() => {
      child.kill();
    }, opts.timeoutMs ?? 120_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({
        pkg: pkg.name,
        exitCode: code ?? -1,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({
        pkg: pkg.name,
        exitCode: -2,
        stdout,
        stderr: `${stderr}\n${err.message}`,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

/** Drive a run across selected packages with concurrency cap. */
export async function runAcross(
  pm: PackageManager,
  plan: RunPlan,
  workspaceRoot: string,
  opts: {
    concurrency?: number;
    timeoutMs?: number;
    continueOnError?: boolean;
    env?: Record<string, string>;
  } = {},
): Promise<RunSummary> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const summary: RunSummary = { ok: 0, failed: 0, skipped: 0, totalDurationMs: 0, artifacts: [] };

  let cursor = 0;
  let halted = false;
  async function worker(): Promise<void> {
    while (true) {
      if (halted) return;
      const idx = cursor;
      cursor += 1;
      if (idx >= plan.queue.length) return;
      const step = plan.queue[idx]!;
      if (!step.scriptAvailable) {
        summary.skipped += 1;
        summary.artifacts.push({
          pkg: step.package.name,
          exitCode: 0,
          stdout: '',
          stderr: '',
          durationMs: 0,
          skipped: true,
          skipReason: `script not defined in package.json`,
        });
        continue;
      }
      const artifact = await runSingle(pm, step.package, plan.command[1]!, workspaceRoot, {
        timeoutMs: opts.timeoutMs,
        env: opts.env,
      });
      summary.artifacts.push(artifact);
      summary.totalDurationMs += artifact.durationMs;
      if (artifact.exitCode === 0) summary.ok += 1;
      else {
        summary.failed += 1;
        if (!opts.continueOnError) {
          halted = true;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return summary;
}
