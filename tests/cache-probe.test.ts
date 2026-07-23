import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { clearProjectContextCache, readProjectContext } from '../src/agent/context.js';
import { NavIndexStore, resetNavCacheStats } from '../src/nav/store.js';
import {
  collectCacheProbe,
  formatCacheProbe,
  formatHitRate,
  hitRate,
} from '../src/probe/cacheProbe.js';
import { handleSlashCommand } from '../src/cli/commands.js';
import { loadConfig } from '../src/config/config.js';
import { createMockProvider } from '../src/providers/mock.js';
import { SessionStore } from '../src/session/store.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';

test('hitRate and formatHitRate handle empty and mixed samples', () => {
  assert.equal(hitRate(0, 0), null);
  assert.equal(formatHitRate(0, 0), 'n/a (no samples)');
  assert.equal(hitRate(3, 1), 0.75);
  assert.match(formatHitRate(3, 1), /75\.0%/);
});

test('collectCacheProbe reports project-context and nav-index averages', async () => {
  clearProjectContextCache();
  resetNavCacheStats();

  const workspace = await mkdtemp(join(tmpdir(), 'aicode-cache-probe-'));
  try {
    await writeFile(join(workspace, 'AGENTS.md'), 'Prefer tools.');
    await mkdir(join(workspace, 'src'), { recursive: true });
    await writeFile(join(workspace, 'src', 'a.ts'), 'export function alpha() {}\n');

    await readProjectContext(workspace);
    await readProjectContext(workspace);
    await readProjectContext(workspace);

    const store = new NavIndexStore(workspace);
    await store.loadOrBuild();
    await store.loadOrBuild();

    const report = collectCacheProbe();
    assert.ok(report.totalLookups >= 4);
    assert.ok((report.averageHitRate ?? 0) > 0);
    assert.match(report.averageHitRatePercent, /%/);
    const project = report.buckets.find((bucket) => bucket.name === 'project-context');
    const nav = report.buckets.find((bucket) => bucket.name === 'nav-index');
    assert.ok((project?.hits ?? 0) >= 2);
    assert.ok((project?.misses ?? 0) >= 1);
    assert.ok((nav?.hits ?? 0) >= 1);
    assert.ok((nav?.filesCached ?? 0) >= 1 || (nav?.filesParsed ?? 0) >= 1);

    const text = formatCacheProbe(report);
    assert.match(text, /Cache probe/);
    assert.match(text, /average hit rate:/);
    assert.match(text, /project-context/);
    assert.match(text, /nav-index/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('/cache slash command returns probe text', async () => {
  clearProjectContextCache();
  resetNavCacheStats();
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-cache-cmd-'));
  try {
    await writeFile(join(workspace, 'AGENTS.md'), 'cache me');
    await readProjectContext(workspace);
    await readProjectContext(workspace);

    const config = await loadConfig({ provider: 'mock', workspace }, {});
    const provider = createMockProvider(config.model);
    const sessions = new SessionStore(config.sessionDir);
    const session = await sessions.create({ provider: provider.name, model: provider.model, workspaceRoot: workspace });
    const tools = createDefaultToolRegistry();
    const out = await handleSlashCommand({ line: '/cache', config, provider, tools, sessions, session });
    assert.match(out, /Cache probe/);
    assert.match(out, /average hit rate:/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
