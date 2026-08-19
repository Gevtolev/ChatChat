const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const {
  tokenValues,
  cacheTokenValues,
  defaultRate,
  chatchatValues,
  chatchatCacheValues,
  chatchatNoCacheModels,
} = require('@librechat/data-schemas');
/** Loaded for the console colour helpers it installs as a side effect. */
require('./helpers');

/**
 * Compares the rates we bill against OpenRouter's live catalogue, and reports
 * any model in `librechat.yaml` that no table covers.
 *
 * Read-only. Nothing here writes to the database or to source — it prints a
 * report and exits non-zero when something needs attention, so it can be wired
 * into CI later without changing behaviour.
 *
 * A hand-maintained price table goes stale silently; this turns that into a
 * command you can run. Prices move roughly quarterly, so running it before each
 * release is enough — there is deliberately no scheduled job.
 *
 * Usage:
 *   npm run check-model-prices
 */

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

/** Tolerance below which a difference is rounding, not a price change. */
const DRIFT_TOLERANCE = 0.005;

/**
 * Our model IDs are what we send to the provider; OpenRouter's catalogue keys
 * differ for anything we route through gptsapi. Only entries listed here can be
 * price-checked — everything else is reported as unverifiable rather than
 * silently assumed correct.
 */
const OPENROUTER_IDS = {
  'gemini-2.5-flash': 'google/gemini-2.5-flash',
  'gemini-2.5-flash-lite': 'google/gemini-2.5-flash-lite',
  'gemini-3.1-pro-preview': 'google/gemini-3.1-pro-preview',
  'gemini-3-flash-preview': 'google/gemini-3-flash-preview',
  'gpt-5.5': 'openai/gpt-5.5',
  'gpt-5.4': 'openai/gpt-5.4',
  'gpt-5.4-pro': 'openai/gpt-5.4-pro',
  'gpt-5.4-mini': 'openai/gpt-5.4-mini',
  'gpt-5.4-nano': 'openai/gpt-5.4-nano',
  'claude-opus-4-8': 'anthropic/claude-opus-4.8',
  'claude-opus-4-7': 'anthropic/claude-opus-4.7',
  'claude-opus-4-6': 'anthropic/claude-opus-4.6',
  'claude-opus-4-5-20251101': 'anthropic/claude-opus-4.5',
  'claude-sonnet-4-6': 'anthropic/claude-sonnet-4.6',
  'claude-sonnet-4-6-thinking': 'anthropic/claude-sonnet-4.6',
  'claude-haiku-4-5-20251001': 'anthropic/claude-haiku-4.5',
  'x-ai/grok-4.3': 'x-ai/grok-4.3',
  'grok-4.20-beta-0309-reasoning': 'x-ai/grok-4.20',
  'grok-4.20-beta-0309-non-reasoning': 'x-ai/grok-4.20',
  'grok-4.20-multi-agent-beta-0309': 'x-ai/grok-4.20-multi-agent',
  'deepseek-v4-pro': 'deepseek/deepseek-v4-pro',
  'deepseek-v4-flash': 'deepseek/deepseek-v4-flash',
  'glm-5.2': 'z-ai/glm-5.2',
  'glm-5-turbo': 'z-ai/glm-5-turbo',
  'kimi-k2.6': 'moonshotai/kimi-k2.6',
  'MiniMax-M3': 'minimax/minimax-m3',
  'deepseek/deepseek-chat': 'deepseek/deepseek-chat',
};

/** Mirrors `findMatchingPattern` in @librechat/api: longest key wins, exact
 *  length short-circuits. Inlined because config scripts do not depend on that
 *  package. */
function findMatchingPattern(modelName, tokensMap) {
  const keys = Object.keys(tokensMap);
  const lowerModelName = modelName.toLowerCase();
  let bestMatch = null;
  let bestLength = 0;
  for (let i = keys.length - 1; i >= 0; i--) {
    const lowerKey = keys[i].toLowerCase();
    if (lowerKey.length > bestLength && lowerModelName.includes(lowerKey)) {
      if (lowerKey.length === lowerModelName.length) {
        return keys[i];
      }
      bestMatch = keys[i];
      bestLength = lowerKey.length;
    }
  }
  return bestMatch;
}

