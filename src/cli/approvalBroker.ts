import type { ApprovalDecision, ApprovalRequest } from '../tools/types.js';

export type PendingApproval = {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

export type DesktopApprovalBrokerOptions = {
  /** Event sink (bridge `emit`). Injected so the broker stays unit-testable. */
  emit?: (event: Record<string, unknown>) => void;
  /** How long an unanswered approval waits before it is denied. */
  timeoutMs?: number;
};

export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

/**
 * Desktop-side approval broker. Emits `approval_needed` events and awaits
 * matching `approval_response` decisions.
 *
 * Lifecycle guarantees:
 * - An unanswered approval is denied after `timeoutMs` (spec: dismissed/timed
 *   out approvals must NOT leave the turn hanging forever).
 * - `denyAll()` resolves every pending approval as deny; the bridge calls it
 *   on EOF/shutdown/cancel so an in-flight turn can always finish.
 * - `allow_session` is cached per (risk, tool, directory) for write tools so
 *   repeated writes to the same directory skip re-prompting, while writes to
 *   other directories still require approval. Shell/network are never cached.
 */
export class DesktopApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly sessionAllows = new Set<string>();
  private readonly emit: (event: Record<string, unknown>) => void;
  private readonly timeoutMs: number;
  private sequence = 0;
  private lastId = '';

  constructor(
    private readonly sessionId: string,
    options: DesktopApprovalBrokerOptions = {},
  ) {
    this.emit = options.emit ?? (() => {});
    this.timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  }

  /** Directory-scoped cache key; falls back to tool-only when no path exists. */
  private allowKey(request: ApprovalRequest): string {
    const rawPath = request.input && typeof request.input.path === 'string' ? request.input.path : '';
    const normalized = rawPath.replace(/\\/g, '/');
    const dir = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';
    return dir ? `${request.risk}:${request.tool}:${dir}` : `${request.risk}:${request.tool}`;
  }

  async confirm(message: string, request?: ApprovalRequest): Promise<ApprovalDecision> {
    const approval: ApprovalRequest = request ?? {
      tool: 'unknown',
      risk: 'write',
      input: {},
      reason: 'interactive approval required',
      message,
    };
    const allowKey = this.allowKey(approval);
    if (approval.risk === 'write' && this.sessionAllows.has(allowKey)) return true;

    this.sequence += 1;
    const requestId = `approval_${Date.now()}_${this.sequence}`;
    this.lastId = requestId;
    this.emit({
      type: 'approval_needed',
      sessionId: this.sessionId,
      requestId,
      tool: approval.tool,
      risk: approval.risk,
      reason: approval.reason,
      message: approval.message,
      input: approval.input,
      ...(approval.diff ? { diff: approval.diff } : {}),
    });

    return await new Promise<ApprovalDecision>((resolve) => {
      const timer = this.timeoutMs > 0
        ? setTimeout(() => {
          // Dismissed/timed-out approvals deny per the desktop design spec;
          // leaving the promise pending would hang the whole turn.
          if (!this.pending.has(requestId)) return;
          const pending = this.pending.get(requestId);
          this.pending.delete(requestId);
          this.emit({
            type: 'info',
            sessionId: this.sessionId,
            message: `审批超时（${Math.round(this.timeoutMs / 1000)}s 无人应答），已按拒绝处理：${approval.tool}`,
          });
          pending?.resolve(false);
        }, this.timeoutMs)
        : undefined;
      if (timer && typeof timer.unref === 'function') timer.unref();
      this.pending.set(requestId, {
        request: approval,
        timer,
        resolve: (decision) => {
          if (timer) clearTimeout(timer);
          if (decision === 'allow_session' && approval.risk === 'write') this.sessionAllows.add(allowKey);
          resolve(decision);
        },
      });
    });
  }

  resolve(requestId: string, decision: 'allow_once' | 'allow_session' | 'deny') {
    const pending = this.pending.get(requestId);
    if (!pending) {
      this.emit({ type: 'error', sessionId: this.sessionId, message: `Unknown approval request: ${requestId}` });
      return;
    }
    this.pending.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    if (decision === 'deny') pending.resolve(false);
    else if (decision === 'allow_once') pending.resolve(true);
    else pending.resolve('allow_session');
  }

  /** Deny every pending approval (EOF/shutdown/cancel) so turns can settle. */
  denyAll(reason: string) {
    const entries = [...this.pending.values()];
    if (entries.length === 0) return;
    this.pending.clear();
    this.emit({
      type: 'info',
      sessionId: this.sessionId,
      message: `${reason}：${entries.length} 个待审批请求已按拒绝处理`,
    });
    for (const pending of entries) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve(false);
    }
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Request id of the most recent approval_needed (test convenience). */
  lastRequestId(): string {
    return this.lastId;
  }
}
