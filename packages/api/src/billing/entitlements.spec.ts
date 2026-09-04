import { Types } from 'mongoose';
import { CREDIT_DISPLAY_DIVISOR } from 'librechat-data-provider';
import type { EntitlementsDeps } from './entitlements';
import { getEntitlements } from './entitlements';
import { PLANS } from './plans';

const userId = new Types.ObjectId();

function deps(overrides: Partial<EntitlementsDeps> = {}): EntitlementsDeps {
  return {
    getActiveSubscriptionRecord: jest.fn().mockResolvedValue(null),
    findBalanceByUser: jest.fn().mockResolvedValue(null),
    ...overrides,
  } as EntitlementsDeps;
}

const subscription = (plan_code: string) =>
  jest.fn().mockResolvedValue({
    user_id: userId,
    plan_code,
    status: 'active',
    current_period_end: new Date('2026-10-01T00:00:00.000Z'),
  });

describe('getEntitlements', () => {
  it('reports the plan and its allowed tiers', async () => {
    const result = await getEntitlements(userId, {
      ...deps({ getActiveSubscriptionRecord: subscription('plus') }),
      findBalanceByUser: jest.fn().mockResolvedValue({ tokenCredits: 7_000_000 }),
    });

    expect(result.plan.code).toBe('plus');
    expect(result.plan.name).toBe('Plus');
    expect(result.plan.allowedCostTiers).toEqual(PLANS.plus.allowed_cost_tiers);
    expect(result.credits).toEqual({
      remaining: 7_000_000,
      granted: PLANS.plus.monthly_token_credits,
      displayDivisor: CREDIT_DISPLAY_DIVISOR,
    });
    expect(result.periodEnd).toBe('2026-10-01T00:00:00.000Z');
  });

  /** Must agree with `checkBillingAccess`, which reads a missing Balance as
   *  zero. Reporting the grant instead would show a full bar to an account the
   *  gate is about to refuse. */
  it('reports zero remaining when the balance row is missing', async () => {
    const result = await getEntitlements(
      userId,
      deps({ getActiveSubscriptionRecord: subscription('pro') }),
    );

    expect(result.credits?.remaining).toBe(0);
    expect(result.credits?.granted).toBe(PLANS.pro.monthly_token_credits);
  });

  it('falls back to free when the account has no subscription', async () => {
    const result = await getEntitlements(userId, deps());

    expect(result.plan.code).toBe('free');
    expect(result.plan.allowedCostTiers).toEqual(['cheap']);
  });

  /** The row a retired plan leaves behind — the schema enum only constrains
   *  writes. The gate resolves these to `free`, so this must too, or the picker
   *  would offer models the gate then refuses. */
  it('falls back to free when the plan_code is no longer defined', async () => {
    const result = await getEntitlements(
      userId,
      deps({ getActiveSubscriptionRecord: subscription('pro_q') }),
    );

    expect(result.plan.code).toBe('free');
  });

  /** Anonymous grants no credits — its cap is a message count. A zeroed credit
   *  object would render as an exhausted allowance rather than none. */
  it('reports null credits for a plan that grants none', async () => {
    const result = await getEntitlements(
      userId,
      deps({ getActiveSubscriptionRecord: subscription('anonymous') }),
    );

    expect(result.plan.code).toBe('anonymous');
    expect(result.credits).toBeNull();
  });
});
