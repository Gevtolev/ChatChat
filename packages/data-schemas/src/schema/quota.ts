import { Schema } from 'mongoose';
import type { IQuota } from '~/types/quota';

const quotaSchema = new Schema<IQuota>(
  {
    user_id: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    period_start: {
      type: Date,
      required: true,
    },
    messages_used: {
      type: Number,
      default: 0,
    },
    created_at: {
      type: Date,
      default: Date.now,
    },
    updated_at: {
      type: Date,
      default: Date.now,
    },
    /**
     * Written only for the anonymous trial, whose owning `User` is itself
     * TTL-bound. See `subscriptionSchema` for why this cannot be inferred from
     * the user — MongoDB's TTL does not cascade.
     *
     * Not unconditional even though the anonymous plan is currently the only
     * one with a `lifetime_message_limit`: this row *is* the abuse counter, and
     * expiring one that belongs to a future paid plan would hand that user a
     * fresh allowance every week.
     */
    expiresAt: {
      type: Date,
      expires: 0,
    },
  },
  { timestamps: false },
);

quotaSchema.index({ user_id: 1, period_start: 1 }, { unique: true });

export default quotaSchema;
