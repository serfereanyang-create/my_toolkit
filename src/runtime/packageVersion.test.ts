import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findPackageRoot, readPackageVersion } from './packageVersion.js';

const packageRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as { version: string };

/*
 * Regression guard for the layout-sensitive version lookup.
 *
 * The lookup used a fixed ../../package.json. That is correct from
 * src/runtime/ but resolves to dist/package.json from dist/src/runtime/, and
 * tsc never emits dist/package.json. A stale hand-copied file was hiding the
 * crash: without it createAgentRuntime threw ENOENT and every desktop bridge
 * test failed at startup.
 */
describe('readPackageVersion', () => {
  it('reads the CLI manifest from the source layout', async () => {
    await expect(readPackageVersion(import.meta.url)).resolves.toBe(manifest.version);
  });

  it('reads the same manifest from the dist layout', async () => {
    // Same depth the compiled file lands at: dist/src/runtime/.
    const distUrl = pathToFileURL(resolve(packageRoot, 'dist', 'src', 'runtime', 'createRuntime.js')).href;
    await expect(readPackageVersion(distUrl)).resolves.toBe(manifest.version);
  });

  it('resolves the dist layout to the CLI root, never to dist/ itself', () => {
    const distUrl = pathToFileURL(resolve(packageRoot, 'dist', 'src', 'runtime', 'createRuntime.js')).href;
    // dist/ has no tsconfig.json, so it can never satisfy the root probe.
    expect(findPackageRoot(distUrl)).toBe(packageRoot);
    expect(findPackageRoot(distUrl)).not.toBe(resolve(packageRoot, 'dist'));
  });

  it('never falls through to a parent package manifest', async () => {
    const distUrl = pathToFileURL(resolve(packageRoot, 'dist', 'src', 'runtime', 'createRuntime.js')).href;
    const parent = JSON.parse(readFileSync(resolve(packageRoot, '..', 'package.json'), 'utf8')) as { version: string };
    expect(parent.version).not.toBe(manifest.version);
    await expect(readPackageVersion(distUrl)).resolves.not.toBe(parent.version);
  });

  it('ignores a non-string version instead of passing it through', async () => {
    // package.json is hand-editable; `version: 7` used to reach the banner and
    // the JSON events as a number. findPackageRoot needs tsconfig.json too.
    const root = mkdtempSync(join(tmpdir(), 'aicode-pkg-version-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', version: 7 }));
      writeFileSync(join(root, 'tsconfig.json'), '{}');
      const url = pathToFileURL(join(root, 'src', 'runtime', 'x.js')).href;
      await expect(readPackageVersion(url)).resolves.toBe('0.0.0');
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', version: '9.9.9-beta' }));
      await expect(readPackageVersion(url)).resolves.toBe('9.9.9-beta');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('degrades to a placeholder instead of throwing when no manifest is found', async () => {
    const orphan = pathToFileURL(resolve(packageRoot, '..', '..', '__no-package-here__', 'x.js')).href;
    await expect(readPackageVersion(orphan)).resolves.toBe('0.0.0');
  });
});
