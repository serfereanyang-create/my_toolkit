import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDefinition } from './types.js';

const execFileAsync = promisify(execFile);

type ProcessMemoryInput = {
  limit: number;
};

type ProcessRow = {
  name: string;
  pid: number;
  memoryMb: number;
};

export const processMemoryTool: ToolDefinition<ProcessMemoryInput> = {
  name: 'process_memory',
  description: 'List the local processes using the most memory, cross-platform where possible.',
  inputHint: '{ "limit": 10 }',
  risk: 'read',
  validate(input) {
    if (input === undefined || input === null) return { limit: 10 };
    if (typeof input !== 'object' || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    return { limit: typeof record.limit === 'number' && record.limit > 0 ? Math.min(Math.floor(record.limit), 50) : 10 };
  },
  async execute(input) {
    const rows = process.platform === 'win32' ? await windowsProcesses(input.limit) : await unixProcesses(input.limit);
    return {
      ok: true,
      output: formatRows(rows),
      data: { processes: rows },
    };
  },
};

async function windowsProcesses(limit: number): Promise<ProcessRow[]> {
  const script = [
    'Get-Process',
    '| Sort-Object WorkingSet64 -Descending',
    `| Select-Object -First ${limit} @{Name='name';Expression={$_.ProcessName}},@{Name='pid';Expression={$_.Id}},@{Name='memoryMb';Expression={[math]::Round($_.WorkingSet64/1MB,1)}}`,
    '| ConvertTo-Json -Compress',
  ].join(' ');
  const result = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 });
  const parsed = JSON.parse(result.stdout.trim() || '[]') as ProcessRow | ProcessRow[];
  return normalizeRows(Array.isArray(parsed) ? parsed : [parsed]);
}

async function unixProcesses(limit: number): Promise<ProcessRow[]> {
  const result = await execFileAsync('ps', ['-axo', 'pid=,rss=,comm=', '--sort=-rss'], { timeout: 30000, maxBuffer: 1024 * 1024 });
  return result.stdout
    .trim()
    .split(/\r?\n/)
    .slice(0, limit)
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      return match ? { pid: Number(match[1]), memoryMb: Math.round((Number(match[2]) / 1024) * 10) / 10, name: match[3] } : undefined;
    })
    .filter((row): row is ProcessRow => row !== undefined);
}

function normalizeRows(rows: ProcessRow[]) {
  return rows
    .map((row) => ({ name: String(row.name), pid: Number(row.pid), memoryMb: Number(row.memoryMb) }))
    .filter((row) => row.name && Number.isFinite(row.pid) && Number.isFinite(row.memoryMb));
}

function formatRows(rows: ProcessRow[]) {
  if (rows.length === 0) return '(no processes found)';
  return ['name\tpid\tmemoryMB', ...rows.map((row) => `${row.name}\t${row.pid}\t${row.memoryMb}`)].join('\n');
}
