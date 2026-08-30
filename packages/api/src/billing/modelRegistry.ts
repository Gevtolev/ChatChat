import { logger } from '@librechat/data-schemas';
import type { CostTier } from 'librechat-data-provider';

export type FeatureKey = 'agents' | 'image_gen' | 'voice' | 'web_search';

export interface ModelEntry {
  cost_tier: CostTier;
  feature?: FeatureKey;
}

/**
 * Registry of known models → { cost_tier, feature? }.
 *
 * Keys are the bare model family, without the provider prefix or date suffix
 * the caller actually passes: `BaseClient.js` hands `getModelTier` the raw
 * `modelOptions.model` (`x-ai/grok-4.3`, `claude-opus-4-5-20251101`), and
 * `findRegistryKey` below resolves it by longest contained key.
 *
 * Tiers follow the completion rate in `chatchatValues`/`tokenValues`, which is
 * what `cost_tier` is for and what the gate spends it on. The split falls on
 * the two natural gaps in our lineup's pricing: cheap ends at 3.00 (next is
 * 3.20) and mid ends at 10.00 (next is 12.00).
 *
 *   cheap      completion <= 3      mid  3 < completion <= 10
 *   expensive  completion > 10
 *
 * The earlier pass guessed from naming instead (mini/nano/lite = cheap,
 * flagship = mid, opus/pro = expensive), which put grok-4.3 at 1.25/2.50 in
 * `expensive` while the pricier grok-4.5 at 2.00/6.00 fell through unregistered
 * to the `mid` default. Naming is a poor proxy: `gpt-5.6-luna` is a flagship
 * name at 0.20/1.20, and `gpt-5.4-mini` is a cheap name at 0.75/4.50.
 *
 * Only `free` restricts tiers (cheap only) — every paid plan allows all three —
 * so in practice this table decides which models an unpaid signup can reach.
 */
export const MODEL_REGISTRY: Record<string, ModelEntry> = {
  // Google — Gemini family
  'gemini-2.5-flash': { cost_tier: 'cheap' },
  'gemini-2.5-flash-lite': { cost_tier: 'cheap' },
  'gemini-3-flash-preview': { cost_tier: 'cheap' },
  'gemini-3.1-pro-preview': { cost_tier: 'expensive' },

  // OpenAI — GPT-5 family
  'gpt-5.4-nano': { cost_tier: 'cheap' },
  'gpt-5.6-luna': { cost_tier: 'cheap' },
  'gpt-5.4-mini': { cost_tier: 'mid' },
  'gpt-5.4': { cost_tier: 'expensive' },
  'gpt-5.6-terra': { cost_tier: 'expensive' },
  'gpt-5.6-sol': { cost_tier: 'expensive' },
  'gpt-5.4-pro': { cost_tier: 'expensive' },
  'gpt-5.5': { cost_tier: 'expensive' },

  // Anthropic — Claude family
  'claude-haiku-4-5': { cost_tier: 'cheap' },
  'claude-sonnet-5': { cost_tier: 'mid' },
  'claude-sonnet-4-6': { cost_tier: 'expensive' },
  'claude-sonnet-4-6-thinking': { cost_tier: 'expensive' },
  'claude-opus-4-5': { cost_tier: 'expensive' },
  'claude-opus-4-6': { cost_tier: 'expensive' },
  'claude-opus-4-7': { cost_tier: 'expensive' },
  'claude-opus-4-8': { cost_tier: 'expensive' },
  'claude-opus-5': { cost_tier: 'expensive' },

  // xAI — Grok family
  'grok-4-1-fast': { cost_tier: 'cheap' },
  'grok-4.3': { cost_tier: 'cheap' },
  'grok-4.20': { cost_tier: 'cheap' },
  'grok-4.20-fast': { cost_tier: 'cheap' },
  'grok-4.5': { cost_tier: 'mid' },
  'grok-4.6': { cost_tier: 'mid' },
  'grok-4.20-reasoning': { cost_tier: 'expensive' },
  'grok-4.20-multi-agent': { cost_tier: 'expensive' },

  // DeepSeek
  'deepseek-v4-flash': { cost_tier: 'cheap' },
  'deepseek-v4-pro': { cost_tier: 'mid' },

  // GLM
  'glm-5-turbo': { cost_tier: 'cheap' },
  'glm-5.2': { cost_tier: 'mid' },
  'glm-5.3': { cost_tier: 'mid' },

  // Kimi / MiniMax
  'minimax-m3': { cost_tier: 'cheap' },
  'kimi-k2.6': { cost_tier: 'mid' },
  'kimi-k3': { cost_tier: 'expensive' },
};

/**
 * Finds the longest registry key contained in `modelId`. Providers append release-date
 * suffixes to the raw model id they send (e.g. `claude-opus-4-5-20251101`) that don't match
 * the curated, undated registry key (`claude-opus-4-5`) exactly.
 */
function findRegistryKey(modelId: string): string | undefined {
  if (MODEL_REGISTRY[modelId]) {
    return modelId;
  }
  const lowerModelId = modelId.toLowerCase();
  let bestMatch: string | undefined;
  let bestLength = 0;
  for (const key of Object.keys(MODEL_REGISTRY)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.length > bestLength && lowerModelId.includes(lowerKey)) {
      bestMatch = key;
      bestLength = lowerKey.length;
    }
  }
  return bestMatch;
}

/** Returns the cost tier for a model ID. Falls back to 'mid' and warns for unknown models. */
export function getModelTier(modelId: string): CostTier {
  const registryKey = findRegistryKey(modelId);
  const entry = registryKey ? MODEL_REGISTRY[registryKey] : undefined;
  if (!entry) {
    logger.warn('[modelRegistry] unknown model, defaulting to mid tier', modelId);
    return 'mid';
  }
  return entry.cost_tier;
}
