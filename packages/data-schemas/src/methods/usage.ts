import type { Model, PipelineStage, Types } from 'mongoose';
import type { ITransaction } from '~/schema/transaction';

export interface UsageByUser {
  user_id: string;
  credits: number;
  calls: number;
  models: string[];
}

export interface UsageByModel {
  model: string;
  context: string;
  credits: number;
  calls: number;
  input_tokens: number;
  write_tokens: number;
  read_tokens: number;
}

export interface UsageByDay {
  day: string;
  credits: number;
}

export interface UsageAggregate {
  byUser: UsageByUser[];
  byModel: UsageByModel[];
  byDay: UsageByDay[];
}

interface RawUserRow {
  _id: Types.ObjectId;
  credits: number;
  calls: number;
  models: (string | null)[];
}

interface RawModelRow {
  _id: { model: string | null; context: string | null };
  credits: number;
  calls: number;
  input_tokens: number;
  write_tokens: number;
  read_tokens: number;
}

interface RawDayRow {
  _id: string;
  credits: number;
}

/** Spends are stored negative; every sum is taken through $abs so callers never
 *  have to remember the sign convention. */
const absField = (field: string) => ({ $abs: { $ifNull: [field, 0] } });

export function createUsageMethods(mongoose: typeof import('mongoose')) {
  /**
   * Aggregates Transaction spend over a date range into three views in a single
   * round trip. A `$facet` is used rather than three queries because all three
   * share one `$match` — separate queries would scan the same documents thrice.
   */
  async function aggregateUsage(args: { from: Date; to: Date }): Promise<UsageAggregate> {
    const Transaction = mongoose.models.Transaction as Model<ITransaction>;

    const pipeline: PipelineStage[] = [
      { $match: { createdAt: { $gte: args.from, $lte: args.to } } },
      {
        $facet: {
          byUser: [
            {
              $group: {
                _id: '$user',
                credits: { $sum: absField('$tokenValue') },
                calls: { $sum: 1 },
                models: { $addToSet: '$model' },
              },
            },
            { $sort: { credits: -1 } },
          ],
          byModel: [
            {
              $group: {
                _id: { model: '$model', context: '$context' },
                credits: { $sum: absField('$tokenValue') },
                calls: { $sum: 1 },
                input_tokens: { $sum: absField('$inputTokens') },
                write_tokens: { $sum: absField('$writeTokens') },
                read_tokens: { $sum: absField('$readTokens') },
              },
            },
            { $sort: { credits: -1 } },
          ],
          byDay: [
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
                credits: { $sum: absField('$tokenValue') },
              },
            },
            { $sort: { _id: 1 } },
          ],
        },
      },
    ];

    const [facet] = await Transaction.aggregate<{
      byUser: RawUserRow[];
      byModel: RawModelRow[];
      byDay: RawDayRow[];
    }>(pipeline);

    return {
      byUser: (facet?.byUser ?? []).map((row) => ({
        user_id: String(row._id),
        credits: row.credits,
        calls: row.calls,
        models: row.models.filter((model): model is string => typeof model === 'string'),
      })),
      byModel: (facet?.byModel ?? []).map((row) => ({
        model: row._id.model ?? 'unknown',
        context: row._id.context ?? 'unknown',
        credits: row.credits,
        calls: row.calls,
        input_tokens: row.input_tokens,
        write_tokens: row.write_tokens,
        read_tokens: row.read_tokens,
      })),
      byDay: (facet?.byDay ?? []).map((row) => ({ day: row._id, credits: row.credits })),
    };
  }

  return { aggregateUsage };
}

export type UsageMethods = ReturnType<typeof createUsageMethods>;
