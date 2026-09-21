import { describe, expect, it } from 'vitest';
import { appReducer, initialState } from './state';
import type { AppState } from '../types';

/*
 * Multiple conversations run at once now: each has its own CLI child and its
 * events arrive on the same channel, stamped with a session id. The reducer must
 * keep a background conversation's events out of the visible chat while still
 * tracking that it is working and whether it is blocked on an approval.
 */
function withActive(sessionId: string): AppState {
  return appReducer(initialState, { type: 'chat/load', sessionId, chat: [] });
}

describe('background conversations', () => {
  it('does not fold another session\'s turn into the visible chat', () => {
    let s = withActive('sess_a');
    const before = s.chat.length;
    // A turn_start for a different session must not open a turn card here.
    s = appReducer(s, { type: 'agent/event', event: { type: 'turn_start', sessionId: 'sess_b', prompt: '别的会话' } });
    expect(s.chat.length).toBe(before);
    expect(s.chat.some((item) => item.kind === 'turn')).toBe(false);
  });

  it('does not fold another session\'s assistant text into the visible chat', () => {
    let s = withActive('sess_a');
    s = appReducer(s, { type: 'agent/event', event: { type: 'assistant_delta', sessionId: 'sess_b', text: '背景会话的输出' } });
    s = appReducer(s, { type: 'agent/event', event: { type: 'assistant_message', sessionId: 'sess_b', text: '背景会话的输出' } });
    expect(s.chat.some((item) => item.kind === 'assistant' && item.text.includes('背景会话'))).toBe(false);
  });

  it('marks a background session as running and clears it when the turn ends', () => {
    let s = withActive('sess_a');
    s = appReducer(s, { type: 'agent/event', event: { type: 'turn_start', sessionId: 'sess_b', prompt: 'x' } });
    expect(s.runningSessions).toContain('sess_b');
    s = appReducer(s, { type: 'agent/event', event: { type: 'turn_done', sessionId: 'sess_b', status: 'ok' } });
    expect(s.runningSessions).not.toContain('sess_b');
  });

  it('clears a background session when its bridge dies', () => {
    let s = withActive('sess_a');
    s = appReducer(s, { type: 'agent/event', event: { type: 'turn_start', sessionId: 'sess_b', prompt: 'x' } });
    s = appReducer(s, { type: 'agent/event', event: { type: 'agent_offline', sessionId: 'sess_b' } });
    expect(s.runningSessions).not.toContain('sess_b');
  });

  it('counts a background session\'s pending approvals', () => {
    let s = withActive('sess_a');
    s = appReducer(s, { type: 'agent/event', event: { type: 'approval_needed', sessionId: 'sess_b', requestId: 'r1', tool: 'write_file', message: 'ok?' } });
    expect(s.sessionApprovals.sess_b).toBe(1);
    s = appReducer(s, { type: 'agent/event', event: { type: 'approval_needed', sessionId: 'sess_b', requestId: 'r2', tool: 'write_file', message: 'ok?' } });
    expect(s.sessionApprovals.sess_b).toBe(2);
  });

  it('drops a background session\'s approval count when its turn ends', () => {
    let s = withActive('sess_a');
    s = appReducer(s, { type: 'agent/event', event: { type: 'approval_needed', sessionId: 'sess_b', requestId: 'r1', tool: 'write_file', message: 'ok?' } });
    s = appReducer(s, { type: 'agent/event', event: { type: 'turn_done', sessionId: 'sess_b', status: 'ok' } });
    expect(s.sessionApprovals.sess_b).toBeUndefined();
  });

  it('still renders the active session\'s own events', () => {
    let s = withActive('sess_a');
    s = appReducer(s, { type: 'agent/event', event: { type: 'turn_start', sessionId: 'sess_a', prompt: '我的会话' } });
    expect(s.chat.some((item) => item.kind === 'turn')).toBe(true);
    expect(s.runningSessions).toContain('sess_a');
    s = appReducer(s, { type: 'agent/event', event: { type: 'turn_done', sessionId: 'sess_a', status: 'ok' } });
    expect(s.runningSessions).not.toContain('sess_a');
  });

  it('routes events with no session id to the active session', () => {
    // The CLI emits some events before bridge_ready names the session; those
    // must not be mistaken for background traffic and dropped.
    let s = withActive('sess_a');
    s = appReducer(s, { type: 'agent/event', event: { type: 'turn_start', prompt: '无会话戳' } });
    expect(s.chat.some((item) => item.kind === 'turn')).toBe(true);
  });

  it('does not cross-contaminate when two sessions interleave', () => {
    let s = withActive('sess_a');
    s = appReducer(s, { type: 'agent/event', event: { type: 'turn_start', sessionId: 'sess_a', prompt: 'A' } });
    s = appReducer(s, { type: 'agent/event', event: { type: 'turn_start', sessionId: 'sess_b', prompt: 'B' } });
    s = appReducer(s, { type: 'agent/event', event: { type: 'tool_start', sessionId: 'sess_b', tool: 'write_file', index: 0 } });
    s = appReducer(s, { type: 'agent/event', event: { type: 'tool_result', sessionId: 'sess_a', tool: 'read_file', ok: true, output: 'A 的结果' } });
    // Only A is on screen: B's tool must not appear, and A's must.
    const text = JSON.stringify(s.chat);
    expect(text).toContain('read_file');
    expect(text).not.toContain('write_file');
    expect(s.runningSessions).toContain('sess_b');
  });
});
