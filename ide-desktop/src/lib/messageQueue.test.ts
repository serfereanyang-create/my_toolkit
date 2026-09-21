import { describe, expect, it } from 'vitest';
import { appReducer, initialState } from './state';
import type { QueuedMessage } from '../types';

/*
 * Messages submitted while a turn is running used to fail outright ("Agent turn
 * already running"), losing whatever the user had typed. They now queue and go
 * out one per finished turn, in submission order.
 */
function queued(id: string, text: string, sessionId = 'sess_a'): QueuedMessage {
  return { id, sessionId, text, createdAt: Date.now() };
}

describe('message queue', () => {
  it('appends submissions in order', () => {
    let s = appReducer(initialState, { type: 'queue/add', message: queued('q1', '第一条') });
    s = appReducer(s, { type: 'queue/add', message: queued('q2', '第二条') });
    expect(s.messageQueue.map((item) => item.text)).toEqual(['第一条', '第二条']);
  });

  it('removes one entry without disturbing the others', () => {
    let s = appReducer(initialState, { type: 'queue/add', message: queued('q1', 'A') });
    s = appReducer(s, { type: 'queue/add', message: queued('q2', 'B') });
    s = appReducer(s, { type: 'queue/add', message: queued('q3', 'C') });
    s = appReducer(s, { type: 'queue/remove', id: 'q2' });
    expect(s.messageQueue.map((item) => item.text)).toEqual(['A', 'C']);
  });

  it('edits an entry in place, keeping its position', () => {
    let s = appReducer(initialState, { type: 'queue/add', message: queued('q1', 'A') });
    s = appReducer(s, { type: 'queue/add', message: queued('q2', 'B') });
    s = appReducer(s, { type: 'queue/update', id: 'q1', text: 'A 改过' });
    expect(s.messageQueue.map((item) => item.text)).toEqual(['A 改过', 'B']);
  });

  it('promotes an entry to the front of its own session', () => {
    let s = appReducer(initialState, { type: 'queue/add', message: queued('q1', 'A') });
    s = appReducer(s, { type: 'queue/add', message: queued('q2', 'B') });
    s = appReducer(s, { type: 'queue/add', message: queued('q3', 'C') });
    s = appReducer(s, { type: 'queue/promote', id: 'q3' });
    expect(s.messageQueue.map((item) => item.text)).toEqual(['C', 'A', 'B']);
  });

  it('leaves other sessions\' entries in place when promoting', () => {
    // Two conversations queue independently; promoting in one must not reorder
    // the other's line.
    let s = appReducer(initialState, { type: 'queue/add', message: queued('a1', 'A1', 'sess_a') });
    s = appReducer(s, { type: 'queue/add', message: queued('b1', 'B1', 'sess_b') });
    s = appReducer(s, { type: 'queue/add', message: queued('a2', 'A2', 'sess_a') });
    s = appReducer(s, { type: 'queue/add', message: queued('b2', 'B2', 'sess_b') });
    s = appReducer(s, { type: 'queue/promote', id: 'a2' });

    const forA = s.messageQueue.filter((item) => item.sessionId === 'sess_a').map((item) => item.text);
    const forB = s.messageQueue.filter((item) => item.sessionId === 'sess_b').map((item) => item.text);
    expect(forA).toEqual(['A2', 'A1']);
    expect(forB).toEqual(['B1', 'B2']);
  });

  it('ignores a promote for an unknown id', () => {
    let s = appReducer(initialState, { type: 'queue/add', message: queued('q1', 'A') });
    const before = s.messageQueue;
    s = appReducer(s, { type: 'queue/promote', id: 'nope' });
    expect(s.messageQueue).toBe(before);
  });

  it('clears one session and leaves the rest', () => {
    let s = appReducer(initialState, { type: 'queue/add', message: queued('a1', 'A', 'sess_a') });
    s = appReducer(s, { type: 'queue/add', message: queued('b1', 'B', 'sess_b') });
    s = appReducer(s, { type: 'queue/clear', sessionId: 'sess_a' });
    expect(s.messageQueue.map((item) => item.text)).toEqual(['B']);
  });

  it('clears everything when no session is named', () => {
    let s = appReducer(initialState, { type: 'queue/add', message: queued('a1', 'A', 'sess_a') });
    s = appReducer(s, { type: 'queue/add', message: queued('b1', 'B', 'sess_b') });
    s = appReducer(s, { type: 'queue/clear' });
    expect(s.messageQueue).toEqual([]);
  });

  it('keeps queued messages across a session switch', () => {
    // The queue is per session, so switching views must not drop it.
    let s = appReducer(initialState, { type: 'queue/add', message: queued('a1', 'A', 'sess_a') });
    s = appReducer(s, { type: 'chat/load', sessionId: 'sess_b', chat: [] });
    expect(s.messageQueue).toHaveLength(1);
    expect(s.messageQueue[0].sessionId).toBe('sess_a');
  });

  it('keeps the files attached to a queued message', () => {
    let s = appReducer(initialState, {
      type: 'queue/add',
      message: { ...queued('q1', 'A'), files: [{ path: 'src/a.ts', name: 'a.ts', size: 10 }] },
    });
    expect(s.messageQueue[0].files?.[0].path).toBe('src/a.ts');
  });
});
