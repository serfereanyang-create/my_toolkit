import type { QueuedMessage } from '../types';

/*
 * Which queued message belongs to which conversation, and which one goes next.
 *
 * Pure functions because both questions have cases that are invisible on screen
 * and surface only as "the button does nothing" or "the message never sends" —
 * the two symptoms that are hardest to attribute by looking at the UI. Keeping
 * the rule in one place also stops the display filter and the drain from
 * disagreeing about which messages a session owns, which is exactly how the
 * orphan bug below happened.
 */

/**
 * Whether a queue entry belongs to a conversation.
 *
 * An entry with no session id (`''`) is treated as belonging to whichever
 * conversation is active. That case is real: `submitPrompt` records
 * `activeSessionId ?? ''`, and the id is still null while the bridge is
 * `starting` — so a message submitted in that window is stored with an empty
 * session. It used to be matched by neither the display filter nor the drain
 * (both compared against a concrete id), so it was invisible while the bridge
 * was up and never sent: stuck in the queue forever.
 */
export function belongsToSession(item: QueuedMessage, sessionId: string | null): boolean {
  if (!item.sessionId) return true;
  if (!sessionId) return item.sessionId === '';
  return item.sessionId === sessionId;
}

/** The queue as the composer shows it: this conversation's messages, in order. */
export function queueForSession(queue: QueuedMessage[], sessionId: string | null): QueuedMessage[] {
  return queue.filter((item) => belongsToSession(item, sessionId));
}

/** The next message to send for a conversation, or undefined when there is none. */
export function nextQueued(queue: QueuedMessage[], sessionId: string | null): QueuedMessage | undefined {
  return queueForSession(queue, sessionId)[0];
}

/**
 * Whether promoting this entry would change anything.
 *
 * False when the entry is already first for its conversation — the normal case
 * with a single queued message. The button used to stay enabled there and
 * silently no-op (the reducer returned the same state object, so not even a
 * re-render happened), which reads as a broken button rather than as "there is
 * nothing to jump ahead of".
 *
 * Takes the already-visible list, so the caller cannot pass a list filtered
 * differently from the one on screen and get a different answer than the user
 * sees.
 */
export function canPromote(visible: QueuedMessage[], id: string): boolean {
  return visible.findIndex((item) => item.id === id) > 0;
}
