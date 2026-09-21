import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { appReducer, initialState } from './state';
import { ReviewReport } from '../components/ReviewReport';
import type { AgentEvent, ChatItem } from '../types';

/*
 * The payload captured from a real CLI run (provider stubbed to return a
 * rubric-shaped report), fed through the real reducer and rendered by the real
 * component. Pins that the wire format and the UI agree — a unit test on
 * either side alone cannot catch a field the CLI renames.
 */
const PAYLOAD = {
  type: 'review_report',
  sessionId: 'sess_20260921164721_06a99480',
  label: '未提交的改动',
  ok: true,
  findings: [{
    title: 'Off by one',
    body: 'Runs past the end.',
    confidenceScore: 0.9,
    priority: 1,
    filePath: 'a.txt',
    lineStart: 2,
    lineEnd: 2,
  }],
  outcome: 'incorrect',
  explanation: 'One defect.',
  subSessionId: 'sess_20260921164721_7effdb30',
  durationMs: 15,
};

describe('a real review_report payload', () => {
  it('survives the reducer with every field intact', () => {
    const state = appReducer(initialState, { type: 'agent/event', event: PAYLOAD as unknown as AgentEvent });
    const row = state.chat.find((item): item is Extract<ChatItem, { kind: 'review' }> => item.kind === 'review')!;
    expect(row.label).toBe('未提交的改动');
    expect(row.outcome).toBe('incorrect');
    expect(row.explanation).toBe('One defect.');
    expect(row.findings).toEqual(PAYLOAD.findings);
  });

  it('renders into the visible report', () => {
    const state = appReducer(initialState, { type: 'agent/event', event: PAYLOAD as unknown as AgentEvent });
    const row = state.chat.find((item): item is Extract<ChatItem, { kind: 'review' }> => item.kind === 'review')!;
    const markup = renderToStaticMarkup(createElement(ReviewReport, { review: row, onOpenFile: () => undefined }));
    expect(markup).toContain('Off by one');
    expect(markup).toContain('P1');
    expect(markup).toContain('a.txt:2');
    expect(markup).toContain('Runs past the end.');
    expect(markup).toContain('补丁不正确');
    expect(markup).toContain('90%');
  });
});
