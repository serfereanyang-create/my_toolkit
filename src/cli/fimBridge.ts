/**
 * fimBridge.ts — Standalone stdin/stdout bridge for FIM completions.
 * Launched by the Electron main process as a persistent child; receives
 * newline-delimited JSON requests and replies with newline-delimited JSON.
 *
 * Protocol:
 *   request:  { id, prefix, suffix, language?, filepath?, maxTokens? }
 *   response: { id, insert?, error?, latencyMs, truncated }
 */
import { createInterface } from 'node:readline';
import type { FimRequest, FimOptions } from '../providers/fim.js';
import { completeFIM } from '../providers/fim.js';

const opts: FimOptions = {
  provider:    (process.env.FIM_PROVIDER as FimOptions['provider']) ?? 'openai',
  apiKey:      process.env.FIM_API_KEY,
  baseUrl:     process.env.FIM_BASE_URL,
  model:       process.env.FIM_MODEL ?? 'deepseek-coder',
  maxTokens:   Number(process.env.FIM_MAX_TOKENS ?? 128),
  temperature: 0,
};

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let id = 'unknown';
  try {
    const msg = JSON.parse(trimmed) as { id: string } & FimRequest;
    id = msg.id;

    const result = await completeFIM(
      { prefix: msg.prefix, suffix: msg.suffix, language: msg.language, filepath: msg.filepath, maxTokens: msg.maxTokens },
      opts,
    );

    process.stdout.write(JSON.stringify({ id, insert: result.insert, latencyMs: result.latencyMs, truncated: result.truncated }) + '\n');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify({ id, error: message }) + '\n');
  }
});

rl.on('close', () => process.exit(0));

// Silently ignore unhandled rejections so one bad request doesn't kill the bridge.
process.on('unhandledRejection', () => {});
