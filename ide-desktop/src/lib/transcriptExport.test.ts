import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../types';
import { summarizeTranscript, transcriptFileName, transcriptToMarkdown } from './transcriptExport';

const user = (id: string, text: string, ts?: number): ChatItem => ({ id, kind: 'user', text, ts });
const assistant = (id: string, text: string): ChatItem => ({ id, kind: 'assistant', text });
const error = (id: string, text: string): ChatItem => ({ id, kind: 'error', text });

function turn(overrides: Partial<Extract<ChatItem, { kind: 'turn' }>> = {}): Extract<ChatItem, { kind: 'turn' }> {
  return {
    id: 't1',
    kind: 'turn',
    startedAt: Date.parse('2026-09-12T10:00:00Z'),
    endedAt: Date.parse('2026-09-12T10:00:05Z'),
    steps: [],
    files: [],
    added: 0,
    removed: 0,
    ...overrides,
  };
}

describe('transcriptToMarkdown', () => {
  it('renders an empty transcript with just the default title', () => {
    const md = transcriptToMarkdown([]);
    expect(md).toContain('# YOYcode 会话记录');
    expect(md.trim().split('\n')).toHaveLength(1);
  });

  it('renders user and assistant sections in order', () => {
    const md = transcriptToMarkdown([
      user('u1', '帮我修 bug'),
      assistant('a1', '好的，先看日志。'),
    ]);
    expect(md).toContain('## 用户');
    expect(md).toContain('帮我修 bug');
    expect(md).toContain('## 助手');
    expect(md).toContain('好的，先看日志。');
    expect(md.indexOf('## 用户')).toBeLessThan(md.indexOf('## 助手'));
  });

  it('includes a timestamp line under timestamped user turns', () => {
    const ts = Date.parse('2026-09-12T10:30:00');
    const md = transcriptToMarkdown([user('u1', 'hi', ts)]);
    expect(md).toMatch(/\*2026-09-12 \d{2}:30\*/);
  });

  it('renders errors as blockquotes', () => {
    const md = transcriptToMarkdown([error('e1', 'API key 缺失')]);
    expect(md).toContain('> ⚠️ **错误**：API key 缺失');
  });

  it('renders approvals with localized decision labels', () => {
    const approval: ChatItem = { id: 'p1', kind: 'approval', requestId: 'r1', tool: 'bash', message: '', decided: 'allow_session' };
    const md = transcriptToMarkdown([approval]);
    expect(md).toContain('**审批** · `bash` · 已允许（本会话）');
    const pending: ChatItem = { id: 'p2', kind: 'approval', requestId: 'r2', tool: 'write', message: '' };
    expect(transcriptToMarkdown([pending])).toContain('待决定');
  });

  it('renders working turns with stats, files and collapsible steps', () => {
    const item = turn({
      added: 10,
      removed: 3,
      files: [{ path: 'src/a.ts', added: 10, removed: 3, checkpointIds: ['c1'] }],
      steps: [{ id: 's1', kind: 'tool', status: 'done', tool: 'Read', output: 'x'.repeat(600), durationMs: 1200 } as never],
    });
    const md = transcriptToMarkdown([item]);
    expect(md).toContain('### 🛠 工作回合 — 回合 1 · 1 步 · +10 / -3 · 5s');
    expect(md).toContain('`+` src/a.ts（+10 / -3）');
    expect(md).toContain('<details>');
    expect(md).toContain('✓ `Read`（1.2s）');
  });

  it('honors includeSteps=false and maxOutputChars', () => {
    const item = turn({ steps: [{ id: 's', kind: 'tool', status: 'done', tool: 'Bash', output: 'out' } as never] });
    const noSteps = transcriptToMarkdown([item], { includeSteps: false });
    expect(noSteps).not.toContain('<details>');
    expect(noSteps).toContain('工作回合');
    const trimmed = transcriptToMarkdown([turn({ steps: [{ id: 's', kind: 'tool', status: 'done', tool: 'Bash', output: 'a'.repeat(100) } as never] })], { maxOutputChars: 10 });
    expect(trimmed).toContain(`${'a'.repeat(10)}…`);
    const noTrunc = transcriptToMarkdown([turn({ steps: [{ id: 's', kind: 'tool', status: 'done', tool: 'Bash', output: 'a'.repeat(100) } as never] })], { maxOutputChars: 0 });
    expect(noTrunc).toContain('a'.repeat(100));
  });

  it('marks deleted-file changes with a minus marker', () => {
    const md = transcriptToMarkdown([turn({ files: [{ path: 'gone.ts', added: 0, removed: 7, checkpointIds: [] }] })]);
    expect(md).toContain('`-` gone.ts（+0 / -7）');
  });

  it('renders stray tool rows outside turns compactly', () => {
    const stray: ChatItem = { id: 'tr', kind: 'tool', status: 'failed', tool: 'Grep' };
    expect(transcriptToMarkdown([stray])).toContain('- 工具 `Grep` ✗');
  });

  it('adds a workspace header when provided', () => {
    const md = transcriptToMarkdown([user('u', 'x')], { workspaceRoot: 'C:/demo' });
    expect(md).toContain('> 工作区：`C:/demo`');
  });

  it('collapses consecutive blank lines', () => {
    const md = transcriptToMarkdown([user('u1', 'a'), user('u2', 'b')]);
    expect(md).not.toMatch(/\n\n\n/);
  });
});

describe('transcriptFileName', () => {
  it('sanitizes Windows-forbidden characters and spaces', () => {
    const name = transcriptFileName('a/b:c*d?e', new Date(0));
    expect(name).toMatch(/^abcde-/);
    expect(name.endsWith('.md')).toBe(true);
  });

  it('falls back for empty titles and truncates long ones', () => {
    expect(transcriptFileName('', new Date(0))).toMatch(/^yoycode-chat-\d{8}-\d{4}\.md$/);
    expect(transcriptFileName('长'.repeat(80), new Date(0)).startsWith('长'.repeat(60))).toBe(true);
  });
});

describe('summarizeTranscript', () => {
  it('counts rows of every kind including steps', () => {
    const counts = summarizeTranscript([
      user('u1', 'a'),
      assistant('a1', 'b'),
      turn({ steps: [
        { id: 's1', kind: 'tool', status: 'done', tool: 'x' } as never,
        { id: 's2', kind: 'tool', status: 'done', tool: 'y' } as never,
      ] }),
      { id: 't', kind: 'tool', status: 'running', tool: 'z' } as never,
    ]);
    expect(counts).toEqual({ user: 1, assistant: 1, turns: 1, tools: 3 });
  });
});
