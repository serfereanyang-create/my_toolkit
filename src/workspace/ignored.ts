/**
 * ignored.ts — the one list of directories the file-walking layer never enters.
 *
 * Why this module exists: the list used to be copied into eighteen call sites
 * (`const ignoredDirs = new Set(['node_modules', 'dist', ...])`). Every copy went
 * stale at a different time, and the result was a real bug, not just noise — a
 * hook on this machine snapshots sources into `<dir>/.mimosa/hook-state/…` as
 * `.source` files. `.gitignore` knew about it; the index did not, so
 * `project_index` spent its 1000-file budget counting baseline copies and the
 * model could not see the real tree. One list, one place to extend.
 *
 * The rule is deliberately by NAME and not "skip everything that starts with a
 * dot": `.github`, `.claude` and `.vscode` hold files people legitimately want
 * read and searched. Caches are enumerated instead, plus the `.aicode*` family,
 * which is ours and always disposable.
 */

export const IGNORED_DIR_NAMES: ReadonlySet<string> = new Set([
  // build output
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  'vendor',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  '.cache',
  'bazel-bin',
  'bazel-out',
  // vcs / editors / tooling state
  '.git',
  '.gradle',
  '.idea',
  '.vs',
  '.mimosa',
  '.smoke',
  // python
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
]);

/**
 * Whether a directory of this name is skipped by every walker.
 *
 * Case-insensitive because Windows and macOS filesystems are: `Node_Modules`
 * and `node_modules` are the same directory there.
 */
export function isIgnoredDirName(name: string): boolean {
  const lower = name.toLowerCase();
  // `.aicode`, `.aicode-smoke`, and anything else we may add later under that
  // prefix: the CLI owns these and none of it is user source.
  if (lower.startsWith('.aicode')) return true;
  return IGNORED_DIR_NAMES.has(lower);
}
