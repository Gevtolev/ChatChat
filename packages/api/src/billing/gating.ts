import { logger } from '@librechat/data-schemas';
import type { Types } from 'mongoose';
import type { ISubscriptionLean, IQuotaLean } from '@librechat/data-schemas';
import { getActiveSubscription } from './applyPlanChange';
import { isEnabled } from '~/utils';
import { PLANS } from './plans';
import { getModelTier } from './modelRegistry';
import type { FeatureKey } from './modelRegistry';

export interface GatingDeps {
  getActiveSubscriptionRecord: (userId: Types.ObjectId) => Promise<ISubscriptionLean | null>;
  /** Returns the user's spendable tokenCredits, resetting them to the plan's
   *  grant first when a month has elapsed. It never *decrements*: the charge
   *  happens in `spendTokens` once the generation has finished and its real
   *  token counts are known, and a gate that also debited would bill every turn
   *  twice. */
  refreshMonthlyGrant: (args: {
    userId: Types.ObjectId;
    credits: number;
  }) => Promise<number | null>;
  /** Only used for `lifetime_message_limit` (the anonymous trial). Credit-metered
   *  plans never touch it. */
  incrementQuota: (args: {
    userId: Types.ObjectId;
    periodStart: Date;
    limit: number;
  }) => Promise<IQuotaLean | null>;
}

/** Fixed `period_start` for the never-resetting anonymous trial counter. */
const LIFETIME_EPOCH = new Date(0);

/**
 * Checks whether a user is allowed to use a model (and optional feature).
 *
 * Throws `Error(JSON.stringify({ code, ... }))` on denial — callers parse the
 * JSON payload to extract `code` and surface the right UI message.
 *
 * Three denial codes (lowercase, matching the future ErrorTypes enum values):
 *   - 'upgrade_required_model'  — model tier blocked by current plan
 *   - 'feature_not_available'   — feature flag disabled on current plan
 *   - 'upgrade_required_quota'  — message quota exhausted for the current period
 */
export async function checkBillingAccess(
  args: { userId: string | Types.ObjectId; modelId: string; featureFlag?: FeatureKey },
  deps: GatingDeps,
): Promise<void> {
  const userId =
    typeof args.userId === 'string' ? (args.userId as unknown as Types.ObjectId) : args.userId;

  const sub = await getActiveSubscription(userId, deps);

  /** A `plan_code` with no entry in `PLANS` used to read as `undefined` and
   *  throw on the next line — meaning every message that user sent returned a
   *  500, with nothing naming the cause. Retiring a plan code is what creates
   *  that row: the schema enum only constrains writes, so rows written before
   *  the code was removed survive and keep resolving to nothing. Replacing
   *  `pro_m`/`pro_q`/`pro_h` with the Plus/Pro/Max tiers was exactly that
   *  change, and it was safe only because those three had no rows.
   *
   *  Fall back to `free` rather than to the old crash: it matches what an
   *  account with no subscription at all already gets, and least privilege is
   *  the right default for a plan we cannot identify. Logged at warn because a
   *  user silently downgraded is a support ticket nobody can otherwise explain. */
  const plan = PLANS[sub.plan_code] ?? PLANS.free;
  if (PLANS[sub.plan_code] === undefined) {
    logger.warn(
      `[checkBillingAccess] unknown plan_code '${sub.plan_code}' for user ${String(userId)} — falling back to free`,
    );
  }

  /** Testing-phase escape hatch — flip DISABLE_BILLING_GATING off (or unset) to
   *  re-enable tier/quota enforcement before real launch. The anonymous free-trial
   *  cap is always enforced (independent of this flag) so unauthenticated visitors
   *  stay limited to their trial even while gating is otherwise disabled. */
  if (plan.code !== 'anonymous' && isEnabled(process.env.DISABLE_BILLING_GATING)) {
    return;
  }

  const tier = getModelTier(args.modelId);

  if (!plan.allowed_cost_tiers.includes(tier)) {
    throw new Error(
      JSON.stringify({
        code: 'upgrade_required_model',
        current_plan: plan.code,
        required_tier: tier,
      }),
    );
  }

  if (args.featureFlag !== undefined && !plan.features[args.featureFlag]) {
    throw new Error(JSON.stringify({ code: 'feature_not_available', feature: args.featureFlag }));
  }

  /** A message-count cap is a product rule, not a billing allowance: the
   *  anonymous visitor trial must hold even with billing gating disabled, and
   *  an anonymous visitor has no Balance row to draw against. Counted here,
   *  atomically, exactly as before. */
  if (plan.lifetime_message_limit > 0) {
    const q = await deps.incrementQuota({
      userId,
      periodStart: LIFETIME_EPOCH,
      limit: plan.lifetime_message_limit,
    });
    if (q === null) {
      throw new Error(
        JSON.stringify({
          code: 'upgrade_required_quota',
          used: plan.lifetime_message_limit,
          limit: plan.lifetime_message_limit,
        }),
      );
    }
  }

  /** Plans that grant credits are metered by balance. A missing Balance row
   *  reads as zero rather than as unlimited — a user whose grant never landed
   *  must be told to upgrade, not handed free capacity.
   *
   *  This is also where the monthly reset lands. Doing it on read means the
   *  allowance renews on the user's next request rather than on a cron tick, so
   *  there is no scheduler to run, and an account nobody uses costs no writes. */
  if (plan.monthly_token_credits > 0) {
    const credits =
      (await deps.refreshMonthlyGrant({
        userId,
        credits: plan.monthly_token_credits,
      })) ?? 0;
    if (credits <= 0) {
      throw new Error(
        JSON.stringify({
          code: 'upgrade_required_quota',
          used: plan.monthly_token_credits,
          limit: plan.monthly_token_credits,
        }),
      );
    }
  }
}
