/** Note: No hard-coded rate values should be used in this file. Every assertion
 *  derives from the tables themselves, so adding a model needs no test edit. */
import { matchModelName, findMatchingPattern } from './test-helpers';
import { chatchatValues, chatchatCacheValues, chatchatNoCacheModels } from './chatchat';
import { createTxMethods, tokenValues, defaultRate } from './tx';

const { getValueKey, getMultiplier, getCacheMultiplier } = createTxMethods(
  {} as typeof import('mongoose'),
  { matchModelName, findMatchingPattern },
);

const ourModels = Object.keys(chatchatValues);

/** Models whose upstream resolution must not change when our keys are added. */
const upstreamOwned = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-3.1-pro-preview',
  'gpt-5.4',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5-20251101',
  'claude-sonnet-4-6',
  'claude-sonnet-4-6-thinking',
  'claude-haiku-4-5-20251001',
  'grok-4-1-fast-non-reasoning',
];

describe('chatchatValues — exact-match priority', () => {
  it.each(ourModels)('resolves %s to its own entry, not an upstream prefix', (model) => {
    expect(getValueKey(model)).toBe(model);
  });

  it.each(ourModels)('bills %s at our rate for both token types', (model) => {
    const entry = chatchatValues[model];
    expect(getMultiplier({ model, tokenType: 'prompt' })).toBe(entry.prompt);
    expect(getMultiplier({ model, tokenType: 'completion' })).toBe(entry.completion);
  });

  it.each(ourModels)('never falls back to defaultRate for %s', (model) => {
    /** defaultRate is a flat value for both token types; a model landing on it
     *  reports the same number twice, which no real model does. */
    const prompt = getMultiplier({ model, tokenType: 'prompt' });
    const completion = getMultiplier({ model, tokenType: 'completion' });
    expect(prompt === defaultRate && completion === defaultRate).toBe(false);
  });
});

describe('chatchatValues — no regression on upstream-owned models', () => {
  it.each(upstreamOwned)('leaves %s resolving to an upstream key', (model) => {
    const key = getValueKey(model);
    expect(key).toBeDefined();
    expect(ourModels).not.toContain(key);
  });

  it.each(upstreamOwned)('keeps %s off defaultRate', (model) => {
    const prompt = getMultiplier({ model, tokenType: 'prompt' });
    const completion = getMultiplier({ model, tokenType: 'completion' });
    expect(prompt === defaultRate && completion === defaultRate).toBe(false);
  });
});

describe('chatchatValues — unit sanity', () => {
  /** Rates are USD per 1M tokens. A value outside this band almost always means
   *  a per-token figure was pasted without the 1e6 conversion, or vice versa. */
  it.each(ourModels)('%s has both rates positive and within 0.01–200', (model) => {
    const { prompt, completion } = chatchatValues[model];
    expect(prompt).toBeGreaterThan(0.01);
    expect(prompt).toBeLessThan(200);
    expect(completion).toBeGreaterThan(0.01);
    expect(completion).toBeLessThan(200);
  });

  it('does not shadow an upstream key with an identical name', () => {
    /** A duplicate key would silently win via Object.assign, making the override
     *  invisible in a diff of this file alone. */
    const upstreamKeys = new Set(Object.keys(tokenValues));
    const shadowed = ourModels.filter((m) => upstreamKeys.has(m) && !(m in chatchatValues));
    expect(shadowed).toEqual([]);
  });
});

describe('chatchatCacheValues', () => {
  const cacheModels = Object.keys(chatchatCacheValues);

  it.each(cacheModels)('applies our write and read rates to %s', (model) => {
    const entry = chatchatCacheValues[model];
    expect(getCacheMultiplier({ model, cacheType: 'write' })).toBe(entry.write);
    expect(getCacheMultiplier({ model, cacheType: 'read' })).toBe(entry.read);
  });

  it.each(cacheModels)('never prices a cache read above input for %s', (model) => {
    /** Catches a write/read field swap: a cache read is never more expensive
     *  than reading the same tokens fresh. */
    const input = getMultiplier({ model, tokenType: 'prompt' });
    expect(chatchatCacheValues[model].read).toBeLessThanOrEqual(input);
  });

  it.each(cacheModels)('prices %s cache write at or above its read rate', (model) => {
    const { write, read } = chatchatCacheValues[model];
    expect(write).toBeGreaterThanOrEqual(read);
  });

  it('covers every base-rate model that supports caching', () => {
    /** A model priced for tokens but silently missing from the cache table bills
     *  its cached reads at full input rate. The only permitted absences are the
     *  ones declared in chatchatNoCacheModels, so a forgotten entry cannot hide
     *  as intent.
     *
     *  One-directional on purpose: the cache table may legitimately hold models
     *  absent from chatchatValues, because a model can have a correct upstream
     *  base rate and still lack a cache entry. Asserting set equality would tie
     *  two independent concerns together and hide exactly that case. */
    const mustHaveCache = ourModels.filter((m) => !chatchatNoCacheModels.includes(m));
    expect(cacheModels).toEqual(expect.arrayContaining(mustHaveCache));
  });

  it.each([...chatchatNoCacheModels])('resolves %s cache lookups to null', (model) => {
    /** null is not a gap: calculateStructuredTokenValue reads it as
     *  `?? inputMultiplier`, charging cache tokens at the full input rate —
     *  correct for a model that cannot cache, and self-updating if that rate
     *  changes. An explicit entry here would duplicate the input rate and rot. */
    expect(getCacheMultiplier({ model, cacheType: 'read' })).toBeNull();
    expect(getCacheMultiplier({ model, cacheType: 'write' })).toBeNull();
  });
});
