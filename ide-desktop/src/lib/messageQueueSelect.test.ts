import { describe, expect, it } from 'vitest';
import { appReducer, initialState } from './state';
import { belongsToSession, canPromote, nextQueued, queueForSession } from './messageQueueSelect';
import type { AppState, QueuedMessage } from '../types';

/*
 * The queue's selection rules, and the two failures they caused.
 *
 * Both were reported as "the buttons don't work", and both are the kind of bug
 * a screenshot cannot distinguish from a dead control:
 *   - 立即 stayed enabled on the row that was already next, where promoting is
 *     a no-op by definition. The reducer returned the SAME state object, so not
 *     even a re-render happened — zero feedback for a real click.
 *   - A message queued while the bridge was `starting` was stored with an empty
 *     session id. Neither the display filter nor the drain matched it, so it
 *     was invisible in the list AND never sent: it sat in the queue forever.
 */

function queued(id: string, sessionId: string, text = id): QueuedMessage {
  return { id, sessionId, text, createdAt: Date.now() };
}

describe('belongsToSession', () => {
  it('matches its own session', () => {
    expect(belongsToSession(queued('a', 's1'), 's1')).toBe(true);
    expect(belongsToSession(queued('a', 's1'), 's2')).toBe(false);
  });

  it('treats a session-less entry as belonging to the active conversation', () => {
    // The orphan case. It used to match nothing at all, so it was invisible and
    // unsendable — the message simply never went out.
    expect(belongsToSession(queued('a', ''), 's1')).toBe(true);
    expect(belongsToSession(queued('a', ''), 's2')).toBe(true);
  });

  it('shows a session-less entry while no session is active', () => {
    // Before the bridge reports its id there is nothing to match against; the
    // message must still be visible or the user thinks their input was lost.
    expect(belongsToSession(queued('a', ''), null)).toBe(true);
    // A session-bound entry cannot be placed without knowing the session.
    expect(belongsToSession(queued('a', 's1'), null)).toBe(false);
  });
});

describe('nextQueued', () => {
  it('returns the first message for the session, not for another', () => {
    const queue = [queued('b1', 's2'), queued('a1', 's1'), queued('a2', 's1')];
    expect(nextQueued(queue, 's1')?.id).toBe('a1');
    expect(nextQueued(queue, 's2')?.id).toBe('b1');
  });

  it('finds an orphaned message so it can be sent', () => {
    // This is the fix: the drain used to look for a concrete id, never matched
    // the orphan, and left it stuck.
    expect(nextQueued([queued('orphan', '')], 's1')?.id).toBe('orphan');
  });

  it('returns undefined with no session to drain', () => {
    expect(nextQueued([queued('a', 's1')], null)).toBeUndefined();
  });

  it('returns undefined for an empty queue', () => {
    expect(nextQueued([], 's1')).toBeUndefined();
  });
});

describe('canPromote', () => {
  it('refuses the row that is already next', () => {
    // A single queued message is the reported case: 立即 has nothing to do.
    expect(canPromote([queued('a', 's1')], 'a')).toBe(false);
    expect(canPromote([queued('a', 's1'), queued('b', 's1')], 'a')).toBe(false);
  });

  it('allows any later row', () => {
    const visible = [queued('a', 's1'), queued('b', 's1'), queued('c', 's1')];
    expect(canPromote(visible, 'b')).toBe(true);
    expect(canPromote(visible, 'c')).toBe(true);
  });

  it('refuses an unknown id rather than reporting it promotable', () => {
    expect(canPromote([queued('a', 's1')], 'nope')).toBe(false);
  });

  it('judges by the visible list, so the answer matches what the user sees', () => {
    // Two conversations each have one message: both are first in their own
    // list, so 立即 is disabled on both — even though the second is not first
    // in the raw queue.
    const raw = [queued('a1', 's1'), queued('b1', 's2')];
    for (const session of ['s1', 's2']) {
      const visible = queueForSession(raw, session);
      expect(canPromote(visible, visible[0]!.id)).toBe(false);
    }
  });
});

describe('queue/adopt', () => {
  it('gives an orphaned entry a real owner', () => {
    let s: AppState = appReducer(initialState, { type: 'queue/add', message: queued('orphan', '') });
    s = appReducer(s, { type: 'queue/adopt', id: 'orphan', sessionId: 's1' });
    expect(s.messageQueue[0]!.sessionId).toBe('s1');
  });

  it('does not reassign an entry that already has a session', () => {
    // A message queued in one conversation must not be stolen by whichever
    // conversation happens to drain first.
    let s: AppState = appReducer(initialState, { type: 'queue/add', message: queued('a', 's1') });
    s = appReducer(s, { type: 'queue/adopt', id: 'a', sessionId: 's2' });
    expect(s.messageQueue[0]!.sessionId).toBe('s1');
  });
});