/** OpenRouter quotes USD per token; our tables are USD per 1M tokens. */
function perMillion(value) {
  return value == null ? null : parseFloat(value) * 1e6;
}

function drifted(ours, live) {
  if (live == null) {
    return false;
  }
  return Math.abs(ours - live) > DRIFT_TOLERANCE;
}

function productionModels() {
  const configPath = path.resolve(__dirname, '..', 'librechat.yaml');
  const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
  const list = config?.modelSpecs?.list ?? [];
  return [...new Set(list.map((spec) => spec?.preset?.model).filter(Boolean))];
}

(async () => {
  console.purple('----------------------------------------');
  console.purple('Model price check');
  console.purple('----------------------------------------');

  const response = await fetch(OPENROUTER_MODELS_URL);
  if (!response.ok) {
    console.red(`OpenRouter returned ${response.status} — cannot verify prices.`);
    process.exit(1);
  }
  const { data } = await response.json();
  const catalogue = new Map(data.map((model) => [model.id, model]));

  const models = productionModels();
  const problems = { drift: 0, fallback: 0, unverifiable: 0, uncovered: 0 };

  for (const model of models) {
    const key = findMatchingPattern(model, tokenValues);
    const rate = key ? tokenValues[key] : null;

    if (!rate || (rate.prompt === defaultRate && rate.completion === defaultRate)) {
      console.red(`  ${model}: no rate entry — billing at defaultRate ${defaultRate}`);
      problems.fallback++;
      continue;
    }

    const openRouterId = OPENROUTER_IDS[model];
    if (!openRouterId) {
      console.orange(`  ${model}: not mapped to an OpenRouter id — price unverified`);
      problems.unverifiable++;
      continue;
    }

    const live = catalogue.get(openRouterId);
    if (!live) {
      console.orange(`  ${model}: '${openRouterId}' absent from OpenRouter catalogue`);
      problems.unverifiable++;
      continue;
    }

    const livePrompt = perMillion(live.pricing.prompt);
    const liveCompletion = perMillion(live.pricing.completion);
    if (drifted(rate.prompt, livePrompt) || drifted(rate.completion, liveCompletion)) {
      console.red(
        `  ${model}: billing ${rate.prompt}/${rate.completion}, live ${livePrompt}/${liveCompletion}`,
      );
      problems.drift++;
      continue;
    }

    const liveCacheRead = perMillion(live.pricing.input_cache_read);
    const cache = key ? cacheTokenValues[key] : null;
    if (liveCacheRead != null && !cache && !chatchatNoCacheModels.includes(model)) {
      console.red(
        `  ${model}: no cache entry, but provider prices cache reads at ${liveCacheRead} ` +
          `— cached tokens bill at the ${rate.prompt} input rate`,
      );
      problems.uncovered++;
      continue;
    }
    if (cache && drifted(cache.read, liveCacheRead)) {
      console.red(`  ${model}: cache read ${cache.read}, live ${liveCacheRead}`);
      problems.drift++;
      continue;
    }

    console.green(`  ${model}: ok`);
  }

  const stale = Object.keys(chatchatValues).filter((model) => !models.includes(model));
  const staleCache = Object.keys(chatchatCacheValues).filter((model) => !models.includes(model));
  for (const model of new Set([...stale, ...staleCache])) {
    console.orange(`  ${model}: overridden but no longer in modelSpecs — dead entry`);
  }

  console.purple('----------------------------------------');
  console.cyan(`  checked:       ${models.length}`);
  console.cyan(`  price drift:   ${problems.drift}`);
  console.cyan(`  on defaultRate:${problems.fallback}`);
  console.cyan(`  missing cache: ${problems.uncovered}`);
  console.cyan(`  unverifiable:  ${problems.unverifiable}`);

  const blocking = problems.drift + problems.fallback + problems.uncovered;
  if (blocking > 0) {
    console.red(`\n${blocking} model(s) need attention.`);
    process.exit(1);
  }
  console.green('\nAll verifiable prices match.');
  process.exit(0);
})();

process.on('uncaughtException', (err) => {
  console.error('There was an uncaught error:');
  console.error(err);
  process.exit(1);
});
