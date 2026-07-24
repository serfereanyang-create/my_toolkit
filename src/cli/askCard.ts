import type { Interface as ReadlineInterface } from 'node:readline/promises';
import { assertUserTextWithinLimit } from './limits.js';
import type { ReadTurnResult } from './input.js';
import { readMultilineContinuation, readUserTurn } from './input.js';
import { chatPromptLabel } from '../ui/home.js';

export type AskCardOptions = {
  model: string;
  baseUrl?: string;
  providerName?: string;
  noColor?: boolean;
  placeholder?: string;
  agentLabel?: string;
  mode?: 'home' | 'dock';
  /** @deprecated unused — kept for call-site compatibility */
  session?: unknown;
};

/**
 * Interactive input without per-keystroke full-screen paints.
 * Those stacked ghost logos/cards on Windows Terminal and destroyed scrollback.
 *
 * - Uses normal readline (history stays in scrollback, can 往前翻)
 * - OpenCode-like left accent prompt: │
 * - Multiline """ / /paste still work
 */
export async function readAskCardTurn(
  options: AskCardOptions & { rl?: ReadlineInterface },
): Promise<ReadTurnResult | null> {
  // Prefer classic readline path always for stability.
  if (!options.rl) {
    return null;
  }
  const prompt = chatPromptLabel({ noColor: options.noColor });
  const turn = await readUserTurn(options.rl, prompt);
  if (!turn) return null;
  if (!turn.multiline) {
    const marker = turn.text.trim();
    if (marker === '"""' || marker === '/paste') {
      return readMultilineContinuation(options.rl, marker === '/paste' ? 'paste' : 'triple');
    }
  }
  if (turn.text.trim()) {
    assertUserTextWithinLimit(turn.text);
  }
  return turn;
}

/** Card fragment for tests / static previews (not used for live keystroke paint). */
export function renderAskCardFrame(options: {
  text: string;
  model: string;
  baseUrl?: string;
  providerName?: string;
  noColor?: boolean;
  placeholder: string;
  agentLabel: string;
  mode?: 'home' | 'dock';
}): string {
  const noColor = options.noColor ?? false;
  const reset = noColor ? '' : '\u001b[0m';
  const dim = noColor ? '' : '\u001b[2m';
  const bold = noColor ? '' : '\u001b[1m';
  const blue = noColor ? '' : '\u001b[34m';
  const white = noColor ? '' : '\u001b[37m';
  const gray = noColor ? '' : '\u001b[90m';
  const boxWidth = 70;
  const inner = boxWidth - 4;
  const model = options.model.includes('/') ? options.model.split('/').pop()! : options.model;
  let host = '';
  try {
    host = options.baseUrl ? new URL(options.baseUrl).host : '';
  } catch {
    host = '';
  }
  const display = (options.text || options.placeholder).slice(0, inner).padEnd(inner, ' ');
  const status = `${options.agentLabel} · ${model}${host ? ` ${host}` : ''}`.slice(0, inner).padEnd(inner, ' ');
  const lines = [
    `${blue}┌${gray}${'─'.repeat(boxWidth - 2)}┐${reset}`,
    `${blue}│${reset} ${options.text ? white : gray}${display}${reset}`,
    `${blue}│${reset} ${blue}${bold}${options.agentLabel}${reset} ${dim}·${reset} ${white}${model}${reset}${host ? ` ${dim}${host}${reset}` : ''}${' '.repeat(Math.max(0, inner - status.trimEnd().length))}`,
    `${blue}└${gray}${'─'.repeat(boxWidth - 2)}┘${reset}`,
    '',
    `${dim}/help commands   enter submit   esc clear${reset}`,
  ];
  return `${lines.join('\n')}\n`;
}
