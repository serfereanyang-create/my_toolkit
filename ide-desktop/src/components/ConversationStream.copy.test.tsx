import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { initialState } from '../lib/state';
import type { AppState, ChatItem } from '../types';

vi.stubGlobal('window', {
  zcodeDesktop: {
    fs: { write: async () => ({ ok: true }) },
    agent: { taskBoardAction: async () => ({ ok: true }) },
  },
});

const { ConversationStream } = await import('./ConversationStream');

/*
 * Copy-the-reply affordance, at the layer the user sees.
 *
 * There is no DOM renderer in this project (see the comment in
 * MessageQueue.test.ts), so this asserts the markup: the button exists on a
 * finished reply and is absent while the reply is still streaming. The click,
 * the hit-testing and the clipboard payload are covered against a real
 * Electron window in scripts/app-copy-checks.cjs.
 */

function renderStream(chat: ChatItem[], agentStatus: AppState['agentStatus'] = 'ready') {
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

const reply = [
  '先把结论说清楚：这一步改成结构化判断了。',
  '',
  '```ts',
  'const verdict = analyzeCommand(command);',
  '```',
].join('\n');

describe('copy a finished reply', () => {
  it('offers one button on a plain reply and names what it copies', () => {
    const markup = renderStream([{ id: 'a1', kind: 'assistant', text: '普通回复，没有代码块。' }]);
    expect(markup).toContain('class="msg-reply-actions"');
    expect(markup).toContain('aria-label="复制整条回复"');
    expect(markup).toContain('title="复制整条回复"');
    // Pinned in normal flow, not hover-revealed: the hit-test (pointer parked
    // away, button still clickable) is asserted in scripts/app-copy-checks.cjs,
    // because markup alone cannot tell a visible control from a dead one.
    expect(markup).toContain('class="msg-reply-copy"');
  });

  it('offers the same button on a reply that also has code blocks', () => {
    const markup = renderStream([{ id: 'a2', kind: 'assistant', text: reply }]);
    expect(markup).toContain('aria-label="复制整条回复"');
    // The per-block buttons are still there: two different jobs.
    expect(markup).toContain('code-block-actions');
    expect(markup).toContain('应用');
  });

  it('withholds the button while the reply is still arriving', () => {
    const markup = renderStream([{ id: 'assistant-live', kind: 'assistant', text: '还在写' }], 'running');
    expect(markup).not.toContain('msg-reply-actions');
    expect(markup).toContain('msg-stream-caret');
  });

  it('does not put the control on user messages or errors', () => {
    const markup = renderStream([
      { id: 'u1', kind: 'user', text: '把结论展开讲一遍' },
      { id: 'e1', kind: 'error', text: '模型不可用' },
    ]);
    expect(markup).not.toContain('msg-reply-actions');
  });
});
