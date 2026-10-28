import type { IBuffer } from '@xterm/xterm';

export function readTerminalOutput(buffer: Pick<IBuffer, 'length' | 'getLine'>): string {
  const rows: Array<{ text: string; wrapped: boolean }> = [];
  let logicalLines = 0;
  for (let index = buffer.length - 1; index >= 0; index -= 1) {
    const line = buffer.getLine(index);
    if (!line) continue;
    const text = line.translateToString(!rows.at(-1)?.wrapped);
    if (rows.length === 0 && !text) continue;
    rows.push({ text, wrapped: line.isWrapped });
    if (!line.isWrapped) logicalLines += 1;
    if (logicalLines >= 200) break;
  }
  const lines: string[] = [];
  for (const row of rows.reverse()) {
    if (row.wrapped && lines.length > 0) lines[lines.length - 1] += row.text;
    else lines.push(row.text);
  }
  return lines.join('\n');
}

export function terminalMentionContext(label: string, content: string): string {
  const excerpt = content.slice(-6000);
  const longestRun = Math.max(0, ...(excerpt.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `**@${label}**（已引用的终端输出）:\n${fence}text\n${excerpt}\n${fence}`;
}
