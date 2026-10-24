import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskCard } from './TaskCard';
import type { ChatItem, TaskSummary, ToolChatItem } from '../types';

const step = (id: string, tool: string, ok = true): ToolChatItem => ({
  id,
  kind: 'tool',
  status: 'done',
  tool,
  ok,
});

function turn(id: string, steps: ToolChatItem[], endedAt?: number): ChatItem {
  return {
    id,
    kind: 'turn',
    startedAt: 1,
    endedAt,
    steps,
    files: [],
    added: 0,
    removed: 0,
  } as ChatItem;
}

function render(chat: ChatItem[], expanded = true): string {
  const summary: TaskSummary = { title: '调研子智能体', expanded };
  return renderToStaticMarkup(createElement(TaskCard, {
    summary,
    chat,
    onToggle: () => undefined,
  }));
}

describe('TaskCard', () => {
  it('lists the steps of the running turn', () => {
    const html = render([turn('t1', [step('s1', 'read_file'), step('s2', 'word_count')])]);
    expect(html).toContain('read_file');
    expect(html).toContain('word_count');
    expect(html).toContain('（2/2 完成）');
  });

  it('keeps the finished turn’s steps visible after the turn ends', () => {
    // Real bug: the card only searched for a turn with no endedAt, so the
    // moment a task completed the top bar still advertised 「（4/4 完成）」 with
    // nothing behind it — clicking the card opened an empty dropdown.
    const html = render([turn('t1', [step('s1', 'read_file'), step('s2', 'run_command')], 99)]);
    expect(html).toContain('read_file');
    expect(html).toContain('run_command');
    expect(html).toContain('（2/2 完成）');
  });

  it('prefers the running turn over an earlier finished one', () => {
    const html = render([
      turn('t1', [step('old', 'git_diff')], 99),
      turn('t2', [step('new', 'word_count')]),
    ]);
    expect(html).toContain('word_count');
    expect(html).not.toContain('git_diff');
  });

  it('falls back to the newest turn when none is running', () => {
    const html = render([
      turn('t1', [step('old', 'git_diff')], 50),
      turn('t2', [step('new', 'word_count')], 99),
    ]);
    expect(html).toContain('word_count');
    expect(html).not.toContain('git_diff');
  });
});
