export const NAV_IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.gradle',
  '.aicode',
  '.aicode-smoke',
  '.smoke',
  '.turbo',
  '.next',
  'out',
]);

export function isIgnoredDirName(name: string): boolean {
  return NAV_IGNORED_DIRS.has(name) || name.startsWith('.aicode');
}

export function isTsJsFile(path: string): boolean {
  return /\.([cm]?[jt]sx?)$/i.test(path);
}
