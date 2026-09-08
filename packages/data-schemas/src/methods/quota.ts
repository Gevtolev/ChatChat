import { spendableCredits } from '~/utils/credits';
import type { FilterQuery, Model, UpdateQuery } from 'mongoose';
import type { IQuota, IQuotaLean } from '~/types/quota';
import type { Types } from 'mongoose';

/**
 * The grant is monthly whatever the billing period: pro_q bills for 90 days but
 * still allots one month of credits at a time. Shared by the two functions that
 * would otherwise disagree — one arms the refill fields, the other decides when
 * a refill is due.
 */
const REFILL_INTERVAL = { value: 1, unit: 'months' } as const;

export function createQuotaMethods(mongoose: typeof import('mongoose')) {
  /**
   * Atomically increments messages_used by 1 if below limit.
   * Returns the updated doc on success, or null when the quota is exhausted.
   *
   * Uses a single findOneAndUpdate with a `messages_used < limit` filter so
   * MongoDB enforces the cap atomically — no read-then-write race.
   *
   * On duplicate-key (11000) from a concurrent upsert, retries once via an
   * update-only path (no upsert) to resolve the race without creating a dupe.
   */
  async function incrementQuota(args: {
    userId: Types.ObjectId;
    periodStart: Date;
    limit: number;
    /** Set only for the anonymous trial, so MongoDB collects this counter with
     *  the TTL-bound user it belongs to. `$setOnInsert`, so a later call in the
     *  same trial does not push the expiry out. */
    expiresAt?: Date;
  }): Promise<IQuotaLean | null> {
    const Quota = mongoose.models.Quota as Model<IQuota>;
    const now = new Date();

    const filter: FilterQuery<IQuota> = {
      user_id: args.userId,
      period_start: args.periodStart,
      messages_used: { $lt: args.limit },
    };
    const update: UpdateQuery<IQuota> = {
      $inc: { messages_used: 1 },
      $setOnInsert: {
        created_at: now,
        ...(args.expiresAt != null && { expiresAt: args.expiresAt }),
      },
      $set: { updated_at: now },
    };

    try {
      return await Quota.findOneAndUpdate(filter, update, {
        new: true,
        upsert: true,
      }).lean<IQuotaLean>();
    } catch (err: unknown) {
      const mongoErr = err as { code?: number };
      if (mongoErr.code !== 11000) {
        throw err;
      }
      // Concurrent upsert collision: retry once without upsert
      return Quota.findOneAndUpdate(
        filter,
        { $inc: { messages_used: 1 }, $set: { updated_at: now } },
        {
          new: true,
          upsert: false,
        },
      ).lean<IQuotaLean>();
    }
  }

  /** Resets messages_used to 0 for the given user + period. */
  async function resetQuota(args: {
    userId: Types.ObjectId;
    periodStart: Date;
  }): Promise<IQuotaLean | null> {
    const Quota = mongoose.models.Quota as Model<IQuota>;
    const filter: FilterQuery<IQuota> = {
      user_id: args.userId,
      period_start: args.periodStart,
    };
    const update: UpdateQuery<IQuota> = {
      $set: { messages_used: 0, updated_at: new Date() },
    };
    return Quota.findOneAndUpdate(filter, update, { new: true }).lean<IQuotaLean>();
  }

  /**
   * Remaining tokenCredits for a user, or `null` when no Balance row exists.
   *
   * Read-only on purpose: the gate calls this before a generation, while the
   * charge happens in `spendTokens` afterwards, once real token counts are
   * known. Callers must treat `null` as "no credits" rather than "unlimited" —
   * a user whose grant never landed should be asked to upgrade, not handed
   * free capacity.
   */
  async function getBalanceCredits(userId: Types.ObjectId): Promise<number | null> {
    const Balance = mongoose.models.Balance as Model<{
      user: Types.ObjectId;
      tokenCredits: number;
      purchasedCredits?: number;
    }>;
    const doc = await Balance.findOne({ user: userId })
      .select('tokenCredits purchasedCredits')
      .lean();
    return doc == null ? null : spendableCredits(doc);
  }

  /**
   * Resets the balance to the plan's grant if a full interval has passed, and
   * returns the spendable balance either way. `null` when no Balance row exists.
   *
   * Replaces a plain read in the gate because the monthly reset has nowhere else
   * to happen: upstream's refill lives in `checkBalance`, which `BaseClient`
   * only calls when `balanceConfig.enabled`, and we do not enable upstream's
   * balance system — doing so would run a second, parallel gate with its own
   * error codes alongside `checkBillingAccess`.
   *
   * Upstream's refill would also be the wrong shape. It increments by
   * `refillAmount` once the balance is nearly spent, whereas a subscription
   * sells a monthly allowance: the balance is *set*, so an unused month does not
   * roll over, and the reset is driven by the calendar rather than by running
   * out.
   *
   * One conditional pipeline update rather than read-then-write: the comparison
   * runs server-side, so two concurrent requests cannot both see a stale
   * `lastRefill` and grant twice.
   */
  async function refreshMonthlyGrant(args: {
    userId: Types.ObjectId;
    credits: number;
  }): Promise<number | null> {
    const Balance = mongoose.models.Balance as Model<Record<string, unknown>>;
    const now = new Date();
    const dueAt = new Date(now);
    dueAt.setMonth(dueAt.getMonth() - REFILL_INTERVAL.value);

    /** A row with no `lastRefill` sorts below any date here, so it refills —
     *  which is what we want for a grant that was armed without one. */
    const updated = await Balance.findOneAndUpdate(
      { user: args.userId, autoRefillEnabled: true },
      [
        {
          $set: {
            tokenCredits: {
              $cond: [{ $lte: ['$lastRefill', dueAt] }, args.credits, '$tokenCredits'],
            },
            lastRefill: {
              $cond: [{ $lte: ['$lastRefill', dueAt] }, now, '$lastRefill'],
            },
          },
        },
      ],
      { new: true },
    ).lean();

    if (updated != null) {
      return spendableCredits(updated as { tokenCredits?: number; purchasedCredits?: number });
    }
    /** No row, or auto-refill was never armed — fall back to a plain read so a
     *  manually-created balance is still honoured. */
    return getBalanceCredits(args.userId);
  }

  /**
   * Sets a user's balance to their plan's monthly grant and arms Balance's own
   * auto-refill to re-grant the same amount every month.
   *
   * `$set` rather than `$inc`: the subscription sells a monthly allowance, not
   * a stored balance, so an unused month must not carry over. Upserts, because
   * a user reaching their first plan change has no Balance row yet.
   */
  async function grantMonthlyCredits(args: {
    userId: Types.ObjectId;
    credits: number;
  }): Promise<void> {
    const Balance = mongoose.models.Balance as Model<Record<string, unknown>>;
    await Balance.updateOne(
      { user: args.userId },
      {
        $set: {
          tokenCredits: args.credits,
          autoRefillEnabled: true,
          refillIntervalValue: REFILL_INTERVAL.value,
          refillIntervalUnit: REFILL_INTERVAL.unit,
          refillAmount: args.credits,
          lastRefill: new Date(),
        },
      },
      { upsert: true },
    );
  }

  /**
   * Adds credits that do not expire at renewal.
   *
   * The single entry point for anything bought — a CLI top-up today, a Stripe
   * one-time payment later — so both land in the bucket `refreshMonthlyGrant`
   * leaves alone. Anything writing `tokenCredits` instead is granting credits
   * that vanish on the user's renewal date.
   *
   * `$inc` rather than read-then-write: two purchases racing must both land,
   * and there is no clamp to reason about since the amount is always positive.
   * Upserts, because a user can buy before their first grant has created a row.
   */
  async function grantPurchasedCredits(args: {
    userId: Types.ObjectId;
    credits: number;
  }): Promise<number> {
    if (!Number.isFinite(args.credits) || args.credits <= 0) {
      throw new Error(`[grantPurchasedCredits] credits must be positive, got ${args.credits}`);
    }
    const Balance = mongoose.models.Balance as Model<Record<string, unknown>>;
    const updated = await Balance.findOneAndUpdate(
      { user: args.userId },
      { $inc: { purchasedCredits: args.credits } },
      { new: true, upsert: true },
    ).lean();
    return ((updated?.purchasedCredits as number) ?? 0) as number;
  }

  return {
    incrementQuota,
    resetQuota,
    getBalanceCredits,
    refreshMonthlyGrant,
    grantMonthlyCredits,
    grantPurchasedCredits,
  };
}

export type QuotaMethods = ReturnType<typeof createQuotaMethods>;
