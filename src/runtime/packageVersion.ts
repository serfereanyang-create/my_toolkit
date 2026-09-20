import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * The CLI manifest sits at the package root, but this module directory
 * differs by layout: src/runtime/ in the source tree and
 * dist/src/runtime/ after tsc. A fixed ../../package.json therefore hit the
 * right file from source and dist/package.json from the build output - and
 * tsc never emits that file, it only writes src and tests. Reading the
 * version then threw ENOENT at startup.
 *
 * Walking up to the nearest directory holding BOTH package.json and
 * tsconfig.json is layout independent: dist/ can never match because it has
 * no tsconfig.json, so source, dist, and any nesting depth resolve to the
 * same package root.
 */
// Exported so tests can assert the resolved root, not just the version: a
// stale dist/package.json copy makes a layout-sensitive lookup return the
// right version for the wrong reason.
export function findPackageRoot(startUrl: string): string | undefined {
  let current = dirname(fileURLToPath(startUrl));

  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(resolve(current, 'package.json')) && existsSync(resolve(current, 'tsconfig.json'))) return current;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return undefined;
}

export async function readPackageVersion(startUrl: string): Promise<string> {
  const root = findPackageRoot(startUrl);
  // The version is cosmetic; a missing manifest must not break startup.
  if (!root) return '0.0.0';

  const parsed = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { version?: string };
  return parsed.version ?? '0.0.0';
}
