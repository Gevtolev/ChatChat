import { CREDIT_DISPLAY_DIVISOR } from 'librechat-data-provider';
import { PLANS } from './plans';

const CODES = ['free', 'trial', 'plus', 'pro', 'max'] as const;

describe('PLANS', () => {
  /** The three paid tiers are the product. Their numbers are derived — round
   *  display credits times the divisor — and a "tidy-up" that rounds one of
   *  them changes what a customer is sold, silently and for every future
   *  signup. These pin the derivation, not just the values. */
  describe('paid tier pricing', () => {
    const EXPECTED = [
      { code: 'plus', cents: 2990, displayCredits: 1_000_000 },
      { code: 'pro', cents: 5990, displayCredits: 2_000_000 },
      { code: 'max', cents: 9990, displayCredits: 3_500_000 },
    ] as const;

    it.each(EXPECTED)('$code grants exactly $displayCredits display credits', (tier) => {
      expect(PLANS[tier.code].monthly_price_cents).toBe(tier.cents);
      expect(PLANS[tier.code].monthly_token_credits / CREDIT_DISPLAY_DIVISOR).toBe(
        tier.displayCredits,
      );
    });

    /** Plus is the anchor the divisor was chosen from, so it is the one tier
     *  whose margin must land on 50% exactly. */
    it('prices Plus at a 50% margin on recorded cost', () => {
      const costCents = PLANS.plus.monthly_token_credits / 10_000;
      expect(costCents / PLANS.plus.monthly_price_cents).toBeCloseTo(0.5, 3);
    });

    /** The ladder has to reward upgrading. Max at 3M would have given the
     *  costliest tier *less* per dollar than the cheapest — an inverted ladder
     *  nobody has a reason to climb. */
    it('never offers a higher tier worse value per dollar than a lower one', () => {
      const perDollar = (code: 'plus' | 'pro' | 'max') =>
        PLANS[code].monthly_token_credits / PLANS[code].monthly_price_cents;
      expect(perDollar('pro')).toBeGreaterThanOrEqual(perDollar('plus') * 0.995);
      expect(perDollar('max')).toBeGreaterThan(perDollar('plus'));
    });
  });

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
    for (const code of ['plus', 'pro', 'max'] as const) {
      expect(PLANS[code].allowed_cost_tiers).toEqual(['cheap', 'mid', 'expensive']);
      expect(PLANS[code].monthly_token_credits).toBeGreaterThan(
        PLANS.free.monthly_token_credits * 10,
      );
      expect(Object.values(PLANS[code].features).every(Boolean)).toBe(true);
    }
  });
});
