import type { Locale } from '../i18n/locale.js';

type DiskRow = {
  name?: string;
  path?: string;
  usedGb?: number;
  freeGb?: number;
  totalGb?: number;
};

type ProcessRow = {
  name?: string;
  pid?: number;
  memoryMb?: number;
};

/**
 * Build a plain-language conclusion card from a successful diagnostic tool result.
 * Used so users see 结论 + 数据 + 下一步 instead of "Done. I translated...".
 */
export function formatResultCard(options: {
  tool: string;
  output: string;
  data?: unknown;
  locale?: Locale;
}): string | undefined {
  const locale = options.locale ?? 'en';
  switch (options.tool) {
    case 'disk_info':
      return formatDiskCard(options.data, options.output, locale);
    case 'process_memory':
      return formatProcessCard(options.data, options.output, locale);
    case 'environment_info':
      return formatEnvironmentCard(options.data, options.output, locale);
    default:
      return undefined;
  }
}

export function isMetaTranslatedDone(content: string) {
  return /Done\.\s*I translated the natural-language request into \d+ tool call\(s\)\./i.test(content)
    || /完成。?已把自然语言请求翻译成 \d+ 次工具调用/.test(content);
}

export function summarizeToolLine(options: {
  tool: string;
  ok: boolean;
  duration?: string;
  output?: string;
  data?: unknown;
  locale?: Locale;
}) {
  const status = options.ok ? 'ok' : 'failed';
  const dur = options.duration ? ` ${options.duration}` : '';
  const hint = oneLineHint(options.tool, options.ok, options.output, options.data, options.locale ?? 'en');
  return hint ? `${options.tool} ${status}${dur} · ${hint}` : `${options.tool} ${status}${dur}`;
}

function formatDiskCard(data: unknown, output: string, locale: Locale) {
  const disk = firstDisk(data) ?? parseDiskFromOutput(output);
  if (!disk) return undefined;
  const name = disk.name || disk.path || 'disk';
  const free = num(disk.freeGb);
  const total = num(disk.totalGb);
  const used = num(disk.usedGb);
  const pct = total && free !== undefined ? Math.round((free / total) * 100) : undefined;
  if (locale === 'zh') {
    return [
      `结论：${name} 磁盘还有可用空间。`,
      `数据：可用 ${fmt(free)} GB / 总计 ${fmt(total)} GB（已用 ${fmt(used)} GB${pct !== undefined ? `，可用约 ${pct}%` : ''}）`,
      '下一步：若空间紧张，可再问“C盘最近谁变大了”或清理临时文件。',
    ].join('\n');
  }
  return [
    `Conclusion: ${name} still has free space.`,
    `Data: free ${fmt(free)} GB / total ${fmt(total)} GB (used ${fmt(used)} GB${pct !== undefined ? `, ~${pct}% free` : ''})`,
    'Next: if space is tight, ask what grew recently or clean temp files.',
  ].join('\n');
}

function formatProcessCard(data: unknown, output: string, locale: Locale) {
  const rows = processRows(data) ?? parseProcessFromOutput(output);
  if (!rows.length) return undefined;
  const top = rows.slice(0, 5);
  const lines = top.map((row, index) => `${index + 1}. ${row.name ?? '?'} (pid ${row.pid ?? '?'}) ${fmt(row.memoryMb)} MB`);
  if (locale === 'zh') {
    return [
      '结论：当前内存占用较高的进程如下。',
      '数据：',
      ...lines,
      '下一步：若某进程异常偏高，可说明进程名让我帮你判断是否可结束。',
    ].join('\n');
  }
  return [
    'Conclusion: top memory consumers are listed below.',
    'Data:',
    ...lines,
    'Next: if one process looks abnormal, name it and I can help assess.',
  ].join('\n');
}

function formatEnvironmentCard(data: unknown, output: string, locale: Locale) {
  const info = isRecord(data) ? data : undefined;
  const platform = stringField(info, 'osPlatform') || stringField(info, 'platform') || pickLine(output, /platform|os/i);
  const node = stringField(info, 'nodeVersion') || pickLine(output, /node/i);
  const cwd = stringField(info, 'workspaceRoot') || stringField(info, 'cwd');
  if (locale === 'zh') {
    return [
      '结论：当前运行环境正常可读。',
      `数据：系统 ${platform ?? '未知'}；Node ${node ?? '未知'}；工作区 ${cwd ?? '未知'}`,
      '下一步：可继续问磁盘、内存，或让我做 doctor 健康检查。',
    ].join('\n');
  }
  return [
    'Conclusion: runtime environment is readable.',
    `Data: OS ${platform ?? 'unknown'}; Node ${node ?? 'unknown'}; workspace ${cwd ?? 'unknown'}`,
    'Next: ask about disk/memory, or run a doctor health check.',
  ].join('\n');
}

function oneLineHint(tool: string, ok: boolean, output: string | undefined, data: unknown, locale: Locale) {
  if (!ok) return locale === 'zh' ? '失败' : 'failed';
  if (tool === 'disk_info') {
    const disk = firstDisk(data) ?? parseDiskFromOutput(output ?? '');
    if (disk) return locale === 'zh' ? `可用 ${fmt(disk.freeGb)}GB / 共 ${fmt(disk.totalGb)}GB` : `free ${fmt(disk.freeGb)}GB / total ${fmt(disk.totalGb)}GB`;
  }
  if (tool === 'process_memory') {
    const rows = processRows(data) ?? parseProcessFromOutput(output ?? '');
    if (rows[0]) return `${rows[0].name} ${fmt(rows[0].memoryMb)}MB`;
  }
  const first = (output ?? '').split(/\r?\n/).find((line) => line.trim() && !line.includes('\tpath\t') && !/^name\t/.test(line));
  if (!first) return undefined;
  return first.length > 72 ? `${first.slice(0, 69)}...` : first;
}

function firstDisk(data: unknown): DiskRow | undefined {
  if (!isRecord(data)) return undefined;
  const disks = data.disks;
  if (Array.isArray(disks) && disks[0] && isRecord(disks[0])) return disks[0] as DiskRow;
  return undefined;
}

function processRows(data: unknown): ProcessRow[] | undefined {
  if (!isRecord(data)) return undefined;
  const processes = data.processes;
  if (!Array.isArray(processes)) return undefined;
  return processes.filter(isRecord) as ProcessRow[];
}

function parseDiskFromOutput(output: string): DiskRow | undefined {
  const line = output.split(/\r?\n/).find((row) => /^[A-Za-z]:|^\/\t/.test(row) || /\t\d+(\.\d+)?\t\d+(\.\d+)?\t\d+(\.\d+)?$/.test(row));
  if (!line) return undefined;
  const parts = line.split('\t');
  if (parts.length < 5) return undefined;
  return {
    name: parts[0],
    path: parts[1],
    usedGb: Number(parts[2]),
    freeGb: Number(parts[3]),
    totalGb: Number(parts[4]),
  };
}

function parseProcessFromOutput(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split(/\r?\n/).slice(1)) {
    const parts = line.split('\t');
    if (parts.length < 3 || !parts[0]) continue;
    rows.push({ name: parts[0], pid: Number(parts[1]), memoryMb: Number(parts[2]) });
  }
  return rows;
}

function pickLine(output: string, pattern: RegExp) {
  const line = output.split(/\r?\n/).find((row) => pattern.test(row));
  return line?.trim();
}

function stringField(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function num(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function fmt(value: number | undefined) {
  if (value === undefined || Number.isNaN(value)) return '?';
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}
