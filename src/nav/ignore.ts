import type { NavLanguage } from './types.js';

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
  'target',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.mypy_cache',
  '.pytest_cache',
  '.idea',
  '.vs',
]);

export function isIgnoredDirName(name: string): boolean {
  return NAV_IGNORED_DIRS.has(name) || name.startsWith('.aicode');
}

export function isTsJsFile(path: string): boolean {
  return /\.([cm]?[jt]sx?)$/i.test(path);
}

export function detectNavLanguage(path: string): NavLanguage {
  if (/\.tsx?$/i.test(path) || /\.mts$/i.test(path) || /\.cts$/i.test(path)) return 'ts';
  if (/\.([cm]?jsx?)$/i.test(path)) return 'js';
  if (/\.py$/i.test(path)) return 'python';
  if (/\.go$/i.test(path)) return 'go';
  if (/\.rs$/i.test(path)) return 'rust';
  if (/\.java$/i.test(path)) return 'java';
  if (/\.kts?$/i.test(path)) return 'kotlin';
  return 'other';
}

export function isIndexableSourceFile(path: string): boolean {
  return detectNavLanguage(path) !== 'other';
}
