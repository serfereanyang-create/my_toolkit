/**
 * Model → context window, the analogue of openai/codex's
 * `models-manager/models.json` `context_window` field.
 *
 * The CLI is multi-vendor and has no metadata endpoint, so this is a
 * hand-maintained table of CONSERVATIVE windows: where a value is uncertain the
 * smaller one is used. Being wrong low costs an earlier summary; being wrong
 * high costs a rejected request.
 *
 * Resolution order (codex: config `model_context_window` > models.json >
 * fallback metadata):
 *   1. AICODE_CONTEXT_WINDOW — an explicit override; the desktop sets it from
 *      the provider's per-model 上下文窗口 field.
 *   2. this table.
 *   3. FALLBACK_CONTEXT_WINDOW_TOKENS.
 *
 * Order in the table matters: the first match wins, so narrower patterns come
 * first.
 */

export type ModelWindowRule = { pattern: RegExp; tokens: number };

/** codex `default_effective_context_window_percent()` — context kept for output. */
export const EFFECTIVE_CONTEXT_WINDOW_PERCENT = 95;

/** codex `APPROX_BYTES_PER_TOKEN` (utils/string truncate.rs): the 4-bytes-per-token estimate. */
export const APPROX_BYTES_PER_TOKEN = 4;

/** codex `ModelInfo::auto_compact_token_limit()`: resolved window × 9 / 10. */
export const AUTO_COMPACT_WINDOW_FRACTION = 0.9;

/**
 * The window assumed for a model this table does not know.
 *
 * Unknown must NOT mean "no window": that was the previous behavior, and it
 * disabled auto-compaction outright. Since no model in the desktop's settings
 * carried a contextWindow, `AICODE_CONTEXT_WINDOW` was never set and
 * compaction never fired once — the conversation simply grew until the packed
 * char budget silently discarded most of it.
 *
 * codex falls back to 272k (`model_info_from_slug`). This table's floor is
 * 128k, the smallest window among the vendors supported here, so an unknown
 * model gets the smallest defensible assumption.
 */
export const FALLBACK_CONTEXT_WINDOW_TOKENS = 128_000;

export const MODEL_CONTEXT_WINDOWS: readonly ModelWindowRule[] = [
  // --- OpenAI / gpt-5 family: 272k, per codex models.json ---
  { pattern: /gpt-5|gpt-6|^o[134](-|$)/, tokens: 272_000 },
  { pattern: /gpt-4\.1/, tokens: 1_000_000 },
  { pattern: /gpt-4o|gpt-4-turbo/, tokens: 128_000 },

  // --- Anthropic: 200k across the 3.5/4 families ---
  { pattern: /claude/, tokens: 200_000 },

  // --- Google ---
  { pattern: /gemini-2\.5|gemini-3/, tokens: 1_000_000 },
  { pattern: /gemini/, tokens: 128_000 },

  // --- Zhipu GLM: 4.6 and 5.x widened to 200k, 4.5 stayed at 128k ---
  { pattern: /glm-?(?:[6-9]|5)/, tokens: 200_000 },
  { pattern: /glm-?4\.(?:[6-9])/, tokens: 200_000 },
  { pattern: /glm/, tokens: 128_000 },

  // --- Moonshot Kimi K2: 256k ---
  { pattern: /kimi-?k2|moonshot/, tokens: 256_000 },
  { pattern: /kimi/, tokens: 128_000 },

  // --- DeepSeek: 128k for the v3/v4 line ---
  { pattern: /deepseek/, tokens: 128_000 },

  // --- xAI Grok: 4.x is 256k, 3.x is 131k ---
  { pattern: /grok-?4|grok-?[5-9]/, tokens: 256_000 },
  { pattern: /grok/, tokens: 131_072 },

  // --- Qwen: 128k is the common floor; the long-context variants say so ---
  { pattern: /qwen.*(1m|long)/, tokens: 1_000_000 },
  { pattern: /qwen/, tokens: 128_000 },
];

/**
 * Resolve the context window in tokens for a model id.
 *
 * `env` is injectable so the resolution order can be tested without touching
 * the real process environment.
 */
export function resolveModelContextWindow(
  model: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const override = Number.parseInt(env.AICODE_CONTEXT_WINDOW ?? '', 10);
  if (Number.isFinite(override) && override > 0) return override;

  const id = (model ?? '').toLowerCase();
  if (id) {
    for (const rule of MODEL_CONTEXT_WINDOWS) {
      if (rule.pattern.test(id)) return rule.tokens;
    }
  }
  return FALLBACK_CONTEXT_WINDOW_TOKENS;
}

/** codex `auto_compact_token_limit()`: the window we compact at. */
export function autoCompactTokenLimit(windowTokens: number): number {
  return Math.floor(windowTokens * AUTO_COMPACT_WINDOW_FRACTION);
}

/** codex `usable_context_window()`: the window minus the output headroom. */
export function effectiveContextWindow(windowTokens: number): number {
  return Math.floor((windowTokens * EFFECTIVE_CONTEXT_WINDOW_PERCENT) / 100);
}
