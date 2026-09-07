import type { RefillIntervalUnit } from 'librechat-data-provider';
import type { Document, Types } from 'mongoose';

export interface IBalance extends Document {
  user: Types.ObjectId;
  tokenCredits: number;
  /** Bought outright; survives the monthly overwrite of `tokenCredits`.
   *  Optional because rows predating the field have no value at all. */
  purchasedCredits?: number;
  // Automatic refill settings
  autoRefillEnabled: boolean;
  refillIntervalValue: number;
  refillIntervalUnit: RefillIntervalUnit;
  lastRefill: Date;
  refillAmount: number;
  tenantId?: string;
}

/** Plain data fields for creating or updating a balance record (no Mongoose Document methods) */
export interface IBalanceUpdate {
  user?: string;
  tokenCredits?: number;
  purchasedCredits?: number;
  autoRefillEnabled?: boolean;
  refillIntervalValue?: number;
  refillIntervalUnit?: RefillIntervalUnit;
  refillAmount?: number;
  lastRefill?: Date;
}
