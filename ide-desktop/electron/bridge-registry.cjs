/*
 * Bridge registry: one CLI child per session.
 *
 * This used to be a single `bridge` variable in main.cjs, and starting a session
 * disposed the previous child — so opening another conversation killed the task
 * that was running. The registry makes the mapping explicit and testable.
 *
 * A bridge's session id is only known once the CLI announces it in
 * `bridge_ready` (a resumed session keeps its id; a fresh one gets a new id), so
 * a bridge lives in `pending` until then.
 */

class BridgeRegistry {
  constructor() {
    this.byId = new Map();
    this.pending = new Set();
  }

  /** A bridge that has not announced its session id yet. */
  addPending(bridge) {
    // An already adopted bridge must not also remain pending: bulk shutdown
    // would otherwise dispose it twice and a second ready could rebind it.
    if (this.sessionOf(bridge) === undefined) this.pending.add(bridge);
    return bridge;
  }

  /**
   * Bind a pending bridge to the session it announced.
   *
   * Returns false when the bridge was not pending — a duplicate bridge_ready, or
   * a bridge that was already disposed. Rebinding then would let a dead child
   * replace a live one.
   */
  adopt(bridge, sessionId) {
    if (sessionId === undefined || sessionId === null || String(sessionId).trim() === '') return false;
    if (!this.pending.has(bridge)) return false;
    const id = String(sessionId);
    const existing = this.byId.get(id);
    // Never let a pending/late child silently evict a live owner of this id.
    if (existing && existing !== bridge) return false;
    this.pending.delete(bridge);
    this.byId.set(id, bridge);
    return true;
  }

  /**
   * The bridge for a session.
   *
   * With no id, returns the sole live bridge — the pre-existing single-session
   * behaviour, kept so a caller that does not name a session still works. With
   * several live bridges that is ambiguous, so it returns undefined rather than
   * guessing and addressing the wrong conversation.
   */
  get(sessionId) {
    if (sessionId) return this.byId.get(String(sessionId));
    if (this.byId.size === 1) return [...this.byId.values()][0];
    return undefined;
  }

  /** The session a bridge belongs to, or undefined when it is still pending. */
  sessionOf(bridge) {
    for (const [id, candidate] of this.byId) {
      if (candidate === bridge) return id;
    }
    return undefined;
  }

  /** Whether this session already has a bridge (used to reuse instead of restart). */
  has(sessionId) {
    return this.byId.has(String(sessionId));
  }

  /** Forget a session's bridge. Does not dispose it. */
  remove(sessionId) {
    const id = String(sessionId);
    const bridge = this.byId.get(id);
    this.byId.delete(id);
    return bridge;
  }

  /** Forget a bridge because it went offline. Does not dispose it. */
  removeBridge(bridge) {
    this.pending.delete(bridge);
    const id = this.sessionOf(bridge);
    if (id !== undefined) this.byId.delete(id);
    return id;
  }

  /** Every live bridge, for a bulk dispose. */
  all() {
    return [...new Set([...this.byId.values(), ...this.pending])];
  }

  clear() {
    this.byId.clear();
    this.pending.clear();
  }

  get size() {
    return this.byId.size;
  }
}

module.exports = { BridgeRegistry };
