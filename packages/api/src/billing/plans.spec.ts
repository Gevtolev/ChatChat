import { PLANS } from './plans';

const CODES = ['free', 'trial', 'pro_m', 'pro_q', 'pro_h'] as const;

describe('PLANS', () => {
  test('every PlanCode has a config with matching code', () => {
    for (const code of CODES) {
      expect(PLANS[code]).toBeDefined();
      expect(PLANS[code].code).toBe(code);
    }
  });
  test('anonymous grants no credits — its trial is enforced separately', () => {
    /** The 3-message anonymous trial is not a billing quota: it is gated by the
     *  anonymous-trial mechanism, which must stay in force even when billing
     *  gating is disabled. Granting credits here would double-gate it. */
    expect(PLANS.anonymous.monthly_token_credits).toBe(0);
    expect(PLANS.anonymous.features.image_gen).toBe(false);
    expect(PLANS.anonymous.features.agents).toBe(false);
  });
  test('free only allows cheap tier and a small credit grant', () => {
    expect(PLANS.free.allowed_cost_tiers).toEqual(['cheap']);
    expect(PLANS.free.monthly_token_credits).toBeGreaterThan(0);
    expect(PLANS.free.features.image_gen).toBe(false);
  });
  test('pro plans allow all tiers + all features and grant far more credits than free', () => {
    for (const code of ['pro_m', 'pro_q', 'pro_h'] as const) {
      expect(PLANS[code].allowed_cost_tiers).toEqual(['cheap', 'mid', 'expensive']);
      expect(PLANS[code].monthly_token_credits).toBeGreaterThan(
        PLANS.free.monthly_token_credits * 10,
      );
      expect(Object.values(PLANS[code].features).every(Boolean)).toBe(true);
    }
  });
});
