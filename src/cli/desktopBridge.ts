import { createInterface } from 'node:readline';
import type { AgentRuntime } from '../agent/agent.js';
import { runPromptMode } from './repl.js';
import type { ApprovalDecision, ApprovalRequest } from '../tools/types.js';

type BridgeCommand =
  | { type: 'user_message'; text: string; sessionId?: string }
  | { type: 'approval_response'; requestId: string; decision: 'allow_once' | 'allow_session' | 'deny' }
  | { type: 'cancel'; sessionId?: string }
  | { type: 'shutdown' }
  | { type: 'ping' };

type PendingApproval = {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
};

/**
 * Run the CLI in desktop bridge mode.
 *
 * Wire protocol (both directions are newline-delimited JSON on stdin/stdout):
 *
 *   stdin  commands:  user_message, approval_response, cancel, shutdown, ping
 *   stdout events:    bridge_ready, turn_start, assistant_delta, assistant,
 *                     tool_start, tool_result, approval_needed, turn_done,
 *                     pong, cancel_ack, error, and all existing TerminalUI
 *                     `--json` events (info/final/model_start/model_end/...).
 *
 * The runner installs a `toolConfirm` on the runtime that emits
 * `approval_needed` events and blocks until the desktop shell posts a
 * matching `approval_response`. It reuses `runPromptMode` so slash commands
 * behave identically to the CLI REPL.
 */
export async function runDesktopBridge(runtime: AgentRuntime) {
  const broker = new DesktopApprovalBroker(runtime.session.id);
  runtime.toolConfirm = broker.confirm.bind(broker);

  emit({
    type: 'bridge_ready',
    sessionId: runtime.session.id,
    provider: runtime.provider.name,
    model: runtime.provider.model,
    approval: runtime.config.approval,
    workspaceRoot: runtime.config.workspaceRoot,
  });

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let busy = false;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let command: BridgeCommand;
    try {
      command = JSON.parse(trimmed) as BridgeCommand;
    } catch (error) {
      emit({ type: 'error', sessionId: runtime.session.id, message: `Invalid bridge JSON: ${errorMessage(error)}` });
      continue;
    }

    if (command.type === 'shutdown') break;
    if (command.type === 'ping') {
      emit({ type: 'pong', sessionId: runtime.session.id });
      continue;
    }
    if (command.type === 'approval_response') {
      broker.resolve(command.requestId, command.decision);
      continue;
    }
    if (command.type === 'cancel') {
      // Cooperative cancel is not yet supported by the agent loop; the desktop
      // should terminate and respawn the child to interrupt an in-flight turn.
      emit({
        type: 'cancel_ack',
        sessionId: runtime.session.id,
        note: 'Desktop should terminate and restart the child process for active turns.',
      });
      continue;
    }
    if (command.type === 'user_message') {
      if (busy) {
        emit({ type: 'error', sessionId: runtime.session.id, message: 'Agent turn already running' });
        continue;
      }
      busy = true;
      emit({ type: 'turn_start', sessionId: runtime.session.id, prompt: command.text });
      try {
        const result = await runPromptMode(runtime, command.text);
        emit({
          type: 'turn_done',
          sessionId: runtime.session.id,
          status: result.ok ? 'ok' : 'error',
          reason: result.reason,
        });
      } catch (error) {
        emit({ type: 'error', sessionId: runtime.session.id, message: errorMessage(error) });
        emit({ type: 'turn_done', sessionId: runtime.session.id, status: 'error' });
      } finally {
        busy = false;
      }
    }
  }
}

/**
 * Desktop-side approval broker. Emits `approval_needed` events and awaits
 * matching `approval_response` commands. `allow_session` decisions are cached
 * for the lifetime of the bridge process so repeated write tools to the same
 * name skip re-prompting.
 */
class DesktopApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly sessionAllows = new Set<string>();
  private sequence = 0;

  constructor(private readonly sessionId: string) {}

  async confirm(message: string, request?: ApprovalRequest): Promise<ApprovalDecision> {
    const approval: ApprovalRequest = request ?? {
      tool: 'unknown',
      risk: 'write',
      input: {},
      reason: 'interactive approval required',
      message,
    };
    const allowKey = `${approval.risk}:${approval.tool}`;
    if (approval.risk === 'write' && this.sessionAllows.has(allowKey)) return true;

    this.sequence += 1;
    const requestId = `approval_${Date.now()}_${this.sequence}`;
    emit({
      type: 'approval_needed',
      sessionId: this.sessionId,
      requestId,
      tool: approval.tool,
      risk: approval.risk,
      reason: approval.reason,
      message: approval.message,
      input: approval.input,
    });

    return await new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(requestId, {
        request: approval,
        resolve: (decision) => {
          if (decision === 'allow_session' && approval.risk === 'write') this.sessionAllows.add(allowKey);
          resolve(decision);
        },
      });
    });
  }

  resolve(requestId: string, decision: 'allow_once' | 'allow_session' | 'deny') {
    const pending = this.pending.get(requestId);
    if (!pending) {
      emit({ type: 'error', sessionId: this.sessionId, message: `Unknown approval request: ${requestId}` });
      return;
    }
    this.pending.delete(requestId);
    if (decision === 'deny') pending.resolve(false);
    else if (decision === 'allow_once') pending.resolve(true);
    else pending.resolve('allow_session');
  }
}

function emit(event: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
