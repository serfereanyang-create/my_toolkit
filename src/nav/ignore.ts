import type { NavLanguage } from './types.js';

/**
 * Nav-specific view of the shared walker policy: there is exactly one list of
 * ignored directories (`src/workspace/ignored.ts`), re-exported here so the nav
 * code keeps its local entry point without a second copy drifting again.
 */
export { IGNORED_DIR_NAMES as NAV_IGNORED_DIRS, isIgnoredDirName } from '../workspace/ignored.js';

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
