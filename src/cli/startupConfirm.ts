import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { AppConfig } from '../config/types.js';
import type { Provider } from '../providers/types.js';

/**
 * In interactive TTY REPL mode, pause after the banner and ask the user to
 * confirm the active provider/model before accepting any requests.
 *
 * Returns false if the user types "n" or "no" — caller should exit.
 * Skips (returns true immediately) for --prompt / --ci / --json / --quiet /
 * --no-banner / --desktop-bridge and non-TTY environments.
 */
export async function confirmProviderStart(
  config: AppConfig,
  provider: Provider,
): Promise<boolean> {
  // Skip in every non-interactive mode.
  if (
    config.prompt !== undefined ||
    config.ci ||
    config.json ||
    config.quiet ||
    config.noBanner ||
    (config as { desktopBridge?: boolean }).desktopBridge ||
    !process.stdout.isTTY
  ) {
    return true;
  }

  const dim   = config.noColor ? '' : '\u001b[2m';
  const white = config.noColor ? '' : '\u001b[37m';
  const cyan  = config.noColor ? '' : '\u001b[36m';
  const reset = config.noColor ? '' : '\u001b[0m';

  const baseDisplay = config.baseUrl ? `  ${dim}${shortHost(config.baseUrl)}${reset}` : '';
  const providerLine =
    `  ${dim}provider:${reset} ${white}${provider.name}${reset}` +
    `  ${dim}model:${reset} ${cyan}${provider.model}${reset}` +
    baseDisplay;
  const hintLine = `  ${dim}按 Enter 继续，输入 n 退出 …${reset} `;

  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`${providerLine}\n${hintLine}`)).trim().toLowerCase();
    return answer !== 'n' && answer !== 'no';
  } finally {
    rl.close();
  }
}

function shortHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
