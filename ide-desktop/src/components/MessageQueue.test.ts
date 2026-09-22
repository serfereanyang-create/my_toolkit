import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageQueue } from './MessageQueue';
import type { QueuedMessage } from '../types';

/*
 * The rendered queue rows.
 *
 * This is the layer the bug was reported at: the buttons were on screen but a
 * click produced nothing. The reducer tests cannot catch that, because the
 * problem was the CONTROL's state — 立即 stayed enabled on the row where
 * promoting is a no-op, so the click was real and the effect was nothing.
 *
 * Rendering to static markup asserts what the user's browser actually receives,
 * including the `disabled` attribute that is the fix.
 */

function queued(id: string, text = id): QueuedMessage {
  return { id, sessionId: 'sess_a', text, createdAt: Date.now() };
}

function render(items: QueuedMessage[]): string {
  return renderToStaticMarkup(createElement(MessageQueue, {
    items,
    onSendNow: () => undefined,
    onEdit: () => undefined,
    onRemove: () => undefined,
  }));
}

/** The markup of the nth row, so a per-row assertion is unambiguous. */
function row(markup: string, index: number): string {
  return markup.split('msg-queue-item').slice(1)[index] ?? '';
}

describe('MessageQueue', () => {
  it('renders nothing when the queue is empty', () => {
    expect(render([])).toBe('');
  });

  it('disables 立即 on the only row, and says why', () => {
    const markup = render([queued('a', '只此一条')]);
    // The row is there...
    expect(markup).toContain('只此一条');
    expect(markup).toContain('立即');
    // ...and its 立即 cannot be clicked, rather than clicking into a no-op.
    expect(row(markup, 0)).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*?立即/);
    expect(markup).toContain('已经在队首');
  });

  it('disables 立即 on the first row of a longer queue', () => {
    const markup = render([queued('a', '第一条'), queued('b', '第二条'), queued('c', '第三条')]);
    expect(row(markup, 0)).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*?立即/);
  });

  it('enables 立即 on every later row, where it has something to do', () => {
    const markup = render([queued('a', '第一条'), queued('b', '第二条'), queued('c', '第三条')]);
    for (const index of [1, 2]) {
      const html = row(markup, index);
      expect(html).toContain('立即');
      // The 立即 button on this row must NOT carry disabled.
      const nowButton = html.match(/<button[^>]*msg-queue-now[^>]*>/)?.[0] ?? '';
      expect(nowButton).not.toContain('disabled');
      expect(nowButton).toContain('立即发送（插到队首）');
    }
  });

  it('never disables 编辑 or 删除 — they always have work to do', () => {
    const markup = render([queued('a', '唯一一条')]);
    // Exactly one disabled button in a single-row queue: 立即.
    const disabled = markup.match(/<button[^>]*disabled/g) ?? [];
    expect(disabled).toHaveLength(1);
    expect(markup).toContain('编辑');
    expect(markup).toContain('删除');
  });

  it('numbers the rows so the order is readable', () => {
    const markup = render([queued('a'), queued('b')]);
    expect(markup).toContain('>1<');
    expect(markup).toContain('>2<');
  });
});
