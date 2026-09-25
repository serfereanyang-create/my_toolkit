import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Rail } from './Rail';
import { initialState } from '../lib/state';
import type { AppState } from '../types';
import type { SessionMeta } from '../types';

const session = (id: string, title: string): SessionMeta => ({
  id,
  title,
  pinned: false,
  updatedAt: '2026-09-25T00:00:00.000Z',
  messageCount: 1,
});

function renderRail(overrides: {
  runningIds?: string[];
  approvals?: Record<string, number>;
  activeSessionId?: string;
}) {
  const state = {
    ...initialState,
    activeSessionId: overrides.activeSessionId ?? null,
  } as AppState;
  return renderToStaticMarkup(createElement(Rail, {
    state,
    sessions: [
      session('sess_run', '运行中的会话'),
      session('sess_approval', '等审批的会话'),
      session('sess_idle', '空闲会话'),
    ],
    sessionTags: {},
    recentFiles: [],
    mainView: 'chat',
    runningIds: overrides.runningIds ?? [],
    approvals: overrides.approvals ?? {},
    onNewChat: () => {},
    onOpenWorkspace: () => {},
    onSelectView: () => {},
    onHelpAction: () => {},
    onConvoAction: () => {},
    onOpenSession: () => {},
    onOpenRecent: () => {},
    onSetTags: () => {},
  } as never));
}

describe('Rail status glyphs', () => {
  it('renders a spinner for running sessions', () => {
    const html = renderRail({ runningIds: ['sess_run'] });
    expect(html).toContain('rail-status-spin');
  });

  it('renders a blue attention dot for sessions with pending approvals', () => {
    const html = renderRail({ approvals: { sess_approval: 2 } });
    expect(html).toContain('rail-status-dot');
    expect(html).toContain('2 个待审批');
  });

  it('the approval dot wins over the running spinner on the same row', () => {
    const html = renderRail({
      runningIds: ['sess_approval'],
      approvals: { sess_approval: 1 },
    });
    expect(html).toContain('rail-status-dot');
    expect(html).not.toContain('rail-status-spin');
  });

  it('idle sessions get no status glyph', () => {
    const html = renderRail({});
    expect(html).not.toContain('rail-status-spin');
    expect(html).not.toContain('rail-status-dot');
  });
});
