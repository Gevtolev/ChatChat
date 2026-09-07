import { Schema } from 'mongoose';
import { REFILL_INTERVAL_UNITS } from 'librechat-data-provider';
import type * as t from '~/types';

const balanceSchema = new Schema<t.IBalance>({
  user: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    index: true,
    required: true,
  },
  // 1000 tokenCredits = 1 mill ($0.001 USD)
  tokenCredits: {
    type: Number,
    default: 0,
  },
  /**
   * Credits bought outright, kept apart from the monthly grant because the
   * grant is *overwritten* on renewal rather than added to — `refreshMonthlyGrant`
   * sets `tokenCredits` to the plan's allowance, which is what makes an unused
   * month not roll over. A top-up sharing that field would be erased by the next
   * renewal, silently, along with whatever was paid for it.
   *
   * Absent on every row written before this field existed. Read it through
   * `?? 0` and never filter on a bare equality, or those rows stop matching.
   */
  purchasedCredits: {
    type: Number,
    default: 0,
  },
  // Automatic refill settings
  autoRefillEnabled: {
    type: Boolean,
    default: false,
  },
  refillIntervalValue: {
    type: Number,
    default: 30,
  },
  refillIntervalUnit: {
    type: String,
    enum: REFILL_INTERVAL_UNITS,
    default: 'days',
  },
  lastRefill: {
    type: Date,
    default: Date.now,
  },
  // amount to add on each refill
  refillAmount: {
    type: Number,
    default: 0,
  },
  tenantId: {
    type: String,
    index: true,
  },
});

export default balanceSchema;
