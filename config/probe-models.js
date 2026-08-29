const http = require('http');
const path = require('path');
const fs = require('fs');
const https = require('https');
const yaml = require('js-yaml');
/** Loaded for the console colour helpers it installs as a side effect. */
require('./helpers');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

/**
 * Verifies that every model offered in `librechat.yaml` can actually be used.
 *
 * `check-model-prices` answers "is this model in the provider's catalogue and
 * are we billing it right". Both of today's outages slipped past that, because
 * a catalogue entry is necessary but nowhere near sufficient:
 *
 *   1. Six models were listed in `modelSpecs` but missing from their endpoint's
 *      `models.default`, so `validateModel` rejected them with
 *      `illegal_model_request` before a request ever left the server. The
 *      catalogue was innocent; our own config disagreed with itself.
 *   2. `gemini-3.7-flash` sat in gptsapi's catalogue and 400'd on every chat
 *      call ("call_methods must include chat"), and every Haiku variant it
 *      offers returned an empty string with `finish_reason: stop` — while still
 *      billing 50+ completion tokens.
 *
 * The second one is the reason this script sends real requests and treats empty
 * content as failure. A model that answers HTTP 200 with nothing is worse than
 * one that errors: the user sees a blank reply, we pay for the tokens, and no
 * log line anywhere says something went wrong.
 *
 * Costs a few hundred tokens per run — well under a cent — so run it after any
 * change to the model lineup, and after any deploy that ships a new
 * `librechat.yaml`.
 */

/** Big enough that a reasoning model's preamble cannot crowd out the answer and
 *  fake an "empty content" failure. */
const MAX_TOKENS = 2000;
const REQUEST_TIMEOUT_MS = 120_000;
const PROMPT = 'What is 2+2? Answer with digits only.';

function loadConfig() {
  return yaml.load(fs.readFileSync(path.resolve(__dirname, '..', 'librechat.yaml'), 'utf8'));
}

/** `apiKey: "${GPTSAPI_KEY}"` in the yaml resolves against the environment. */
function expand(value) {
  return String(value ?? '').replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '');
}

/**
 * Custom endpoints carry their own baseURL and key. Native ones (`openAI`)
 * carry neither in the yaml — they read the reverse proxy and key from env.
 */
function resolveTarget(endpointName, customByName) {
  const custom = customByName.get(endpointName);
  if (custom) {
    return { base: expand(custom.baseURL), key: expand(custom.apiKey) };
  }
  return { base: process.env.OPENAI_REVERSE_PROXY, key: process.env.OPENAI_API_KEY };
}

function callModel({ base, key, model }) {
  const url = new URL(`${base.replace(/\/$/, '')}/chat/completions`);
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: PROMPT }],
    max_tokens: MAX_TOKENS,
  });
  const transport = url.protocol === 'http:' ? http : https;

  return new Promise((resolve) => {
    const request = transport.request(
      {
        host: url.host,
        path: url.pathname,
        method: 'POST',
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${key}`,
        },
      },
      (response) => {
        let raw = '';
        response.on('data', (chunk) => (raw += chunk));
        response.on('end', () => resolve(interpret(response.statusCode, raw)));
      },
    );
    request.on('timeout', () => {
      request.destroy();
      resolve({ ok: false, detail: `timed out after ${REQUEST_TIMEOUT_MS / 1000}s` });
    });
    request.on('error', (error) => resolve({ ok: false, detail: error.message }));
    request.end(body);
  });
}

function interpret(statusCode, raw) {
  if (statusCode !== 200) {
    let detail = raw.slice(0, 120).replace(/\s+/g, ' ');
    try {
      detail = JSON.parse(raw)?.error?.message ?? detail;
    } catch (_) {
      /* keep the raw slice */
    }
    return { ok: false, detail: `HTTP ${statusCode} ${String(detail).slice(0, 100)}` };
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    return { ok: false, detail: 'response was not JSON' };
  }

  const content = String(payload?.choices?.[0]?.message?.content ?? '').trim();
  const billed = payload?.usage?.completion_tokens ?? 0;
  if (!content) {
    return { ok: false, detail: `empty content, billed ${billed} completion tokens` };
  }
  return { ok: true, detail: `"${content.slice(0, 24)}"` };
}

/**
 * The config-level check: a spec whose model is absent from its endpoint's
 * whitelist is dead on arrival, and costs nothing to catch.
 */
function checkWhitelists(specs, customByName) {
  const offenders = [];
  for (const spec of specs) {
    const endpoint = spec?.preset?.endpoint;
    const model = spec?.preset?.model;
    const custom = customByName.get(endpoint);
    if (!custom) {
      continue;
    }
    const whitelist = custom.models?.default ?? [];
    if (!whitelist.includes(model)) {
      offenders.push({ name: spec.name, endpoint, model });
    }
  }
  return offenders;
}

(async () => {
  const config = loadConfig();
  const specs = config?.modelSpecs?.list ?? [];
  const customByName = new Map((config?.endpoints?.custom ?? []).map((e) => [e.name, e]));

  if (specs.length === 0) {
    console.red('No modelSpecs found in librechat.yaml — nothing to probe.');
    process.exit(1);
  }

  console.purple('\n--- whitelist consistency ---');
  const offenders = checkWhitelists(specs, customByName);
  for (const o of offenders) {
    console.red(`  ${o.name.padEnd(24)} ${o.model} is not in ${o.endpoint}.models.default`);
  }
  if (offenders.length === 0) {
    console.green(`  all ${specs.length} specs resolve to a whitelisted model`);
  }

  console.purple('\n--- live requests ---');
  let failures = offenders.length;
  let skipped = 0;
  for (const spec of specs) {
    const { base, key } = resolveTarget(spec.preset.endpoint, customByName);
    /** Kept distinct from a failure: an unset key means this environment cannot
     *  answer the question, not that the model is broken. Conflating the two
     *  paints the whole run red on any machine missing the provider secrets,
     *  which is the fastest way to teach everyone to ignore this script. */
    if (!key) {
      skipped++;
      console.yellow(`  ${spec.name.padEnd(24)} skipped — no API key for ${spec.preset.endpoint}`);
      continue;
    }
    const result = await callModel({ base, key, model: spec.preset.model });
    const label = `  ${spec.name.padEnd(24)} ${spec.preset.model.padEnd(30)}`;
    if (result.ok) {
      console.green(`${label} ${result.detail}`);
      continue;
    }
    failures++;
    console.red(`${label} ${result.detail}`);
  }

  console.purple('\n----------------------------------------');
  if (failures > 0) {
    console.red(`${failures} problem(s) across ${specs.length} model(s).`);
    process.exit(1);
  }
  /** Still a non-zero exit: "could not check" is not "checked and fine", and a
   *  green run on a keyless machine would be a lie. */
  if (skipped > 0) {
    console.yellow(
      `\n  ${specs.length - skipped}/${specs.length} verified; ${skipped} skipped for missing keys.` +
        '\n  Provider keys live in Coolify, so a full run means running this inside' +
        '\n  the production container.',
    );
    process.exit(1);
  }
  console.green(`All ${specs.length} models answered.`);
  process.exit(0);
})();

process.on('uncaughtException', (err) => {
  console.error('There was an uncaught error:');
  console.error(err);
  process.exit(1);
});
