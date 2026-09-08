import type { Types, Document } from 'mongoose';

export interface IQuota extends Document {
  user_id: Types.ObjectId;
  period_start: Date;
  messages_used: number;
  created_at: Date;
  updated_at: Date;
  /** Set only for the anonymous trial, whose owning user is itself TTL-bound.
   *  Absent on every other row. See `quotaSchema`. */
  expiresAt?: Date;
}

export interface IQuotaLean {
  _id: Types.ObjectId;
  user_id: Types.ObjectId;
  period_start: Date;
  messages_used: number;
  created_at: Date;
  updated_at: Date;
  /** Set only for the anonymous trial, whose owning user is itself TTL-bound.
   *  Absent on every other row. See `quotaSchema`. */
  expiresAt?: Date;
  __v?: number;
}
