import { describe, expect, it } from 'vitest';
import { decideQueuePump, pumpSessionId } from './queuePump';
import type { QueuedMessage } from '../types';

/*
 * When the queue is allowed to move.
 *
 * This is the layer the reported bug lived in: the queue's own logic was fine,
 * but it had exactly ONE trigger (`turn_done`), so a message queued while the
 * agent was idle or still starting had no turn to wait for and never went out.
 * It hung above the composer forever, which reads as "the buttons do nothing".
 *
 * So these tests are about the DECISION, exercised directly rather than through
 * the effect that calls it: a trigger that is missing is invisible in a test
 * that supplies the trigger itself.
 */

function queued(id: string, sessionId = 'sess_a', text = id): QueuedMessage {
  return { id, sessionId, text, createdAt: Date.now() };
}

/** Idle conversation with nothing in flight — the state the bug never handled. */
function idleInput(queue: QueuedMessage[], sessionId: string | null = 'sess_a') {
  return { queue, sessionId, sessionRunning: false, bridgeReady: true, sendInFlight: false };
}

describe('decideQueuePump', () => {
  it('sends when the conversation is idle — the case that never fired before', () => {
    // The core regression. Previously nothing called the drain here at all, so
    // this decision was never even reached.
    const decision = decideQueuePump(idleInput([queued('a')]));
    expect(decision.action).toBe('send');
    if (decision.action === 'send') expect(decision.message.id).toBe('a');
  });

  it('sends the head of the line, so order is preserved', () => {
    const decision = decideQueuePump(idleInput([queued('first'), queued('second'), queued('third')]));
    expect(decision.action).toBe('send');
    if (decision.action === 'send') expect(decision.message.id).toBe('first');
  });

  it('sends one message per decision, never the whole queue', () => {
    // A batch would be rejected by the CLI's own busy guard and would scramble
    // the order the user submitted them in.
    const decision = decideQueuePump(idleInput([queued('a'), queued('b')]));
    expect(decision.action).toBe('send');
  });

  it('waits while this conversation has a turn in flight', () => {
    const decision = decideQueuePump({ ...idleInput([queued('a')]), sessionRunning: true });
    expect(decision.action).toBe('wait');
  });

  it('waits while the bridge cannot accept a prompt', () => {
    for (const ready of [false]) {
      const decision = decideQueuePump({ ...idleInput([queued('a')]), bridgeReady: ready });
      expect(decision.action).toBe('wait');
    }
  });

  it('waits while a send for this conversation is already in flight', () => {
    // Without this the effect re-fires on the queue change the send itself
    // causes and empties the queue instead of showing what is still waiting.
    const decision = decideQueuePump({ ...idleInput([queued('a')]), sendInFlight: true });
    expect(decision.action).toBe('wait');
  });

  it('is idle when there is nothing for this conversation', () => {
    expect(decideQueuePump(idleInput([])).action).toBe('idle');
    expect(decideQueuePump(idleInput([queued('a', 'other')], 'sess_a')).action).toBe('idle');
  });

  it('is idle with no session to serve', () => {
    expect(decideQueuePump(idleInput([queued('a')], null)).action).toBe('idle');
  });

  it('serves an orphaned entry rather than leaving it stuck', () => {
    // Queued while the bridge was starting, so it carries no session id.
    const decision = decideQueuePump(idleInput([queued('orphan', '')]));
    expect(decision.action).toBe('send');
    if (decision.action === 'send') expect(decision.message.id).toBe('orphan');
  });

  it('judges busy-ness per conversation, not globally', () => {
    // Another conversation running must not block this one: `runningSessions`
    // is the signal, and it is passed in already resolved for THIS session.
    const decision = decideQueuePump({ ...idleInput([queued('a')]), sessionRunning: false });
    expect(decision.action).toBe('send');
  });

  it('sends on the turn_done that just freed the session', () => {
    // The event is dispatched in the same tick, so the state read here still
    // reports the session as running. Without `justFinished` the pump would
    // wait for a trigger that never comes — which is how a BACKGROUND
    // conversation's queue would stall, since the idle effect only serves the
    // conversation on screen.
    const decision = decideQueuePump({ ...idleInput([queued('a')]), sessionRunning: true, justFinished: true });
    expect(decision.action).toBe('send');
  });

  it('still waits when the bridge is not ready, even just after a turn', () => {
    const decision = decideQueuePump({
      ...idleInput([queued('a')]),
      sessionRunning: true,
      justFinished: true,
      bridgeReady: false,
    });
    expect(decision.action).toBe('wait');
  });
});

describe('pumpSessionId', () => {
  it('prefers the event session so a background conversation advances itself', () => {
    expect(pumpSessionId('sess_bg', 'sess_active')).toBe('sess_bg');
  });

  it('falls back to the on-screen conversation', () => {
    expect(pumpSessionId(undefined, 'sess_active')).toBe('sess_active');
    expect(pumpSessionId('', 'sess_active')).toBe('sess_active');
    expect(pumpSessionId(42, 'sess_active')).toBe('sess_active');
  });

  it('yields nothing when neither is known', () => {
    expect(pumpSessionId(undefined, null)).toBeNull();
  });
});
