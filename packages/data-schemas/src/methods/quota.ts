import type { FilterQuery, Model, UpdateQuery } from 'mongoose';
import type { IQuota, IQuotaLean } from '~/types/quota';
import type { Types } from 'mongoose';

export function createQuotaMethods(mongoose: typeof import('mongoose')) {
  /** Creates a new quota record for a user + period. */
  async function createQuota(args: {
    userId: Types.ObjectId;
    periodStart: Date;
  }): Promise<IQuotaLean> {
    const Quota = mongoose.models.Quota as Model<IQuota>;
    const now = new Date();
    const doc = await Quota.create({
      user_id: args.userId,
      period_start: args.periodStart,
      messages_used: 0,
      created_at: now,
      updated_at: now,
    });
    return doc.toObject() as IQuotaLean;
  }

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
      $setOnInsert: { created_at: now },
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
    }>;
    const doc = await Balance.findOne({ user: userId }).select('tokenCredits').lean();
    return doc == null ? null : (doc.tokenCredits ?? 0);
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
          refillIntervalValue: 1,
          refillIntervalUnit: 'months',
          refillAmount: args.credits,
          lastRefill: new Date(),
        },
      },
      { upsert: true },
    );
  }

  return {
    createQuota,
    incrementQuota,
    resetQuota,
    getBalanceCredits,
    grantMonthlyCredits,
  };
}

export type QuotaMethods = ReturnType<typeof createQuotaMethods>;
