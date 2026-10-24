import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';
import { resolveWorkspacePath } from '../safety/policy.js';
import type { ToolDefinition } from './types.js';
import { isIgnoredDirName } from '../workspace/ignored.js';


type DiskGrowthInput = {
  path: string;
  hours: number;
  minMb: number;
  maxFiles: number;
  maxVisited: number;
};

type LargeRecentFile = {
  path: string;
  modifiedAt: string;
  sizeMb: number;
};

export const diskGrowthTool: ToolDefinition<DiskGrowthInput> = {
  name: 'disk_growth',
  description: 'Find recently modified large files under a bounded path to explain disk growth.',
  inputHint: '{ "path": ".", "hours": 48, "minMb": 16, "maxFiles": 30 }',
  risk: 'read',
  validate(input) {
    if (input === undefined || input === null) return defaults();
    if (typeof input !== 'object' || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    return {
      path: typeof record.path === 'string' && record.path.trim() ? record.path : defaults().path,
      hours: typeof record.hours === 'number' && record.hours > 0 ? Math.min(Math.floor(record.hours), 24 * 30) : defaults().hours,
      minMb: typeof record.minMb === 'number' && record.minMb >= 0 ? Math.min(record.minMb, 1024 * 10) : defaults().minMb,
      maxFiles: typeof record.maxFiles === 'number' && record.maxFiles > 0 ? Math.min(Math.floor(record.maxFiles), 200) : defaults().maxFiles,
      maxVisited: typeof record.maxVisited === 'number' && record.maxVisited > 0 ? Math.min(Math.floor(record.maxVisited), 100000) : defaults().maxVisited,
    };
  },
  async execute(input, context) {
    const root = resolveScanRoot(context.workspaceRoot, input.path);
    const since = Date.now() - input.hours * 60 * 60 * 1000;
    const visited = { count: 0 };
    const files: LargeRecentFile[] = [];
    await walk(root, root, since, input.minMb, input.maxVisited, visited, files);
    files.sort((a, b) => b.sizeMb - a.sizeMb || b.modifiedAt.localeCompare(a.modifiedAt));
    const shown = files.slice(0, input.maxFiles);
    return { ok: true, output: formatFiles(shown, visited.count), data: { root, visited: visited.count, files: shown } };
  },
};

function defaults(): DiskGrowthInput {
  return { path: '.', hours: 48, minMb: 16, maxFiles: 30, maxVisited: 30000 };
}

function resolveScanRoot(workspaceRoot: string, path: string) {
  if (path === '~') return homedir();
  if (/^[A-Za-z]:[\\/]?$/.test(path)) return `${path.slice(0, 1).toUpperCase()}:/`;
  if (/^[A-Za-z]:[\\/]/.test(path)) return path.replace(/\\/g, '/');
  return resolveWorkspacePath(workspaceRoot, path);
}

async function walk(current: string, root: string, since: number, minMb: number, maxVisited: number, visited: { count: number }, files: LargeRecentFile[]): Promise<void> {
  if (visited.count >= maxVisited) return;
  let info;
  try {
    info = await stat(current);
  } catch {
    return;
  }
  visited.count += 1;
  if (info.isFile()) {
    const sizeMb = Math.round((info.size / 1024 / 1024) * 10) / 10;
    if (info.mtimeMs >= since && sizeMb >= minMb) files.push({ path: relative(root, current).replace(/\\/g, '/') || current, modifiedAt: info.mtime.toISOString(), sizeMb });
    return;
  }
  if (!info.isDirectory()) return;
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (visited.count >= maxVisited) return;
    if (entry.isDirectory() && isIgnoredDirName(entry.name)) continue;
    await walk(join(current, entry.name), root, since, minMb, maxVisited, visited, files);
  }
}

function formatFiles(files: LargeRecentFile[], visited: number) {
  if (files.length === 0) return `visited: ${visited}\nrecent large files: none`;
  return [`visited: ${visited}`, 'sizeMB\tmodifiedAt\tpath', ...files.map((file) => `${file.sizeMb}\t${file.modifiedAt}\t${file.path}`)].join('\n');
}
