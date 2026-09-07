import { isMeteringEnabled } from './metering';

/** Passed explicitly rather than mutated on `process.env`, so a case cannot
 *  leak into the next one. */
const env = (value?: string): NodeJS.ProcessEnv =>
  value === undefined ? {} : { DISABLE_BILLING_GATING: value };

describe('isMeteringEnabled', () => {
  test('meters by default — the flag is opt-out', () => {
    expect(isMeteringEnabled(undefined, env())).toBe(true);
  });

  test('does not meter when billing gating is disabled', () => {
    expect(isMeteringEnabled(undefined, env('true'))).toBe(false);
  });

  /** Parsing has to match `isEnabled`, which the gate uses. An earlier version
   *  diverged on both of these: `'1'` enforced without metering, and `'true '`
   *  metered without enforcing — in each case the user was charged under one
   *  rule and refused under another. */
  test.each(['TRUE', 'True', ' true ', 'true\n'])('treats %j as disabled, like isEnabled', (v) => {
    expect(isMeteringEnabled(undefined, env(v))).toBe(false);
  });

  test.each(['1', 'yes', 'on', 'false', ''])('treats %j as enabled, like isEnabled', (v) => {
    expect(isMeteringEnabled(undefined, env(v))).toBe(true);
  });

  /** Upstream's own flag still forces metering on, so a deployment that turns
   *  on the balance feature is never silently unmetered. */
  test('upstream balance.enabled overrides the disable flag', () => {
    expect(isMeteringEnabled({ enabled: true }, env('true'))).toBe(true);
  });

  test('upstream balance.enabled false does not by itself disable metering', () => {
    expect(isMeteringEnabled({ enabled: false }, env())).toBe(true);
  });
});
