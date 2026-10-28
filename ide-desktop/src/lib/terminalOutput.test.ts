import { describe, expect, it } from 'vitest';
import type { IBuffer, IBufferLine } from '@xterm/xterm';
import { readTerminalOutput, terminalMentionContext } from './terminalOutput';

function buffer(rows: Array<{ text: string; wrapped?: boolean }>): Pick<IBuffer, 'length' | 'getLine'> {
  return {
    length: rows.length,
    getLine: index => rows[index] ? {
      isWrapped: rows[index]!.wrapped ?? false,
      translateToString: trimRight => trimRight ? rows[index]!.text.trimEnd() : rows[index]!.text,
    } as IBufferLine : undefined,
  };
}

describe('terminal context capture', () => {
  it('joins screen wraps while keeping real line boundaries and blank lines', () => {
    expect(readTerminalOutput(buffer([
      { text: 'long output ' }, { text: 'continues', wrapped: true },
      { text: '' }, { text: 'last line' }, { text: '' }, { text: '' },
    ]))).toBe('long output continues\n\nlast line');
  });

  it('retains the last 200 logical lines without counting screen wraps as new output', () => {
    const rows = Array.from({ length: 205 }, (_, index) => [
      { text: `line-${index}:` }, { text: ' continuation', wrapped: true },
    ]).flat();
    const captured = readTerminalOutput(buffer(rows));
    expect(captured.split('\n')).toHaveLength(200);
    expect(captured.split('\n')[0]).toBe('line-5: continuation');
    expect(captured.split('\n').at(-1)).toBe('line-204: continuation');
  });

  it('handles empty buffers without inventing content', () => {
    expect(readTerminalOutput(buffer([]))).toBe('');
    expect(readTerminalOutput(buffer([{ text: '' }]))).toBe('');
  });

  it('bounds a quoted snapshot and keeps code fences inside terminal output literal', () => {
    const excerpt = `before\n\`\`\`\`\`\nlast`;
    const context = terminalMentionContext('终端输出', 'x'.repeat(6500) + excerpt);
    expect(context).toContain('\n``````text\n');
    expect(context.endsWith('\n``````')).toBe(true);
    expect(context).toContain(excerpt);
    expect(context).not.toContain('x'.repeat(6001));
  });
});
