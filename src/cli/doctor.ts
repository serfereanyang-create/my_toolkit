import { access, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '../config/types.js';
import type { McpManager } from '../mcp/manager.js';
import { isSandboxScrubEnabled } from '../safety/sandbox.js';
import type { Provider } from '../providers/types.js';
import type { ToolRegistry } from '../tools/index.js';
import { collectCacheProbe } from '../probe/cacheProbe.js';

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export async function runDoctor(
  config: AppConfig,
  provider: Provider,
  tools: ToolRegistry,
  mcp?: McpManager,
): Promise<DoctorCheck[]> {
  return [
    nodeVersionCheck(),
    await pathExistsCheck('workspace', config.workspaceRoot),
    await sessionDirCheck(config.sessionDir),
    providerAuthCheck(config),
    toolRegistryCheck(tools),
    providerCheck(provider),
    mcpCheck(mcp),
    sandboxCheck(),
    cacheProbeCheck(),
  ];
}

export function formatDoctor(checks: DoctorCheck[]) {
  return checks.map((check) => `${check.ok ? 'ok' : 'fail'} ${check.name}: ${check.detail}`).join('\n');
}

function nodeVersionCheck(): DoctorCheck {
  const major = Number(process.versions.node.split('.')[0]);
  return { name: 'node', ok: major >= 20, detail: process.version };
}

async function pathExistsCheck(name: string, path: string): Promise<DoctorCheck> {
  const ok = await access(path).then(() => true, () => false);
  return { name, ok, detail: path };
}

async function sessionDirCheck(path: string): Promise<DoctorCheck> {
  try {
    await mkdir(path, { recursive: true });
    const probe = join(path, '.doctor-write-test');
    await writeFile(probe, 'ok');
    await rm(probe, { force: true });
    return { name: 'sessionDir', ok: true, detail: path };
  } catch (error) {
    return { name: 'sessionDir', ok: false, detail: `${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function providerAuthCheck(config: AppConfig): DoctorCheck {
  const ok = config.provider === 'mock' || Boolean(config.apiKey);
  return { name: 'providerAuth', ok, detail: ok ? `${config.provider} ready` : `${config.provider} API key missing` };
}

function toolRegistryCheck(tools: ToolRegistry): DoctorCheck {
  const count = tools.list().length;
  return { name: 'tools', ok: count >= 10, detail: `${count} registered` };
}

function providerCheck(provider: Provider): DoctorCheck {
  return { name: 'provider', ok: Boolean(provider.name && provider.model), detail: `${provider.name}/${provider.model}` };
}

function mcpCheck(mcp?: McpManager): DoctorCheck {
  if (!mcp || mcp.statuses.length === 0) {
    return { name: 'mcp', ok: true, detail: 'no servers configured' };
  }
  const failed = mcp.statuses.filter((status) => status.enabled && !status.connected);
  const connected = mcp.statuses.filter((status) => status.connected).length;
  const tools = mcp.tools.length;
  if (failed.length > 0) {
    return {
      name: 'mcp',
      ok: false,
      detail: `${connected} connected, ${failed.length} failed (${failed.map((item) => item.name).join(', ')}); tools=${tools}`,
    };
  }
  return { name: 'mcp', ok: true, detail: `${connected} connected, tools=${tools}` };
}

function sandboxCheck(): DoctorCheck {
  const scrub = isSandboxScrubEnabled();
  return {
    name: 'sandbox',
    ok: true,
    detail: scrub
      ? 'process sandbox active (secret env scrub on; timeout tree-kill)'
      : 'process sandbox active (secret env scrub OFF via AICODE_SANDBOX; timeout tree-kill still on)',
  };
}

function cacheProbeCheck(): DoctorCheck {
  const probe = collectCacheProbe();
  return {
    name: 'cache',
    ok: true,
    detail: `avg hit rate ${probe.averageHitRatePercent}; project-context hits=${probe.buckets[0]?.hits ?? 0} misses=${probe.buckets[0]?.misses ?? 0}; nav hits=${probe.buckets[1]?.hits ?? 0} misses=${probe.buckets[1]?.misses ?? 0}`,
  };
}
