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
 * Checks every model in `librechat.yaml` on two axes: is its provider still
 * offering it, and are we billing it at the right rate.
 *
 * Availability is checked first because a retired model's price is beside the
 * point, and because that failure is otherwise invisible — no provider tells us
 * when it drops a model, so the first symptom is a user picking it and getting
 * an error. Seven of ours had already vanished from gptsapi before this ran.
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

/**
 * gptsapi's published rate card. Public — no key, unlike their `/v1/models`,
 * which needs one and carries no prices at all.
 *
 * This is the only price source for the models we route through them. Claude,
 * GPT and Gemini cannot go through OpenRouter (403, provider ToS, from a US
 * egress as well as a Chinese one), so before this existed a third of the
 * lineup was reported `unverifiable` and drifted unnoticed: `gpt-5.6-sol` was
 * billed at half its real rate and `claude-sonnet-4-6-cc` at 167% of it.
 *
 * Keys are the ids we send, so no translation table is needed — unlike
 * `OPENROUTER_IDS` below.
 */
const GPTSAPI_PRICES_URL = 'https://api2.gptsapi.net/user/model_price';

/**
 * Keys for reading each provider's model list, by host. OpenRouter's list is
 * public; gptsapi's returns 401 without one.
 *
 * These are normally already populated: requiring `@librechat/data-schemas`
 * above pulls in dotenv transitively, which loads `.env`. The undefined case
 * therefore only arises where no `.env` exists — CI, say — and it downgrades
 * that host to "unchecked" rather than failing the run, so the price half still
 * works without secrets.
 */
const PROVIDER_KEYS = {
  'api.gptsapi.net': process.env.GPTSAPI_KEY,
  'openrouter.ai': process.env.OPENROUTER_KEY,
};

/** Tolerance below which a difference is rounding, not a price change. */
const DRIFT_TOLERANCE = 0.005;

/**
 * Our model IDs are what we send to the provider; OpenRouter's catalogue keys
 * differ for anything we route through gptsapi. Only entries listed here can be
 * price-checked — everything else is reported as unverifiable rather than
 * silently assumed correct.
 *
 * Both spellings of the OpenRouter-routed models are listed, because
 * `librechat.yaml` is not in git and the production copy has drifted from the
 * local one — production writes `x-ai/grok-4.20`, local writes
 * `grok-4.20-beta-0309-reasoning`. Running this script against a local file
 * therefore proves nothing about production; see the caveat printed at the end.
 */
