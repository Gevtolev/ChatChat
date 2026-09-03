import { logger } from '@librechat/data-schemas';
import { CREDIT_DISPLAY_DIVISOR } from 'librechat-data-provider';
import type { CostTier, PlanCode } from 'librechat-data-provider';
import type { ISubscriptionLean } from '@librechat/data-schemas';
import type { Types } from 'mongoose';
import { getActiveSubscription } from './applyPlanChange';
import { PLANS } from './plans';

export interface EntitlementsDeps {
  getActiveSubscriptionRecord: (userId: Types.ObjectId) => Promise<ISubscriptionLean | null>;
  findBalanceByUser: (userId: string) => Promise<{ tokenCredits?: number } | null>;
}

export interface Entitlements {
  plan: {
    code: PlanCode;
    name: string;
    allowedCostTiers: CostTier[];
    features: (typeof PLANS)[PlanCode]['features'];
  };
  /** Null for plans that grant no credits — the anonymous tier, whose limit is
   *  a message count rather than an allowance. A zero would read as "spent". */
  credits: {
    remaining: number;
    granted: number;
    /** Sent rather than hard-coded in the client so the two cannot drift. */
    displayDivisor: number;
  } | null;
  periodEnd: string | null;
}

/**
 * What the signed-in user is allowed to do and how much of their allowance is
 * left — the read-side counterpart to `checkBillingAccess`.
 *
 * It exists because the client had no way to know either. The model picker
 * offered every model to everyone and only surfaced a plan restriction once the
 * message had been sent and refused, which is the worst possible moment: a new
 * free signup picks the most impressive model on the list and the product's
 * first reply is an error. Upstream's Settings > Balance tab is no help, since
 * it is gated on `balance.enabled` and we deliberately never enable upstream's
 * balance system (see `applyPlanChange`).
 *
 * Deliberately mirrors `checkBillingAccess`'s two fallbacks rather than
 * inventing its own, so the picker cannot disagree with the gate about what is
 * allowed: no subscription reads as `free`, and a `plan_code` with no entry in
 * `PLANS` — what retiring a plan leaves behind — reads as `free` too.
 */
export async function getEntitlements(
  userId: Types.ObjectId,
  deps: EntitlementsDeps,
): Promise<Entitlements> {
  const sub = await getActiveSubscription(userId, deps);
  const plan = PLANS[sub.plan_code] ?? PLANS.free;
  if (PLANS[sub.plan_code] === undefined) {
    logger.warn(
      `[getEntitlements] unknown plan_code '${sub.plan_code}' for user ${String(userId)} — reporting free`,
    );
  }

  const granted = plan.monthly_token_credits;
  let credits: Entitlements['credits'] = null;

  if (granted > 0) {
    const balance = await deps.findBalanceByUser(String(userId));
    /** A missing Balance row reads as zero, matching the gate — a user whose
     *  grant never landed must be shown nothing left, not unlimited. */
    credits = {
      remaining: Math.max(0, balance?.tokenCredits ?? 0),
      granted,
      displayDivisor: CREDIT_DISPLAY_DIVISOR,
    };
  }

  const periodEnd =
    sub.current_period_end instanceof Date
      ? sub.current_period_end.toISOString()
      : (sub.current_period_end ?? null);

  return {
    plan: {
      code: plan.code,
      name: plan.name,
      allowedCostTiers: plan.allowed_cost_tiers,
      features: plan.features,
    },
    credits,
    periodEnd: periodEnd as string | null,
  };
}
