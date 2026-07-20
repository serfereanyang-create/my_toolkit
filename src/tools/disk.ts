import { statfs } from 'node:fs/promises';
import type { ToolDefinition } from './types.js';

type DiskInfoInput = {
  drive?: string;
};

type DiskInfo = {
  name: string;
  path: string;
  usedGb: number;
  freeGb: number;
  totalGb: number;
};

export const diskInfoTool: ToolDefinition<DiskInfoInput> = {
  name: 'disk_info',
  description: 'Show disk capacity, used space, and free space for a local drive.',
  inputHint: '{ "drive": "C" }',
  risk: 'read',
  validate(input) {
    if (input === undefined || input === null) return {};
    if (typeof input !== 'object' || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    return { drive: typeof record.drive === 'string' ? record.drive.replace(/[:\\/]/g, '').slice(0, 8) : undefined };
  },
  async execute(input) {
    const row = await diskInfo(input.drive);
    return { ok: true, output: formatRows([row]), data: { disks: [row] } };
  },
};

async function diskInfo(drive: string | undefined): Promise<DiskInfo> {
  const path = diskPath(drive);
  const stats = await statfs(path);
  const blockSize = Number(stats.bsize);
  const totalBytes = Number(stats.blocks) * blockSize;
  const freeBytes = Number(stats.bavail) * blockSize;
  const usedBytes = totalBytes - freeBytes;
  return {
    name: diskName(drive),
    path,
    usedGb: bytesToGb(usedBytes),
    freeGb: bytesToGb(freeBytes),
    totalGb: bytesToGb(totalBytes),
  };
}

function diskPath(drive: string | undefined) {
  if (process.platform === 'win32') return `${(drive || 'C').slice(0, 1).toUpperCase()}:/`;
  return drive?.startsWith('/') ? drive : '/';
}

function diskName(drive: string | undefined) {
  if (process.platform === 'win32') return `${(drive || 'C').slice(0, 1).toUpperCase()}:`;
  return drive || '/';
}

function formatRows(rows: DiskInfo[]) {
  if (rows.length === 0) return '(no disks found)';
  return ['name\tpath\tusedGB\tfreeGB\ttotalGB', ...rows.map((row) => `${row.name}\t${row.path}\t${row.usedGb}\t${row.freeGb}\t${row.totalGb}`)].join('\n');
}

function bytesToGb(value: number) {
  return Math.round((value / 1024 / 1024 / 1024) * 100) / 100;
}