const OPENROUTER_IDS = {
  'x-ai/grok-4.20': 'x-ai/grok-4.20',
  'x-ai/grok-4.20-multi-agent': 'x-ai/grok-4.20-multi-agent',
  'x-ai/grok-4.5': 'x-ai/grok-4.5',
  'x-ai/grok-4.6': 'x-ai/grok-4.6',
  'z-ai/glm-5.3': 'z-ai/glm-5.3',
  'moonshotai/kimi-k3': 'moonshotai/kimi-k3',
  'z-ai/glm-5.2': 'z-ai/glm-5.2',
  'z-ai/glm-5-turbo': 'z-ai/glm-5-turbo',
  'moonshotai/kimi-k2.6': 'moonshotai/kimi-k2.6',
  'minimax/minimax-m3': 'minimax/minimax-m3',
  'deepseek/deepseek-v4-pro': 'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash': 'deepseek/deepseek-v4-flash',
  'gpt-4o-mini': 'openai/gpt-4o-mini',
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

function loadConfig() {
  const configPath = path.resolve(__dirname, '..', 'librechat.yaml');
  return yaml.load(fs.readFileSync(configPath, 'utf8'));
}

function productionModels(config) {
  const list = config?.modelSpecs?.list ?? [];
  return [...new Set(list.map((spec) => spec?.preset?.model).filter(Boolean))];
}

/**
 * Maps each configured model to the API base that actually serves it, by
 * following its endpoint's `baseURL`. Derived rather than hard-coded, so adding
 * an endpoint to the yaml needs no change here — and the base is carried whole
 * rather than rebuilt from the host, because the two providers mount their
 * model lists at different paths (`/api/v1` against `/v1`).
 */
function modelBases(config) {
  const baseByEndpoint = new Map();
  for (const endpoint of config?.endpoints?.custom ?? []) {
    if (endpoint?.name && endpoint?.baseURL) {
      baseByEndpoint.set(endpoint.name, endpoint.baseURL.replace(/\/+$/, ''));
    }
  }

  const bases = new Map();
  for (const spec of config?.modelSpecs?.list ?? []) {
    const model = spec?.preset?.model;
    const base = baseByEndpoint.get(spec?.preset?.endpoint);
    if (model && base) {
      bases.set(model, base);
    }
  }
  return bases;
}

/**
 * Model ids currently offered by a provider, or null when they cannot be read.
 *
 * A provider silently dropping a model is the failure this catches: nothing
 * warns us, and the first symptom is a user picking it and getting an error.
 * Seven of our models had already disappeared from gptsapi before this check
 * existed.
 */
/**
 * gptsapi's rate card as `id -> { prompt, completion }`, or null when it cannot
 * be read.
 *
 * Only per-token rows are kept. The same list prices TTS by the minute, images
 * per render and one entry as the literal string `按分辨率` ("by resolution"),
 * and a per-render price silently read as per-million would be nonsense.
 */
async function gptsapiPrices() {
  const perMillionRate = (text) => {
    const match = /\$([\d.]+)\s*\/\s*1M/.exec(text ?? '');
    return match ? Number(match[1]) : null;
  };
  try {
    const response = await fetch(GPTSAPI_PRICES_URL);
    if (!response.ok) {
      return null;
    }
    const body = await response.json();
    const prices = new Map();
    for (const group of body?.data ?? []) {
      for (const model of group?.modelList ?? []) {
        const prompt = perMillionRate(model.inputUnitPrice);
        const completion = perMillionRate(model.outputUnitPrice);
        if (prompt != null && completion != null) {
          prices.set(model.modelValue.toLowerCase(), { prompt, completion });
        }
      }
    }
    return prices;
  } catch {
    return null;
  }
}

/**
 * Per-provider price range for one OpenRouter model, or null when unreadable.
 *
 * A multi-provider model has no single price. `/models` quotes whichever
 * provider is default at that moment, so a rate that has not moved reads as
 * drift the instant routing shifts — `deepseek-v4-pro` spans 0.87 to 1.91
 * across 18 providers, a 2.2x band. Comparing against the band instead of the
 * quote is what separates a real list-price change (the whole band moves) from
 * routing noise (only the quote does).
 */
async function openRouterSpread(modelId) {
  try {
    const response = await fetch(`${OPENROUTER_MODELS_URL}/${modelId}/endpoints`);
    if (!response.ok) {
      return null;
    }
    const endpoints = (await response.json())?.data?.endpoints ?? [];
    const prompts = endpoints.map((e) => perMillion(e.pricing.prompt)).filter((v) => v != null);
    const completions = endpoints
      .map((e) => perMillion(e.pricing.completion))
      .filter((v) => v != null);
    if (!prompts.length || !completions.length) {
      return null;
    }
    return {
      prompt: { min: Math.min(...prompts), max: Math.max(...prompts) },
      completion: { min: Math.min(...completions), max: Math.max(...completions) },
      providers: endpoints.length,
    };
  } catch {
    return null;
  }
}

const within = (value, range) =>
  value >= range.min - DRIFT_TOLERANCE && value <= range.max + DRIFT_TOLERANCE;

/** Trims the float noise that surfaces from multiplying published per-token
 *  fractions by 1e6 — a band edge otherwise prints as 3.8299999999999996. */
const band = (range) => `${Number(range.min.toFixed(6))}–${Number(range.max.toFixed(6))}`;

async function providerCatalogue(base, apiKey) {
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
  try {
    const response = await fetch(`${base}/models`, { headers });
    if (!response.ok) {
      return null;
    }
    const body = await response.json();
    return new Set((body?.data ?? []).map((model) => model.id));
  } catch {
    return null;
  }
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

  const gptsapiCard = await gptsapiPrices();
  if (gptsapiCard === null) {
    console.orange('  api.gptsapi.net: rate card unreadable — its models fall back to unverified');
  }

  const config = loadConfig();
  const models = productionModels(config);
  const bases = modelBases(config);
  const problems = { drift: 0, fallback: 0, unverifiable: 0, uncovered: 0, retired: 0 };

  /** One catalogue fetch per distinct provider, not one per model — and none at
   *  all for OpenRouter, whose list was already fetched above for pricing. */
  const catalogues = new Map();
  for (const base of new Set(bases.values())) {
    catalogues.set(
      base,
      new URL(base).host === 'openrouter.ai'
        ? new Set(catalogue.keys())
        : await providerCatalogue(base, PROVIDER_KEYS[new URL(base).host]),
    );
  }
  for (const [base, catalogueForBase] of catalogues) {
    if (catalogueForBase === null) {
      console.orange(
        `  ${new URL(base).host}: model list unreadable — availability unchecked for its models`,
      );
    }
  }

  for (const model of models) {
    /** Availability first: a retired model's price is beside the point. */
    const base = bases.get(model);
    const catalogueForBase = base ? catalogues.get(base) : undefined;
    if (catalogueForBase && !catalogueForBase.has(model)) {
      console.red(`  ${model}: ${new URL(base).host} no longer offers it — selecting it will fail`);
      problems.retired++;
      continue;
    }

    const key = findMatchingPattern(model, tokenValues);
    const rate = key ? tokenValues[key] : null;

    if (!rate || (rate.prompt === defaultRate && rate.completion === defaultRate)) {
      console.red(`  ${model}: no rate entry — billing at defaultRate ${defaultRate}`);
      problems.fallback++;
      continue;
    }

    /** gptsapi's own card wins for anything not routed through OpenRouter.
     *  OpenRouter would otherwise price it from a different vendor's list — and
     *  for Claude, GPT and Gemini it prices a model we are not permitted to
     *  call at all.
     *
     *  The test is "not OpenRouter" rather than "is gptsapi" because only the
     *  OpenRouter half is declared under `endpoints.custom`. Our GPT and Claude
     *  models sit on the built-in `openAI` and `anthropic` endpoints, pointed at
     *  gptsapi by `OPENAI_REVERSE_PROXY` / `ANTHROPIC_REVERSE_PROXY`, so
     *  `modelBases` has no entry for them at all. Keys are full model ids, so a
     *  model absent from the card simply falls through. */
    const gptsapiRate =
      base && new URL(base).host === 'openrouter.ai'
        ? undefined
        : gptsapiCard?.get(model.toLowerCase());

    let livePrompt;
    let liveCompletion;
    /** gptsapi publishes cache rates on its pricing page but not in this feed,
     *  so cache stays unchecked on that route. Harmless today: their endpoint
     *  drops `cache_control` blocks and always reports `cached_tokens: 0`, so
     *  no cached read is ever billed. */
    let liveCacheRead = null;

    if (gptsapiRate) {
      livePrompt = gptsapiRate.prompt;
      liveCompletion = gptsapiRate.completion;
    } else {
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

      livePrompt = perMillion(live.pricing.prompt);
      liveCompletion = perMillion(live.pricing.completion);
      liveCacheRead = perMillion(live.pricing.input_cache_read);
    }

    if (drifted(rate.prompt, livePrompt) || drifted(rate.completion, liveCompletion)) {
      /** Only OpenRouter fans a model across providers; a gptsapi rate is a
       *  single published number, so a difference there is always real. */
      const spread = gptsapiRate ? null : await openRouterSpread(OPENROUTER_IDS[model]);
      if (
        spread &&
        within(rate.prompt, spread.prompt) &&
        within(rate.completion, spread.completion)
      ) {
        console.orange(
          `  ${model}: quote moved to ${livePrompt}/${liveCompletion}, but ${rate.prompt}/${rate.completion} ` +
            `sits inside the ${spread.providers}-provider band ` +
            `(${band(spread.prompt)} / ${band(spread.completion)}) — routing, not a price change`,
        );
        continue;
      }
      console.red(
        `  ${model}: billing ${rate.prompt}/${rate.completion}, live ${livePrompt}/${liveCompletion}` +
          (spread
            ? ` — outside the ${spread.providers}-provider band ` +
              `(${band(spread.prompt)} / ${band(spread.completion)})`
            : ''),
      );
      problems.drift++;
      continue;
    }

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

  /** Keys are model-family substrings, not full model IDs, so a key is live
   *  when some configured model resolves to it — string equality would flag
   *  every bare key as dead. */
  const liveKeys = new Set(models.map((model) => findMatchingPattern(model, tokenValues)));
  const unused = [...Object.keys(chatchatValues), ...Object.keys(chatchatCacheValues)].filter(
    (key) => !liveKeys.has(key),
  );
  for (const key of new Set(unused)) {
    console.orange(`  ${key}: overridden but no configured model resolves to it`);
  }

  console.purple('----------------------------------------');
  console.cyan(`  checked:       ${models.length}`);
  console.cyan(`  retired:       ${problems.retired}`);
  console.cyan(`  price drift:   ${problems.drift}`);
  console.cyan(`  on defaultRate:${problems.fallback}`);
  console.cyan(`  missing cache: ${problems.uncovered}`);
  console.cyan(`  unverifiable:  ${problems.unverifiable}`);

  console.orange(
    '\n  Checked against the LOCAL librechat.yaml — both the prices and the\n' +
      '  availability. That file is not in git and the production copy has drifted\n' +
      '  before: production writes provider-prefixed ids this file omits, and routes\n' +
      '  some vendors through a different endpoint entirely. So a retired/ok verdict\n' +
      '  here is a verdict on the local file, not on production. Verify the deployed\n' +
      '  config separately whenever models change.',
  );

  const blocking = problems.retired + problems.drift + problems.fallback + problems.uncovered;
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
