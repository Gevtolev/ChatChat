import { Schema } from 'mongoose';
import type { ISubscription } from '~/types/subscription';

const subscriptionSchema = new Schema<ISubscription>(
  {
    user_id: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    plan_code: {
      type: String,
      enum: ['anonymous', 'free', 'trial', 'plus', 'pro', 'max', 'beta'],
      required: true,
    },
    status: {
      type: String,
      enum: ['active', 'trialing', 'expired', 'admin_granted'],
      required: true,
    },
    source: {
      type: String,
      enum: ['admin', 'stripe', 'system_default', 'cli'],
      required: true,
    },
    current_period_start: {
      type: Date,
      required: true,
    },
    current_period_end: {
      type: Date,
      required: true,
    },
    external_ref: {
      type: String,
      default: null,
    },
    granted_by: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    metadata: {
      type: Map,
      of: String,
      default: {},
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
     * TTL-bound. MongoDB's TTL monitor removes the row it is set on and nothing
     * else — it does not cascade — so a subscription pointing at a
     * TTL-collected anonymous user used to survive it forever. Production had
     * 110 such rows.
     *
     * `expires: 0` means "expire at the instant this field holds", rather than
     * a fixed interval after it. Absent on every other row, and a document
     * without the field is never expired, so paid subscriptions are untouched.
     */
    expiresAt: {
      type: Date,
      expires: 0,
    },
  },
  { timestamps: false },
);

subscriptionSchema.index({ user_id: 1, status: 1 });
subscriptionSchema.index({ user_id: 1, current_period_start: -1 });
subscriptionSchema.index({ external_ref: 1 }, { sparse: true });

export default subscriptionSchema;
