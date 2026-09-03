import { logger } from '@librechat/data-schemas';
import type { UsageAggregate } from '@librechat/data-schemas';
import type { AdminUsageUserRow, AdminUsageResponse, PlanCode } from 'librechat-data-provider';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { PERIOD_DAYS } from '~/billing/applyPlanChange';
import { PLANS } from '~/billing/plans';

/** 1 cent = 10 000 tokenCredits (a tokenCredit is one micro-dollar). */
const CREDITS_PER_CENT = 10_000;

/** 收入一律折算到 30 天口径。三个付费档目前都是月付，所以这步是恒等式；保留
 *  它是因为 `monthly_price_cents` 存的其实是**周期总价**，加年付档的那天不折算
 *  就会把年付用户的收入高估十二倍。旧的 pro_q/pro_h（90/180 天）正是这个坑。 */
function monthlyRevenueCredits(planCode: string): number | null {
  const plan = PLANS[planCode as PlanCode];
  if (plan === undefined) {
    return null;
  }
  const periodDays = PERIOD_DAYS[planCode as PlanCode];
  return Math.round((plan.monthly_price_cents * 30 * CREDITS_PER_CENT) / periodDays);
}

export interface AdminUsageDeps {
  aggregateUsage: (args: { from: Date; to: Date }) => Promise<UsageAggregate>;
  findActiveSubscriptions: (
    userIds: string[],
  ) => Promise<Array<{ user_id: string; plan_code: string }>>;
  findUserEmails: (userIds: string[]) => Promise<Array<{ _id: string; email: string | null }>>;
}

function parseRange(query: ServerRequest['query']): { from: Date; to: Date } | null {
  const rawFrom = query.from;
  const rawTo = query.to;
  if (typeof rawFrom !== 'string' || typeof rawTo !== 'string') {
    return null;
  }
  const from = new Date(rawFrom);
  const to = new Date(rawTo);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    return null;
  }
  return { from, to };
}

export function createAdminUsageHandlers(deps: AdminUsageDeps) {
  async function getUsage(req: ServerRequest, res: Response): Promise<void> {
    const range = parseRange(req.query);
    if (range === null) {
      res.status(400).json({ error: 'from and to must be valid ISO dates with from <= to' });
      return;
    }

    try {
      const aggregate = await deps.aggregateUsage(range);
      const userIds = aggregate.byUser.map((row) => row.user_id);

      /** Both lookups are keyed off the same id list and neither depends on the
       *  other, so they run together rather than in sequence. */
      const [subscriptions, users] = await Promise.all([
        userIds.length > 0 ? deps.findActiveSubscriptions(userIds) : Promise.resolve([]),
        userIds.length > 0 ? deps.findUserEmails(userIds) : Promise.resolve([]),
      ]);

      const planByUser = new Map(subscriptions.map((sub) => [sub.user_id, sub.plan_code]));
      const emailByUser = new Map(users.map((user) => [user._id, user.email]));

      const rows: AdminUsageUserRow[] = aggregate.byUser.map((row) => {
        const planCode = planByUser.get(row.user_id) ?? null;
        /** No subscription record means the implicit free plan, which grants no
         *  revenue — that is a known state, not an anomaly. */
        const revenue = planCode === null ? 0 : monthlyRevenueCredits(planCode);
        const recognized = revenue !== null;
        const revenueCredits = revenue ?? 0;

        return {
          user_id: row.user_id,
          email: emailByUser.get(row.user_id) ?? null,
          plan_code: planCode,
          plan_recognized: recognized,
          cost_credits: row.credits,
          revenue_credits: revenueCredits,
          margin_credits: revenueCredits - row.credits,
          calls: row.calls,
          model_count: row.models.length,
        };
      });

      const payload: AdminUsageResponse = {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        users: rows,
        models: aggregate.byModel.map((row) => ({
          model: row.model,
          context: row.context,
          cost_credits: row.credits,
          calls: row.calls,
          input_tokens: row.input_tokens,
          write_tokens: row.write_tokens,
          read_tokens: row.read_tokens,
        })),
        days: aggregate.byDay.map((row) => ({ day: row.day, cost_credits: row.credits })),
      };

      res.status(200).json(payload);
    } catch (error) {
      logger.error('[admin/usage] aggregation failed', error);
      res.status(500).json({ error: 'Failed to aggregate usage' });
    }
  }

  return { getUsage };
}
