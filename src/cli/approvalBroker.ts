import type { ApprovalDecision, ApprovalRequest } from '../tools/types.js';
import { isDestructiveApprovalRequest } from '../safety/policy.js';

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
 * Tools whose write reaches a path the approval message never printed.
 *
 * Every write tool the registry can produce names its target in `input.path`,
 * or — for the two-target tools — in `input.from`/`input.to`/`input.output`.
 * `copy_file`, `rename_file`, `pdf_convert` and `zip_extract` carry the
 * destination only in one of those, so a key that sees just `path` degenerated
 * to `risk:tool` and one "don't ask again" covered writes anywhere on the disk
 * the scope allows. Brokers import the tool registry here, so this is a
 * name-based table, not an introspection: a new two-path tool must be added or
 * its key silently loses the destination.
 */
const SOURCE_PATH_TOOLS = new Set(['copy_file', 'rename_file', 'pdf_convert', 'zip_extract', 'zip_create']);

/** Directory component of a path, in the broker's `/`-normalised form. */
function dirOf(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, '/');
  return normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';
}

/** Longest-basename component, so `src/a.ts` → `a.ts` (also on POSIX). */
function baseOf(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

/**
 * Desktop-side approval broker. Emits `approval_needed` events and awaits
 * matching `approval_response` decisions.
 *
 * Lifecycle guarantees:
 * - An unanswered approval is denied after `timeoutMs` (spec: dismissed/timed
 *   out approvals must NOT leave the turn hanging forever).
 * - `denyAll()` resolves every pending approval as deny; the bridge calls it
 *   on EOF/shutdown/cancel so an in-flight turn can always finish. It does NOT
 *   suspend future approvals: a cancel is followed by a fresh user turn whose
 *   prompts are legitimate again (the host broker and the guard broker both
 *   resume at turn start; theirs would otherwise swallow every later prompt).
 * - `allow_session` is cached per (risk, tool, directory) for write tools so
 *   repeated writes to the same directory skip re-prompting, while writes to
 *   other directories still require approval. The key is widened to
 *   `…:dir:basename:bytes` for a file whose bytes are already known, because a
 *   broad grant on `src/config.ts` that silently covers a later
 *   `src/id_rsa`-sized write to the same folder with different names is a
 *   different promise from the one the user saw. Shell/network are never
 *   cached.
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

  /**
   * Directory-scoped cache key; falls back to tool-only when no path exists.
   *
   * A `content` string adds its byte length (see `cacheable`); path-less write
   * tools (git_commit, git_init) keep the tool-only key they always had.
   */
  private allowKey(request: ApprovalRequest): string {
    const input = request.input ?? {};
    const rawPath = typeof input.path === 'string' && input.path
      ? input.path
      : (SOURCE_PATH_TOOLS.has(request.tool) && typeof input.to === 'string' && input.to
        ? input.to
        : (SOURCE_PATH_TOOLS.has(request.tool) && typeof input.output === 'string' ? input.output : ''));
    const dir = dirOf(rawPath);
    const scope = dir ? `${request.risk}:${request.tool}:${dir}` : `${request.risk}:${request.tool}`;
    if (!rawPath) return scope;
    const bytes = new Map<string, number>([
      ['write_file', typeof input.content === 'string' ? Buffer.byteLength(input.content, 'utf8') : -1],
      ['append_file', typeof input.content === 'string' ? Buffer.byteLength(input.content, 'utf8') : -1],
      ['apply_patch', typeof input.newText === 'string' ? Buffer.byteLength(input.newText, 'utf8') : -1],
      ['edit_lines', typeof input.text === 'string' ? Buffer.byteLength(input.text, 'utf8') : -1],
    ]);
    const size = bytes.get(request.tool);
    const name = baseOf(rawPath);
    return size === undefined ? `${scope}:${name}` : `${scope}:${name}:${size}`;
  }

  /**
   * Destructive calls are exempt from the session cache in both directions: an
   * earlier "allow for this session" must not answer one, and answering one
   * must not create an entry. The key alone could not carry that safety — it is
   * `risk:tool:dir`, `git_restore`'s targets live in `input.paths` rather than
   * `input.path` (so the dir is always empty and one grant covers the whole
   * workspace), and "the user must see the exact targets before the work is
   * destroyed" is not a promise a cached yes can keep.
   *
   * Shell and network are never cached (the old rule, unchanged): the key has
   * no command component, so one "allow this session" for `npm test` would
   * answer every later command, including `npm publish`.
   */
  private cacheable(request: ApprovalRequest): boolean {
    return request.risk === 'write' && !isDestructiveApprovalRequest(request);
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
    if (this.cacheable(approval) && this.sessionAllows.has(allowKey)) return true;

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
          if (decision === 'allow_session' && this.cacheable(approval)) this.sessionAllows.add(allowKey);
          resolve(decision);
        },
      });
    });
  }

  resolve(requestId: string, decision: 'allow_once' | 'allow_session' | 'deny') {
    // Runtime whitelist as well as the static type: the bridge validates its own
    // input, but a mistyped string (`'DENY'`, `'allow'`) previously fell through
    // the if/else chain and became `allow_session` — i.e. the worst reading of an
    // ambiguous answer. Refuse anything outside the protocol instead of guessing.
    if (decision !== 'allow_once' && decision !== 'allow_session' && decision !== 'deny') {
      this.emit({
        type: 'error',
        sessionId: this.sessionId,
        message: `Invalid approval decision: ${JSON.stringify(decision)}（请求 ${requestId} 保持待定）`,
      });
      return;
    }
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
