import type { AppConfig } from '../config/types.js';
import type { Provider } from '../providers/types.js';
import type { CheckpointStore } from '../session/checkpoint.js';
import type { SessionRecord, SessionStore } from '../session/store.js';
import {
  copyTextToClipboard,
  defaultMessageActions,
  showOverlayMenu,
} from '../ui/overlay.js';

export type MessageActionsRuntime = {
  config: AppConfig;
  provider: Provider;
  sessions: SessionStore;
  session: SessionRecord;
  checkpoints?: CheckpointStore;
  /** Called when fork creates a new session — REPL should swap runtime.session. */
  onSessionForked?: (session: SessionRecord) => void;
};

/**
 * OpenCode-like Message Actions floating menu.
 * Returns a short status string for the transcript after the menu closes.
 */
export async function runMessageActions(runtime: MessageActionsRuntime): Promise<string> {
  const result = await showOverlayMenu({
    title: 'Message Actions',
    items: defaultMessageActions(),
    noColor: runtime.config.noColor,
  });

  if (result.status === 'cancelled') {
    return 'Actions cancelled.';
  }
  if (result.status === 'unavailable') {
    return result.reason;
  }

  switch (result.item.id) {
    case 'revert':
      return runRevert(runtime);
    case 'copy':
      return runCopy(runtime);
    case 'fork':
      return runFork(runtime);
    default:
      return `Unknown action: ${result.item.id}`;
  }
}

function runRevert(runtime: MessageActionsRuntime) {
  if (!runtime.checkpoints) {
    return 'No checkpoint store is available. File undo needs write checkpoints.';
  }
  return runtime.checkpoints.undoLast();
}

function runCopy(runtime: MessageActionsRuntime) {
  const text = latestCopyableText(runtime.session);
  if (!text) return 'No message text to copy yet.';
  const copied = copyTextToClipboard(text);
  return copied.ok ? copied.detail : `Copy failed: ${copied.detail}`;
}

async function runFork(runtime: MessageActionsRuntime) {
  // Carry the whole conversation, not just the last message: a fork seeded with
  // one message cannot answer a follow-up about anything decided earlier.
  const forked = await runtime.sessions.fork(runtime.session.id, {
    provider: runtime.provider.name,
    model: runtime.provider.model,
    workspaceRoot: runtime.config.workspaceRoot,
  });
  runtime.onSessionForked?.(forked);
  runtime.session = forked;
  const carried = forked.messages.length - 1;
  return `Forked new session: ${forked.id} (carried ${carried} message${carried === 1 ? '' : 's'})`;
}

function latestCopyableText(session: SessionRecord) {
  if (session.finalAnswers.length > 0) {
    return session.finalAnswers[session.finalAnswers.length - 1] ?? '';
  }
  for (let i = session.messages.length - 1; i >= 0; i -= 1) {
    const message = session.messages[i];
    if (message && (message.role === 'assistant' || message.role === 'user') && message.content.trim()) {
      return message.content;
    }
  }
  return '';
}
