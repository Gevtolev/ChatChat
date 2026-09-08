import type { Model, Types } from 'mongoose';
import type { ISubscription } from '~/types/subscription';
import type { IQuota } from '~/types/quota';

export interface BillingRecordDeletion {
  subscriptions: number;
  quotas: number;
}

export function createBillingMethods(mongoose: typeof import('mongoose')) {
  /**
   * Removes every billing record belonging to a user.
   *
   * One call rather than a `deleteSubscriptions` and a `deleteQuotas`, because
   * the defect this exists to fix was a caller forgetting one of them. Three
   * separate deletion paths each enumerate the collections they clear —
   * `deleteUserController`, `config/delete-user.js`, and the admin handler —
   * and all three shipped without these two tables, which arrived later with
   * plan gating and were never added back. A user could delete their account,
   * be told every trace was gone, and leave a subscription behind; worse,
   * `config/backfill-plan-credits.js` scans active subscriptions and would
   * grant a fresh balance to the deleted account.
   *
   * The next billing table goes inside this function, not into three call
   * sites.
   */
  async function deleteBillingRecords(
    userId: string | Types.ObjectId,
  ): Promise<BillingRecordDeletion> {
    const Subscription = mongoose.models.Subscription as Model<ISubscription>;
    const Quota = mongoose.models.Quota as Model<IQuota>;

    const [subscriptions, quotas] = await Promise.all([
      Subscription.deleteMany({ user_id: userId }),
      Quota.deleteMany({ user_id: userId }),
    ]);

    return {
      subscriptions: subscriptions.deletedCount ?? 0,
      quotas: quotas.deletedCount ?? 0,
    };
  }

  return { deleteBillingRecords };
}

export type BillingMethods = ReturnType<typeof createBillingMethods>;
