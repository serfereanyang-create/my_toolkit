/**
 * licenseScan.ts - Dependency license compliance scan.
 *
 * Reads node_modules/<pkg>/package.json, normalizes the license field,
 * categorizes by permissiveness, and flags commercial-use risks.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export type LicenseCategory =
  | 'permissive'
  | 'copyleft'
  | 'weak-copyleft'
  | 'proprietary'
  | 'public-domain'
  | 'unknown';

export interface LicenseEntry {
  name: string;
  version: string;
  license: string;
  category: LicenseCategory;
  risk?: string;
}

const PERMISSIVE = new Set([
  'MIT', 'ISC', 'BSD', 'BSD-2-Clause', 'BSD-3-Clause',
  'Apache-2.0', '0BSD', 'CC0-1.0', 'Python-2.0', 'Zlib',
]);
const COPYLEFT_STRONG = new Set(['GPL-2.0', 'GPL-3.0', 'AGPL-3.0', 'SSPL-1.0']);
const COPYLEFT_WEAK = new Set([
  'LGPL-2.1', 'LGPL-3.0', 'MPL-2.0', 'EPL-1.0', 'EPL-2.0', 'EUPL-1.2', 'CDDL-1.0',
]);

export function normalizeLicense(raw: string | undefined | null): string {
  if (!raw) return 'UNKNOWN';
  const s = String(raw).trim();
  if (!s) return 'UNKNOWN';
  const withoutParens = s.replace(/^\(|\)$/g, '').trim();
  const firstBranch = withoutParens.split(/\s+OR\s+/i)[0] ?? '';
  return firstBranch.trim() || 'UNKNOWN';
}

export function categorize(license: string): { category: LicenseCategory; risk?: string } {
  const norm = normalizeLicense(license).toUpperCase();
  if (COPYLEFT_STRONG.has(norm)) {
    return { category: 'copyleft', risk: 'strong copyleft: derivative works must be open-sourced' };
  }
  if (COPYLEFT_WEAK.has(norm)) {
    return { category: 'weak-copyleft', risk: 'weak copyleft: review linking and modification obligations' };
  }
  if (norm === 'UNLICENSE' || norm === 'CC0-1.0') {
    return { category: 'public-domain' };
  }
  if (
    PERMISSIVE.has(norm) ||
    norm.startsWith('MIT') ||
    norm.startsWith('BSD') ||
    norm.startsWith('APACHE')
  ) {
    return { category: 'permissive' };
  }
  if (norm === 'UNKNOWN' || norm === 'UNLICENSED') {
    return { category: 'unknown', risk: 'no explicit license; commercial use cannot be assessed' };
  }
  return { category: 'unknown', risk: 'unrecognized license; needs manual review' };
}

export async function scanLicenses(root: string): Promise<LicenseEntry[]> {
  const modulesDir = join(root, 'node_modules');
  if (!existsSync(modulesDir)) return [];

  const entries: LicenseEntry[] = [];

  async function visitPackage(dir: string, fallbackName: string): Promise<void> {
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) return;
    try {
      const raw = await readFile(pkgPath, 'utf-8');
      const pkg = JSON.parse(raw) as {
        name?: string;
        version?: string;
        license?: string | { type?: string };
        licenses?: Array<{ type?: string }>;
      };
      const licenseField =
        typeof pkg.license === 'string'
          ? pkg.license
          : pkg.license?.type ?? pkg.licenses?.[0]?.type ?? '';
      const license = normalizeLicense(licenseField);
      const meta = categorize(license);
      entries.push({
        name: pkg.name ?? fallbackName,
        version: pkg.version ?? '0.0.0',
        license,
        category: meta.category,
        risk: meta.risk,
      });
    } catch {
      // corrupted package.json -> skip
    }
  }

  async function walkTop(dir: string): Promise<void> {
    const sub = await readdir(dir, { withFileTypes: true });
    for (const d of sub) {
      if (!d.isDirectory()) continue;
      if (d.name.startsWith('.')) continue;
      if (d.name.startsWith('@')) {
        const scoped = join(dir, d.name);
        const inner = await readdir(scoped, { withFileTypes: true });
        for (const s of inner) {
          if (s.isDirectory()) {
            await visitPackage(join(scoped, s.name), `${d.name}/${s.name}`);
          }
        }
      } else {
        await visitPackage(join(dir, d.name), d.name);
      }
    }
  }

  await walkTop(modulesDir);
  return entries;
}

export interface LicenseSummary {
  total: number;
  permissive: number;
  copyleft: number;
  weakCopyleft: number;
  publicDomain: number;
  unknown: number;
  risk: LicenseEntry[];
}

export function summarizeLicenses(entries: LicenseEntry[]): LicenseSummary {
  const risk = entries.filter((e) => e.risk);
  return {
    total: entries.length,
    permissive: entries.filter((e) => e.category === 'permissive').length,
    copyleft: entries.filter((e) => e.category === 'copyleft').length,
    weakCopyleft: entries.filter((e) => e.category === 'weak-copyleft').length,
    publicDomain: entries.filter((e) => e.category === 'public-domain').length,
    unknown: entries.filter((e) => e.category === 'unknown').length,
    risk,
  };
}
