/**
 * fim.ts — Fill-in-Middle (FIM) completion request path.
 * Called by the FIM bridge to generate inline code completions.
 */
import type { ProviderName } from './types.js';

export type FimOptions = {
  provider: ProviderName | 'custom';
  apiKey?: string;
  baseUrl?: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  stopTokens?: string[];
};

export type FimRequest = {
  prefix: string;
  suffix: string;
  language?: string;
  filepath?: string;
  maxTokens?: number;
};

export type FimResult = {
  insert: string;
  model: string;
  latencyMs: number;
  truncated: boolean;
};

const DEFAULT_MAX_TOKENS = 128;
const DEFAULT_TIMEOUT_MS = 8000;

/** Default stop tokens that mark end of a single completion chunk. */
const FIM_STOP = ['<|fim_middle|>', '<|endoftext|>', '\n\n\n', '</s>'];

/**
 * Send a FIM request to the configured provider endpoint.
 *
 * OpenAI-compatible providers (DeepSeek, Codestral, Qwen-Coder, etc.) support
 * the legacy `/completions` endpoint with `prompt` + `suffix` which is the
 * standard FIM wire format.
 *
 * Anthropic does not have a native FIM endpoint; we degrade gracefully to a
 * short chat-completion asking for inline continuation.
 */
export async function completeFIM(req: FimRequest, opts: FimOptions): Promise<FimResult> {
  const t0 = Date.now();
  const maxTokens = req.maxTokens ?? opts.maxTokens ?? DEFAULT_MAX_TOKENS;

  if (opts.provider === 'anthropic') {
    return completeFIMAnthropic(req, opts, maxTokens, t0);
  }

  // OpenAI-compatible: use /completions with prefix + suffix
  return completeFIMOpenAI(req, opts, maxTokens, t0);
}

async function completeFIMOpenAI(
  req: FimRequest,
  opts: FimOptions,
  maxTokens: number,
  t0: number,
): Promise<FimResult> {
  const base = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const url  = `${base}/completions`;

  const body: Record<string, unknown> = {
    model:       opts.model,
    prompt:      req.prefix,
    suffix:      req.suffix,
    max_tokens:  maxTokens,
    temperature: opts.temperature ?? 0,
    stop:        opts.stopTokens ?? FIM_STOP,
    stream:      false,
  };

  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${opts.apiKey ?? ''}`,
    },
    body: JSON.stringify(body),
  }, DEFAULT_TIMEOUT_MS);

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`FIM request failed: ${resp.status} ${text.slice(0, 200)}`);
  }

  const json = await resp.json() as {
    choices?: Array<{ text?: string; finish_reason?: string }>;
    model?: string;
  };
  const choice = json.choices?.[0];
  const insert = cleanCompletion(choice?.text ?? '');

  return {
    insert,
    model: json.model ?? opts.model,
    latencyMs: Date.now() - t0,
    truncated: choice?.finish_reason === 'length',
  };
}

async function completeFIMAnthropic(
  req: FimRequest,
  opts: FimOptions,
  maxTokens: number,
  t0: number,
): Promise<FimResult> {
  const base = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
  const url  = `${base}/v1/messages`;

  // Degrade to a chat prompt that asks for inline continuation
  const prompt =
    `Continue the code inline. Output ONLY the inserted text, no commentary.\n` +
    `<context_before>\n${req.prefix.slice(-600)}</context_before>\n` +
    `<context_after>\n${req.suffix.slice(0, 300)}</context_after>\n` +
    `Insert exactly what goes between the two context blocks.`;

  const body = {
    model:      opts.model,
    max_tokens: maxTokens,
    messages:   [{ role: 'user', content: prompt }],
  };

  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-api-key':       opts.apiKey ?? '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  }, DEFAULT_TIMEOUT_MS);

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`FIM (Anthropic fallback) failed: ${resp.status} ${text.slice(0, 200)}`);
  }

  const json = await resp.json() as {
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string;
    model?: string;
  };
  const insert = cleanCompletion(
    json.content?.find((b) => b.type === 'text')?.text ?? '',
  );

  return {
    insert,
    model: json.model ?? opts.model,
    latencyMs: Date.now() - t0,
    truncated: json.stop_reason === 'max_tokens',
  };
}

/** Strip leading newline the model sometimes inserts before the completion. */
function cleanCompletion(raw: string): string {
  return raw.replace(/^\n/, '');
}

function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}
