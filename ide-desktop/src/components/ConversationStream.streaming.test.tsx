import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { initialState } from '../lib/state';
import type { AppState, ChatItem } from '../types';

// `lib/ipc` reads `window.zcodeDesktop` at module scope, so the bridge has to
// exist before the component graph is imported.
vi.stubGlobal('window', {
  zcodeDesktop: {
    fs: { write: async () => ({ ok: true }) },
    agent: { taskBoardAction: async () => ({ ok: true }) },
  },
});

const { ConversationStream } = await import('./ConversationStream');

/** A turn that is still running: the progress row only exists in this shape. */
const runningTurn: ChatItem = {
  id: 'turn-live', kind: 'turn', startedAt: Date.now() - 4000,
  steps: [{ id: 'step-live', kind: 'tool', status: 'running', tool: 'run_command', input: { command: 'npm run build' }, startedAt: Date.now() - 3900 }],
  files: [], added: 0, removed: 0,
};

function renderStream(chat: ChatItem[], agentStatus: AppState['agentStatus'] = 'running') {
  const state = { ...initialState, chat, agentStatus } as AppState;
  return renderToStaticMarkup(createElement(ConversationStream, {
    state,
    dispatch: () => {},
    onApprove: () => {},
    onEditUser: () => {},
    onUndo: () => {},
    onOpenFile: () => {},
  }));
}

describe('streaming conversation feedback', () => {
  it('shows how much text has arrived and how fast while a reply streams', () => {
    const markup = renderStream([
      { id: 'u1', kind: 'user', text: '把结论展开讲一遍' },
      runningTurn,
      { id: 'assistant-live', kind: 'assistant', text: '正在生成的这一段话'.repeat(20) },
    ]);
    // 180 个字符已经在气泡里，指示条要把这个数字说出来，而不是只转个圈。
    expect(markup).toContain('生成中 180 字');
    expect(markup).toMatch(/生成中 180 字 · \d+ 字\/秒/);
  });

  it('keeps the throughput out of the progress row when nothing is streaming', () => {
    const markup = renderStream([
      { id: 'u1', kind: 'user', text: '把结论展开讲一遍' },
      runningTurn,
      { id: 'a1', kind: 'assistant', text: '这一段已经写完了。' },
    ]);
    expect(markup).toContain('正在工作');
    expect(markup).not.toContain('生成中');
  });

  it('marks the live bubble and keeps a caret on it until the reply finalises', () => {
    const streaming = renderStream([{ id: 'assistant-live', kind: 'assistant', text: '半句话' }]);
    expect(streaming).toContain('msg-assistant streaming');
    expect(streaming).toContain('msg-stream-caret');

    const finished = renderStream([{ id: 'assistant-1', kind: 'assistant', text: '写完了。' }]);
    expect(finished).not.toContain('msg-stream-caret');
  });
});
