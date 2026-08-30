import type { Types } from 'mongoose';
import type { PlanCode, PlanChangeSource, SubStatus } from 'librechat-data-provider';
import type { ISubscriptionLean, IQuotaLean } from '@librechat/data-schemas';
import { PLANS } from './plans';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface PlanChangeArgs {
  user_id: Types.ObjectId;
  plan_code: PlanCode;
  source: PlanChangeSource;
  /** Defaults by plan_code: pro_m=30, pro_q=90, pro_h=180, trial=7, free=30 */
  period_days?: number;
  /** Stage 6: Stripe subscription id for idempotency */
  external_ref?: string;
  granted_by?: Types.ObjectId;
  metadata?: Record<string, string>;
}

export interface PlanChangeResult {
  subscription: ISubscriptionLean;
  quota: IQuotaLean;
  previous_plan: PlanCode | null;
}

// ---------------------------------------------------------------------------
// Dependency injection interface
// ---------------------------------------------------------------------------

export interface PlanChangeDeps {
  getActiveSubscriptionRecord: (userId: Types.ObjectId) => Promise<ISubscriptionLean | null>;
  expireActiveSubscriptions: (userId: Types.ObjectId) => Promise<unknown>;
  /** Sets the balance to the plan's grant and arms monthly auto-refill. Sets
   *  rather than increments, so an unused month does not carry over. */
  grantMonthlyCredits: (args: { userId: Types.ObjectId; credits: number }) => Promise<unknown>;
  createSubscription: (args: {
    userId: Types.ObjectId;
    planCode: PlanCode;
    status: SubStatus;
    source: PlanChangeSource;
    periodStart: Date;
    periodEnd: Date;
    externalRef?: string | null;
    grantedBy?: Types.ObjectId | null;
    metadata?: Record<string, string>;
  }) => Promise<ISubscriptionLean>;
  createQuota: (args: { userId: Types.ObjectId; periodStart: Date }) => Promise<IQuotaLean>;
}

// ---------------------------------------------------------------------------
// Period-days defaults per plan_code
// ---------------------------------------------------------------------------

/** 各档订阅周期天数。成本看板用它把周期总价折算成 30 天口径的收入。 */
export const PERIOD_DAYS: Record<PlanCode, number> = {
  pro_m: 30,
  pro_q: 90,
  pro_h: 180,
  trial: 7,
  free: 30,
  anonymous: 30,
  beta: 30,
};

// ---------------------------------------------------------------------------
// SYSTEM_DEFAULT_FREE_SUBSCRIPTION
// Returns a new object each call so period dates stay fresh relative to now.
// ---------------------------------------------------------------------------

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 1);
}

/** In-memory constant representing an implicit free plan — never persisted. */
export function SYSTEM_DEFAULT_FREE_SUBSCRIPTION(): Omit<
  ISubscriptionLean,
  '_id' | 'user_id' | 'granted_by' | 'external_ref' | 'created_at' | 'updated_at' | '__v'
> & {
  plan_code: 'free';
  source: 'system_default';
} {
  const now = new Date();
  return {
    plan_code: 'free',
    status: 'active',
    source: 'system_default',
    current_period_start: startOfMonth(now),
    current_period_end: endOfMonth(now),
    metadata: {},
  };
}

// ---------------------------------------------------------------------------
// getActiveSubscription
// Returns the real active record if one exists, else SYSTEM_DEFAULT_FREE.
// ---------------------------------------------------------------------------

export async function getActiveSubscription(
  userId: Types.ObjectId,
  deps: Pick<PlanChangeDeps, 'getActiveSubscriptionRecord'>,
): Promise<ISubscriptionLean | ReturnType<typeof SYSTEM_DEFAULT_FREE_SUBSCRIPTION>> {
  const record = await deps.getActiveSubscriptionRecord(userId);
  if (record) {
    return record;
  }
  return SYSTEM_DEFAULT_FREE_SUBSCRIPTION();
}

// ---------------------------------------------------------------------------
// applyPlanChange — the ONLY subscription-change entry point
// ---------------------------------------------------------------------------

/**
 * Atomically replaces a user's active subscription with a new one.
 *
 * Design note: `deps` is injected by the api/-layer caller rather than
 * calling mongoose models directly. This is a deliberate deviation from the
 * spec §4.1 no-deps signature to preserve the packages/api architectural
 * constraint that this package never imports mongoose models directly.
 */
export async function applyPlanChange(
  args: PlanChangeArgs,
  deps: PlanChangeDeps,
): Promise<PlanChangeResult> {
  const { user_id, plan_code, source, external_ref, granted_by, metadata } = args;

  // §4.3 idempotency guard: if external_ref is provided and a subscription
  // already exists with this ref, return no-op (MVP admin path never sends it).
  // Skipped for now — a future Stripe integration can add a proper lookup here.

  const periodDays = args.period_days ?? PERIOD_DAYS[plan_code];
  const now = new Date();
  const periodStart = now;
  const periodEnd = new Date(now.getTime() + periodDays * 24 * 60 * 60 * 1000);

  // Step 1: Get current active subscription (to record previous_plan)
  const current = await deps.getActiveSubscriptionRecord(user_id);
  const previous_plan: PlanCode | null = current ? current.plan_code : null;

  // Step 2: Expire existing active subscription if one exists
  if (current !== null) {
    await deps.expireActiveSubscriptions(user_id);
  }

  // Step 3: Create new subscription
  const subscription = await deps.createSubscription({
    userId: user_id,
    planCode: plan_code,
    status: source === 'admin' ? 'admin_granted' : 'active',
    source,
    periodStart,
    periodEnd,
    externalRef: external_ref ?? null,
    grantedBy: granted_by ?? null,
    metadata: metadata ?? {},
  });

  // Step 4: Create zeroed quota aligned to the new subscription period
  const quota = await deps.createQuota({
    userId: user_id,
    periodStart,
  });

  /**
   * Step 5: Grant the plan's monthly credits and arm Balance's own auto-refill.
   *
   * Monthly reset rides on Balance rather than on a quota period: `spendTokens`
   * already draws down `tokenCredits` after every generation. Setting the
   * balance outright (rather than incrementing) is what makes the grant
   * non-cumulative — an unused month does not roll over, which is the
   * subscription semantics we sell.
   *
   * The renewal itself is `refreshMonthlyGrant`, called by the gate on the
   * user's next request. This comment used to claim Balance's own refill
   * machinery handled it "without a cron job", which was wrong in a way worth
   * naming: that machinery lives in upstream's `checkBalance`, which
   * `BaseClient` only invokes when `balanceConfig.enabled`, and we never enable
   * upstream's balance system. Nothing renewed anything.
   */
  const credits = PLANS[plan_code].monthly_token_credits;
  if (credits > 0) {
    await deps.grantMonthlyCredits({ userId: user_id, credits });
  }

  // TODO(stage5): emit plan_changed PostHog event { from: previous_plan, to: plan_code, source }

  return { subscription, quota, previous_plan };
}

// Re-export PLANS for convenience (callers need period_days defaults)
export { PLANS };
