import type { PlanChangeDeps } from './applyPlanChange';
import type { GatingDeps } from './gating';

/**
 * The slice of `~/models` (the `createMethods` output) that the billing entry
 * points draw on.
 *
 * Every billing caller lives in `/api`, which is plain JS and therefore gets no
 * compile-time check that the `deps` object it hand-assembles is complete. Four
 * such call sites had each silently dropped a required method — the gate lost
 * `getBalanceCredits`, three plan-change callers lost `grantMonthlyCredits` —
 * and the omissions only surfaced as a `TypeError` on the first request that
 * reached the missing branch. The unit tests missed all four because they build
 * their own complete `deps` and so exercise the TypeScript function rather than
 * its JavaScript callers.
 *
 * Routing every caller through these factories moves that failure back to
 * compile time: the return annotations below are the interfaces themselves, so
 * dropping a key stops the build here, at the single place it is written.
 */
export type BillingDbMethods = GatingDeps & PlanChangeDeps;

export function buildGatingDeps(db: BillingDbMethods): GatingDeps {
  return {
    getActiveSubscriptionRecord: db.getActiveSubscriptionRecord,
    refreshMonthlyGrant: db.refreshMonthlyGrant,
    incrementQuota: db.incrementQuota,
  };
}

export function buildPlanChangeDeps(db: BillingDbMethods): PlanChangeDeps {
  return {
    getActiveSubscriptionRecord: db.getActiveSubscriptionRecord,
    expireActiveSubscriptions: db.expireActiveSubscriptions,
    grantMonthlyCredits: db.grantMonthlyCredits,
    createSubscription: db.createSubscription,
    createQuota: db.createQuota,
  };
}
