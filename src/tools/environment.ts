import { execFile } from 'node:child_process';
import { arch, cpus, freemem, hostname, platform, release, totalmem, type } from 'node:os';
import { promisify } from 'node:util';
import type { ToolDefinition } from './types.js';

const execFileAsync = promisify(execFile);

type EnvironmentInfoInput = {
  includeVersions: boolean;
};

type VersionInfo = {
  node: string;
  npm?: string;
  git?: string;
  python?: string;
};

export const environmentInfoTool: ToolDefinition<EnvironmentInfoInput> = {
  name: 'environment_info',
  description: 'Inspect the CLI runtime environment, OS, workspace, shell, memory, CPU, and common tool versions.',
  inputHint: '{ "includeVersions": true }',
  risk: 'read',
  validate(input) {
    if (input === undefined || input === null) return { includeVersions: true };
    if (typeof input !== 'object' || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    return { includeVersions: record.includeVersions !== false };
  },
  async execute(input, context) {
    const versions = input.includeVersions ? await collectVersions() : undefined;
    const info = {
      cwd: process.cwd(),
      workspaceRoot: context.workspaceRoot,
      platform: process.platform,
      osPlatform: platform(),
      osType: type(),
      osRelease: release(),
      arch: arch(),
      hostname: hostname(),
      shell: process.env.ComSpec ?? process.env.SHELL,
      node: process.version,
      cpuCount: cpus().length,
      totalMemoryMb: Math.round(totalmem() / 1024 / 1024),
      freeMemoryMb: Math.round(freemem() / 1024 / 1024),
      versions,
    };
    return { ok: true, output: formatInfo(info), data: info };
  },
};

async function collectVersions(): Promise<VersionInfo> {
  const [npm, git, python] = await Promise.all([versionOf('npm', ['--version']), versionOf('git', ['--version']), versionOf('python', ['--version'])]);
  return { node: process.version, npm, git, python };
}

async function versionOf(command: string, args: string[]) {
  try {
    const result = await execFileAsync(command, args, { timeout: 10000, windowsHide: true, maxBuffer: 128 * 1024 });
    return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
  } catch {
    return undefined;
  }
}

function formatInfo(info: Record<string, unknown>) {
  return Object.entries(info)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
    .join('\n');
}
