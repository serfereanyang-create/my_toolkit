/**
 * lockfileDiff.ts — npm package-lock 依赖差异对比（纯文本解析）。
 *
 * 输入两份 package-lock.json 文本，输出新增/移除/版本变更/升级降级分类。
 * 支持 lockfileVersion 1/2/3（v1 用 dependencies 树，v2/v3 用 packages 映射）。
 * 只做结构化对比，不执行网络与安装。
 */

export interface LockChange {
  name: string;
  /** v1: 旧版本 → 新版本；新增时 from=null；移除时 to=null */
  from: string | null;
  to: string | null;
  kind: 'added' | 'removed' | 'changed';
  /** changed 时的方向判断（语义化版本粗比较） */
  direction?: 'upgrade' | 'downgrade' | 'unknown';
}

export interface LockfileDiffReport {
  ok: boolean;
  error?: string;
  added: LockChange[];
  removed: LockChange[];
  changed: LockChange[];
  /** 变更总数 */
  total: number;
  /** 上游版本对比（如 2.1.0 → 2.2.0 算 minor） */
  semverHints: Array<{ name: string; from: string; to: string; bump: 'major' | 'minor' | 'patch' }>;
}

/** 从 lock 文本提取 name→version 扁平映射。解析失败返回 error。 */
export function flattenLock(lockText: string): Map<string, string> | { error: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(lockText);
  } catch (err) {
    return { error: `JSON 解析失败: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!doc || typeof doc !== 'object') return { error: 'lock 文件不是对象' };
  const root = doc as Record<string, unknown>;
  const flat = new Map<string, string>();

  // v2/v3: "packages" 映射，键是 node_modules/ 路径
  const packages = root.packages;
  if (packages && typeof packages === 'object') {
    for (const [key, value] of Object.entries(packages as Record<string, unknown>)) {
      if (!key.startsWith('node_modules/')) continue;
      const pkg = value as { version?: unknown };
      if (typeof pkg.version !== 'string') continue;
      // 嵌套 node_modules/a/node_modules/b → 记录为 b（同名保留首个=根层）
      const tail = key.slice('node_modules/'.length);
      const segments = tail.split('node_modules/');
      const name = segments[segments.length - 1]!;
      if (!flat.has(name)) flat.set(name, pkg.version);
    }
    if (flat.size > 0) return flat;
  }

  // v1: 递归 dependencies 树
  const deps = root.dependencies;
  if (deps && typeof deps === 'object') {
    const walk = (map: Record<string, unknown>): void => {
      for (const [name, value] of Object.entries(map)) {
        const pkg = value as { version?: unknown; dependencies?: Record<string, unknown> };
        if (typeof pkg.version === 'string' && !flat.has(name)) flat.set(name, pkg.version);
        if (pkg.dependencies && typeof pkg.dependencies === 'object') walk(pkg.dependencies);
      }
    };
    walk(deps as Record<string, unknown>);
    if (flat.size > 0) return flat;
  }

  return { error: '未识别的 lockfile 结构（需 packages 或 dependencies）' };
}

/** 语义化版本粗比较：返回 >0 表示 a 更新。 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function semverBump(from: string, to: string): 'major' | 'minor' | 'patch' {
  const f = from.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const t = to.split('.').map((x) => Number.parseInt(x, 10) || 0);
  if ((t[0] ?? 0) !== (f[0] ?? 0)) return 'major';
  if ((t[1] ?? 0) !== (f[1] ?? 0)) return 'minor';
  return 'patch';
}

/** 对比两份 lock 文本。 */
export function diffLockfiles(beforeText: string, afterText: string): LockfileDiffReport {
  const before = flattenLock(beforeText);
  const after = flattenLock(afterText);
  const fail = (msg: string): LockfileDiffReport => ({
    ok: false, error: msg, added: [], removed: [], changed: [], total: 0, semverHints: [],
  });
  if ('error' in before) return fail(`before: ${before.error}`);
  if ('error' in after) return fail(`after: ${after.error}`);

  const added: LockChange[] = [];
  const removed: LockChange[] = [];
  const changed: LockChange[] = [];
  const semverHints: LockfileDiffReport['semverHints'] = [];

  for (const [name, version] of after) {
    const old = before.get(name);
    if (old === undefined) {
      added.push({ name, from: null, to: version, kind: 'added' });
    } else if (old !== version) {
      const cmp = compareSemver(version, old);
      const direction = cmp > 0 ? 'upgrade' : cmp < 0 ? 'downgrade' : 'unknown';
      changed.push({ name, from: old, to: version, kind: 'changed', direction });
      semverHints.push({ name, from: old, to: version, bump: semverBump(old, version) });
    }
  }
  for (const [name, version] of before) {
    if (!after.has(name)) removed.push({ name, from: version, to: null, kind: 'removed' });
  }

  const byName = (a: LockChange, b: LockChange) => a.name.localeCompare(b.name);
  added.sort(byName);
  removed.sort(byName);
  changed.sort(byName);
  semverHints.sort((a, b) => a.name.localeCompare(b.name));

  return {
    ok: true,
    added,
    removed,
    changed,
    total: added.length + removed.length + changed.length,
    semverHints,
  };
}
