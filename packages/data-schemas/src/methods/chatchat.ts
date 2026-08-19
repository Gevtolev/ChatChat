/**
 * ChatChat model rate overrides.
 *
 * Upstream's `tokenValues` is a list-price table keyed by loose model-name
 * prefixes. Our production lineup resolves through it badly: some models have
 * no entry at all and land on `defaultRate`, others match a shorter prefix
 * belonging to a different model. Both outcomes bill users at a rate unrelated
 * to what the call costs us.
 *
 * These tables are merged over the upstream ones so that `findMatchingPattern`,
 * which prefers the longest matching key and short-circuits on an exact-length
 * match, resolves our exact model IDs to these entries. That makes the override
 * independent of key insertion order, so upstream adding or removing entries
 * cannot change which rate we bill.
 *
 * Rates are USD per 1M tokens, matching upstream's unit.
 *
 * Source: OpenRouter public catalogue (https://openrouter.ai/api/v1/models),
 * fields `pricing.prompt` / `pricing.completion` / `pricing.input_cache_read`,
 * fetched 2026-08-19. For models we route through gptsapi rather than
 * OpenRouter, this is the original vendor's list price and therefore an upper
 * bound on our cost — a reseller does not charge above list.
 *
 * Keys are the SHORTEST string that identifies the model family, without the
 * provider prefix — `grok-4.20`, not `x-ai/grok-4.20`. Because matching is by
 * substring, a bare key covers every prefixed spelling of the same model. This
 * matters: production and local `librechat.yaml` have drifted (the file is not
 * in git), production writing `x-ai/grok-4.20` where local writes
 * `grok-4.20-beta-0309-reasoning`. Prefixed keys would silently miss on one
 * side and fall back to a shorter upstream key.
 *
 * The exception is `deepseek/deepseek-chat`, which keeps its prefix: a bare
 * `deepseek-chat` would collide with the upstream key of the same name and
 * re-price every DeepSeek variant, not just ours.
 *
 * Re-check with `npm run check-model-prices`.
 */

export interface TokenRate {
  prompt: number;
  completion: number;
}

export interface CacheRate {
  write: number;
  read: number;
}

export const chatchatValues: Record<string, TokenRate> = {
  'gemini-3-flash-preview': { prompt: 0.5, completion: 3 },
  'gpt-5.5': { prompt: 5, completion: 30 },
  'gpt-5.4-pro': { prompt: 30, completion: 180 },
  'gpt-5.4-mini': { prompt: 0.75, completion: 4.5 },
  'gpt-5.4-nano': { prompt: 0.2, completion: 1.25 },
  'grok-4.3': { prompt: 1.25, completion: 2.5 },
  'grok-4.5': { prompt: 2, completion: 6 },
  'grok-4.20': { prompt: 1.25, completion: 2.5 },
  'grok-4.20-multi-agent': { prompt: 1.25, completion: 2.5 },
  /** Multi-provider on OpenRouter, so the catalogue price tracks whichever
   *  provider is currently default — observed moving 1.32/3.96 → 1.44/2.88
   *  within an hour. Expect `check-model-prices` to flag this one periodically;
   *  the drift is routing, not a vendor price change. */
  'deepseek-v4-pro': { prompt: 1.44, completion: 2.88 },
  'deepseek-v4-flash': { prompt: 0.0826, completion: 0.1652 },
  'glm-5.2': { prompt: 0.966, completion: 3.036 },
  'glm-5-turbo': { prompt: 1.2, completion: 4 },
  'kimi-k2.6': { prompt: 0.95, completion: 4 },
  'MiniMax-M3': { prompt: 0.3, completion: 1.2 },
  'deepseek/deepseek-chat': { prompt: 0.2574, completion: 1.0287 },
};

/**
 * Cache rates for the same models.
 *
 * Two rules decide the `write` side, because `input_cache_write` does not mean
 * the same thing for every vendor:
 *
 * - Anthropic publishes a true per-token write multiplier — a steady 1.25x of
 *   input across opus, sonnet and haiku — so its value is used directly.
 * - Every other vendor here caches implicitly: creating the cache entry costs
 *   nothing beyond the normal input charge. Their `write` is therefore the
 *   model's own input rate. (Google does publish `input_cache_write`, but its
 *   ratio to input scatters — 0.278 / 0.188 / 0.167 / 0.833 — and three models
 *   share the absolute value 0.0833, which marks it as a time-based storage
 *   price rather than a per-token multiplier. Using it here would be wrong.)
 *
 * Models with no cache support (`gpt-5.4-pro`, `deepseek/deepseek-chat`) are
 * deliberately absent. `cacheTokenValues` is read by direct key lookup rather
 * than by pattern match, so a missing key yields `null`, and
 * `calculateStructuredTokenValue` resolves `null` to the model's own input rate
 * (`?? inputMultiplier`). That is exactly the right charge for a model that
 * cannot cache, and it tracks the input rate automatically if it changes.
 *
 * No Anthropic entries appear here: all six Claude models already resolve to
 * correct upstream values, so overriding them would add drift for no gain.
 */
export const chatchatCacheValues: Record<string, CacheRate> = {
  /** Base rates for these two are already correct upstream, but neither has a
   *  cache entry, so cached reads were billing at the full input rate — 10x
   *  their real cost. Cache coverage is independent of base-rate coverage. */
  'gemini-2.5-flash': { write: 0.3, read: 0.03 },
  'gemini-2.5-flash-lite': { write: 0.1, read: 0.01 },

  'gemini-3-flash-preview': { write: 0.5, read: 0.05 },
  'gpt-5.5': { write: 5, read: 0.5 },
  'gpt-5.4-mini': { write: 0.75, read: 0.075 },
  'gpt-5.4-nano': { write: 0.2, read: 0.02 },
  'grok-4.3': { write: 1.25, read: 0.2 },
  'grok-4.5': { write: 2, read: 0.3 },
  'grok-4.20': { write: 1.25, read: 0.2 },
  'grok-4.20-multi-agent': { write: 1.25, read: 0.2 },
  'deepseek-v4-pro': { write: 1.44, read: 0.1215 },
  'deepseek-v4-flash': { write: 0.0826, read: 0.0165 },
  'glm-5.2': { write: 0.966, read: 0.1932 },
  'glm-5-turbo': { write: 1.2, read: 0.24 },
  'kimi-k2.6': { write: 0.95, read: 0.16 },
  'MiniMax-M3': { write: 0.3, read: 0.06 },
};

/** Models priced for tokens but intentionally absent from the cache table
 *  because the provider offers no prompt caching for them. Their cache tokens,
 *  if ever reported, bill at the model's input rate via the `?? inputMultiplier`
 *  fallback in `calculateStructuredTokenValue`.
 *
 *  `grok-4-1-fast-non-reasoning` is absent for a different reason: OpenRouter
 *  lists no `grok-4.1` model, so there is no cache price to copy. It keeps the
 *  upstream base rate and falls back to input for cache tokens — conservative,
 *  since that can only over-charge the user, never under-charge us. Revisit if
 *  a published rate appears. */
export const chatchatNoCacheModels: readonly string[] = ['gpt-5.4-pro', 'deepseek/deepseek-chat'];
