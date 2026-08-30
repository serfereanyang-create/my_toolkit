import type { DesktopPreferences } from '../../types';

/*
 * Typed accessors over the open `preferences` record. Every settings page reads
 * its values through these (with a fallback) and writes back through `savePref`,
 * which merges a partial patch and persists via settings.set. This is what makes
 * the settings pages survive a remount / app restart instead of resetting.
 */

export type Prefs = DesktopPreferences;
export type SavePref = (patch: Prefs) => void;

export function prefStr(prefs: Prefs, key: string, fallback: string): string {
  const value = prefs?.[key];
  return typeof value === 'string' ? value : fallback;
}

export function prefBool(prefs: Prefs, key: string, fallback: boolean): boolean {
  const value = prefs?.[key];
  return typeof value === 'boolean' ? value : fallback;
}

export function prefNum(prefs: Prefs, key: string, fallback: number): number {
  const value = prefs?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function prefStrArray(prefs: Prefs, key: string, fallback: string[]): string[] {
  const value = prefs?.[key];
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : fallback;
}
