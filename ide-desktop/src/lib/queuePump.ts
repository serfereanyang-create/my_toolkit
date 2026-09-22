import type { QueuedMessage } from '../types';
import { nextQueued } from './messageQueueSelect';

/*
 * When the queue is allowed to send, and which message goes next.
 *
 * The bug this exists to fix was not in the queue's logic but in its TRIGGER.
 * `drainQueue` had exactly one call site — `turn_done` — so a message queued
 * while the agent was idle (or still starting) had no turn to wait for and no
 * turn to end. Nothing ever fired, and it hung above the composer forever. The
 * user reads that as "the buttons do nothing", because pressing 立即 only moves
 * the entry to the front of a line that is never served.
 *
 * So the decision is a pure function of explicit inputs, and the app calls it
 * from every moment the answer could have changed, instead of from the one
 * moment that happened to be implemented first.
 */

export type PumpDecision =
  /** Nothing to send: no message for this conversation. */
  | { action: 'idle' }
  /** A message is waiting but this conversation is busy; a later trigger sends it. */
  | { action: 'wait' }
  /** Send this message now. */
  | { action: 'send'; message: QueuedMessage };

export type PumpInput = {
  queue: QueuedMessage[];
  sessionId: string | null;
  /** The conversation already has a turn in flight. */
  sessionRunning: boolean;
  /** The bridge cannot accept a prompt at all (offline, starting). */
  bridgeReady: boolean;
  /** A send for this conversation is already in flight from pumpQueue. */
  sendInFlight: boolean;
  /**
   * This pump is being driven by the turn_done that just freed the session.
   *
   * The event that triggers it is dispatched in the same tick, so the state
   * read here still says the session is running — without this flag the pump
   * would decide 'wait' and never look again, which is how a BACKGROUND
   * conversation's queue would stall (the idle effect only serves the
   * conversation on screen).
   */
  justFinished?: boolean;
};

/**
 * Decide what the queue should do right now.
 *
 * Busy-ness is judged per conversation, not by the global `agentStatus`:
 * `agentStatus` describes the conversation on screen, so using it here would
 * let a busy BACKGROUND conversation block the on-screen queue, and would
 * consider the on-screen queue idle whenever the status happens to reflect a
 * different conversation.
 *
 * `sendInFlight` closes the window between writing a prompt to the bridge and
 * the CLI's `turn_start` arriving. Without it the effect that calls this can
 * re-fire on the queue change caused by the send itself and push a second
 * message — the order would still be right (the CLI queues internally) but the
 * desktop queue would empty instantly and stop showing the user what is
 * actually waiting.
 */
export function decideQueuePump(input: PumpInput): PumpDecision {
  const message = nextQueued(input.queue, input.sessionId);
  if (!message) return { action: 'idle' };
  if (input.sendInFlight || !input.bridgeReady) return { action: 'wait' };
  // `justFinished` overrides the stale running flag for the turn that just ended.
  if (input.sessionRunning && !input.justFinished) return { action: 'wait' };
  return { action: 'send', message };
}

/**
 * Which conversation a pump should serve.
 *
 * Prefers the event's session so a background conversation advances its own
 * line, and falls back to the one on screen — the precedence the original
 * turn_done handler used.
 */
export function pumpSessionId(eventSession: unknown, activeSessionId: string | null): string | null {
  if (typeof eventSession === 'string' && eventSession) return eventSession;
  return activeSessionId;
}
