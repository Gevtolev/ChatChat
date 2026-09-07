import logger from '~/config/winston';
import { isMeteringEnabled } from '~/utils/metering';
import { spendableCredits } from '~/utils/credits';
import type { FilterQuery, Model, Types } from 'mongoose';
import type { IBalance, IBalanceUpdate, TransactionData } from '~/types';
import type { ITransaction } from '~/schema/transaction';

const cancelRate = 1.15;

type MultiplierParams = {
  model?: string;
  valueKey?: string;
  tokenType?: 'prompt' | 'completion';
  inputTokenCount?: number;
  endpointTokenConfig?: Record<string, Record<string, number>>;
};

type CacheMultiplierParams = {
  cacheType?: 'write' | 'read';
  model?: string;
  endpointTokenConfig?: Record<string, Record<string, number>>;
};

/** Fields read/written by the internal token value calculators */
interface InternalTxDoc {
  valueKey?: string;
  tokenType?: 'prompt' | 'completion' | 'credits';
  model?: string;
  endpointTokenConfig?: Record<string, Record<string, number>> | null;
  inputTokenCount?: number;
  rawAmount?: number;
  context?: string;
  rate?: number;
  tokenValue?: number;
  rateDetail?: Record<string, number>;
  inputTokens?: number;
  writeTokens?: number;
  readTokens?: number;
}

/** Input data for creating a transaction */
export interface TxData {
  user: string | Types.ObjectId;
  conversationId?: string;
  model?: string;
  context?: string;
  tokenType?: 'prompt' | 'completion' | 'credits';
  rawAmount?: number;
  valueKey?: string;
  endpointTokenConfig?: Record<string, Record<string, number>> | null;
  inputTokenCount?: number;
  inputTokens?: number;
  writeTokens?: number;
  readTokens?: number;
  balance?: { enabled?: boolean };
  transactions?: { enabled?: boolean };
}

/** Return value from a successful transaction that also updates the balance */
export interface TransactionResult {
  rate: number;
  user: string;
  balance: number;
  prompt?: number;
  completion?: number;
  credits?: number;
}

export function createTransactionMethods(
  mongoose: typeof import('mongoose'),
  txMethods: {
    getMultiplier: (params: MultiplierParams) => number;
    getCacheMultiplier: (params: CacheMultiplierParams) => number | null;
  },
) {
  /** Calculate and set the tokenValue for a transaction */
  function calculateTokenValue(txn: InternalTxDoc) {
    const { valueKey, tokenType, model, endpointTokenConfig, inputTokenCount } = txn;
    const multiplier = Math.abs(
      txMethods.getMultiplier({
        valueKey,
        tokenType: tokenType as 'prompt' | 'completion' | undefined,
        model,
        endpointTokenConfig: endpointTokenConfig ?? undefined,
        inputTokenCount,
      }),
    );
    txn.rate = multiplier;
    txn.tokenValue = (txn.rawAmount ?? 0) * multiplier;
    if (txn.context && txn.tokenType === 'completion' && txn.context === 'incomplete') {
      txn.tokenValue = Math.ceil((txn.tokenValue ?? 0) * cancelRate);
      txn.rate = (txn.rate ?? 0) * cancelRate;
    }
  }

  /** Calculate token value for structured tokens */
  function calculateStructuredTokenValue(txn: InternalTxDoc) {
    if (!txn.tokenType) {
      txn.tokenValue = txn.rawAmount;
      return;
    }

    const { model, endpointTokenConfig, inputTokenCount } = txn;
    const etConfig = endpointTokenConfig ?? undefined;

    if (txn.tokenType === 'prompt') {
      const inputMultiplier = txMethods.getMultiplier({
        tokenType: 'prompt',
        model,
        endpointTokenConfig: etConfig,
        inputTokenCount,
      });
      const writeMultiplier =
        txMethods.getCacheMultiplier({
          cacheType: 'write',
          model,
          endpointTokenConfig: etConfig,
        }) ?? inputMultiplier;
      const readMultiplier =
        txMethods.getCacheMultiplier({ cacheType: 'read', model, endpointTokenConfig: etConfig }) ??
        inputMultiplier;

      txn.rateDetail = {
        input: inputMultiplier,
        write: writeMultiplier,
        read: readMultiplier,
      };

      const totalPromptTokens =
        Math.abs(txn.inputTokens ?? 0) +
        Math.abs(txn.writeTokens ?? 0) +
        Math.abs(txn.readTokens ?? 0);

      if (totalPromptTokens > 0) {
        txn.rate =
          (Math.abs(inputMultiplier * (txn.inputTokens ?? 0)) +
            Math.abs(writeMultiplier * (txn.writeTokens ?? 0)) +
            Math.abs(readMultiplier * (txn.readTokens ?? 0))) /
          totalPromptTokens;
      } else {
        txn.rate = Math.abs(inputMultiplier);
      }

      txn.tokenValue = -(
        Math.abs(txn.inputTokens ?? 0) * inputMultiplier +
        Math.abs(txn.writeTokens ?? 0) * writeMultiplier +
        Math.abs(txn.readTokens ?? 0) * readMultiplier
      );

      txn.rawAmount = -totalPromptTokens;
    } else if (txn.tokenType === 'completion') {
      const multiplier = txMethods.getMultiplier({
        tokenType: txn.tokenType,
        model,
        endpointTokenConfig: etConfig,
        inputTokenCount,
      });
      txn.rate = Math.abs(multiplier);
      txn.tokenValue = -Math.abs(txn.rawAmount ?? 0) * multiplier;
      txn.rawAmount = -Math.abs(txn.rawAmount ?? 0);
    }

    if (txn.context && txn.tokenType === 'completion' && txn.context === 'incomplete') {
      txn.tokenValue = Math.ceil((txn.tokenValue ?? 0) * cancelRate);
      txn.rate = (txn.rate ?? 0) * cancelRate;
      if (txn.rateDetail) {
        txn.rateDetail = Object.fromEntries(
          Object.entries(txn.rateDetail).map(([k, v]) => [k, v * cancelRate]),
        );
      }
    }
  }

  /**
   * Splits a balance change across the granted and purchased buckets.
   *
   * Spending draws the **granted** allowance down first. That bucket is
   * overwritten at renewal whether or not it was used, so anything left in it
   * is about to be lost; the purchased bucket keeps its value indefinitely.
   * Spending purchased credits while granted ones expired underneath would
   * destroy value the user paid for, for no reason.
   *
   * Credit (a positive change — auto-refill, the signup grant) lands entirely
   * on `tokenCredits`, which is what those paths have always meant. Purchases
   * add to the other bucket through their own path, not through here.
   *
   * Overspending clamps both to zero rather than going negative, matching what
   * the single-bucket version did.
   */
  function applySpend(
    currentGranted: number,
    currentPurchased: number,
    incrementValue: number,
  ): { tokenCredits: number; purchasedCredits: number } {
    /** Floored before anything is derived from them. A negative `tokenCredits`
     *  — which upstream's balance system can leave behind — would otherwise make
     *  `Math.min(granted, spend)` negative, so the remainder charged to the
     *  purchased bucket would *exceed* the spend: a row at -100 spending 50 took
     *  150 of the credits the user had paid for. */
    const granted = Math.max(0, currentGranted);
    const purchased = Math.max(0, currentPurchased);

    if (incrementValue >= 0) {
      return { tokenCredits: granted + incrementValue, purchasedCredits: purchased };
    }
    const spend = -incrementValue;
    const fromGranted = Math.min(granted, spend);
    const fromPurchased = Math.min(purchased, spend - fromGranted);
    return {
      tokenCredits: granted - fromGranted,
      purchasedCredits: purchased - fromPurchased,
    };
  }

  /**
   * Optimistic-concurrency clause for one balance bucket.
   *
   * Cannot be a bare equality when the value read was zero, because zero is also
   * what a *missing* field reads as, and `{ field: 0 }` does not match a missing
   * field in MongoDB. `purchasedCredits` is absent on every row written before
   * it existed, and `tokenCredits` is absent on rows not created through the
   * schema; either way the update matches nothing, burns all ten retries and
   * throws. The `$exists` arm keeps those rows writable while still failing the
   * match if a concurrent write put a real value there, which is the whole point
   * of the clause.
   */
  function matchesCurrent(
    field: 'tokenCredits' | 'purchasedCredits',
    current: number,
  ): FilterQuery<IBalance> {
    if (current !== 0) {
      return { [field]: current };
    }
    return { $or: [{ [field]: 0 }, { [field]: { $exists: false } }] };
  }

  /**
   * Updates a user's token balance using optimistic concurrency control.
   * Always returns an IBalance or throws after exhausting retries.
   */
  async function updateBalance({
    user,
    incrementValue,
    setValues,
  }: {
    user: string;
    incrementValue: number;
    setValues?: IBalanceUpdate;
  }): Promise<IBalance> {
    const Balance = mongoose.models.Balance as Model<IBalance>;
    const maxRetries = 10;
    let delay = 50;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let currentBalanceDoc: IBalance | null;
      try {
        currentBalanceDoc = await Balance.findOne({ user }).lean<IBalance>();
        /** Both read through `?? 0`. Reading one that way and not the other let
         *  a row missing `tokenCredits` produce a NaN that `applySpend` then
         *  wrote to *both* buckets, erasing purchased credits along with the
         *  grant. */
        const currentCredits = currentBalanceDoc?.tokenCredits ?? 0;
        const currentPurchased = currentBalanceDoc?.purchasedCredits ?? 0;

        const { tokenCredits: newCredits, purchasedCredits: newPurchased } = applySpend(
          currentCredits,
          currentPurchased,
          incrementValue,
        );

        const updatePayload = {
          $set: {
            tokenCredits: newCredits,
            purchasedCredits: newPurchased,
            ...(setValues ?? {}),
          },
        };

        if (currentBalanceDoc) {
          const updatedBalance = await Balance.findOneAndUpdate(
            /** `$and` rather than spreading both clauses into one object: each
             *  can be an `$or`, and the second would overwrite the first. */
            {
              user,
              $and: [
                matchesCurrent('tokenCredits', currentCredits),
                matchesCurrent('purchasedCredits', currentPurchased),
              ],
            },
            updatePayload,
            { new: true },
          ).lean<IBalance>();

          if (updatedBalance) {
            return updatedBalance;
          }
          lastError = new Error(`Concurrency conflict for user ${user} on attempt ${attempt}.`);
        } else {
          /**
           * Insert, never upsert. An upsert on `{ user }` matches a row created
           * between the read above and this write, and the payload is a `$set`
           * of absolute values derived from a balance of zero — so a grant that
           * landed in that window was overwritten with zero. Inserting instead
           * fails with a duplicate key (the `user` index is unique for exactly
           * this reason), and the retry re-reads and takes the compare-and-swap
           * branch, which is the path that respects a concurrent write.
           */
          try {
            const created = await Balance.create({
              user,
              tokenCredits: newCredits,
              purchasedCredits: newPurchased,
              ...(setValues ?? {}),
            });
            return created.toObject() as IBalance;
          } catch (error: unknown) {
            if (
              error instanceof Error &&
              'code' in error &&
              (error as { code: number }).code === 11000
            ) {
              lastError = error;
            } else {
              throw error;
            }
          }
        }
      } catch (error) {
        logger.error(`[updateBalance] Error during attempt ${attempt} for user ${user}:`, error);
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      if (attempt < maxRetries) {
        const jitter = Math.random() * delay * 0.5;
        await new Promise((resolve) => setTimeout(resolve, delay + jitter));
        delay = Math.min(delay * 2, 2000);
      }
    }

    logger.error(
      `[updateBalance] Failed to update balance for user ${user} after ${maxRetries} attempts.`,
    );
    throw (
      lastError ??
      new Error(
        `Failed to update balance for user ${user} after maximum retries due to persistent conflicts.`,
      )
    );
  }

  /**
   * Creates an auto-refill transaction that also updates balance.
   */
  async function createAutoRefillTransaction(txData: TxData) {
    if (txData.rawAmount != null && isNaN(txData.rawAmount)) {
      return;
    }
    const Transaction = mongoose.models.Transaction;
    const transaction = new Transaction(txData);
    transaction.endpointTokenConfig = txData.endpointTokenConfig;
    transaction.inputTokenCount = txData.inputTokenCount;
    calculateTokenValue(transaction);
    await transaction.save();

    const balanceResponse = await updateBalance({
      user: transaction.user as string,
      incrementValue: txData.rawAmount ?? 0,
      setValues: { lastRefill: new Date() },
    });
    const result = {
      rate: transaction.rate as number,
      user: transaction.user.toString() as string,
      balance: balanceResponse.tokenCredits,
      transaction,
    };
    logger.debug('[Balance.check] Auto-refill performed', result);
    return result;
  }

  /**
   * Creates a transaction and updates the balance.
   */
  async function createTransaction(_txData: TxData): Promise<TransactionResult | undefined> {
    const { balance, transactions, ...txData } = _txData;
    if (txData.rawAmount != null && isNaN(txData.rawAmount)) {
      return;
    }

    if (transactions?.enabled === false) {
      return;
    }

    const Transaction = mongoose.models.Transaction;
    const transaction = new Transaction(txData);
    transaction.endpointTokenConfig = txData.endpointTokenConfig;
    transaction.inputTokenCount = txData.inputTokenCount;
    calculateTokenValue(transaction);

    await transaction.save();
    if (!isMeteringEnabled(balance)) {
      return;
    }

    const incrementValue = transaction.tokenValue as number;
    const balanceResponse = await updateBalance({
      user: transaction.user as string,
      incrementValue,
    });

    return {
      rate: transaction.rate as number,
      user: transaction.user.toString() as string,
      balance: spendableCredits(balanceResponse),
      [transaction.tokenType as string]: incrementValue,
    } as TransactionResult;
  }

  /**
   * Creates a structured transaction and updates the balance.
   */
  async function createStructuredTransaction(
    _txData: TxData,
  ): Promise<TransactionResult | undefined> {
    const { balance, transactions, ...txData } = _txData;
    if (transactions?.enabled === false) {
      return;
    }

    const Transaction = mongoose.models.Transaction;
    const transaction = new Transaction(txData);
    transaction.endpointTokenConfig = txData.endpointTokenConfig;
    transaction.inputTokenCount = txData.inputTokenCount;

    calculateStructuredTokenValue(transaction);

    await transaction.save();

    if (!isMeteringEnabled(balance)) {
      return;
    }

    const incrementValue = transaction.tokenValue as number;

    const balanceResponse = await updateBalance({
      user: transaction.user as string,
      incrementValue,
    });

    return {
      rate: transaction.rate as number,
      user: transaction.user.toString() as string,
      balance: spendableCredits(balanceResponse),
      [transaction.tokenType as string]: incrementValue,
    } as TransactionResult;
  }

  /**
   * Queries and retrieves transactions based on a given filter.
   */
  async function getTransactions(filter: FilterQuery<ITransaction>) {
    try {
      const Transaction = mongoose.models.Transaction;
      return await Transaction.find(filter).lean();
    } catch (error) {
      logger.error('Error querying transactions:', error);
      throw error;
    }
  }

  /** Retrieves a user's balance record. */
  async function findBalanceByUser(user: string): Promise<IBalance | null> {
    const Balance = mongoose.models.Balance as Model<IBalance>;
    return Balance.findOne({ user }).lean<IBalance>();
  }

  /** Upserts balance fields for a user. */
  async function upsertBalanceFields(
    user: string,
    fields: IBalanceUpdate,
  ): Promise<IBalance | null> {
    const Balance = mongoose.models.Balance as Model<IBalance>;
    return Balance.findOneAndUpdate(
      { user },
      { $set: fields },
      { upsert: true, new: true },
    ).lean<IBalance>();
  }

  /** Deletes transactions matching a filter. */
  async function deleteTransactions(filter: FilterQuery<ITransaction>) {
    const Transaction = mongoose.models.Transaction;
    return Transaction.deleteMany(filter);
  }

  /** Deletes balance records matching a filter. */
  async function deleteBalances(filter: FilterQuery<IBalance>) {
    const Balance = mongoose.models.Balance as Model<IBalance>;
    return Balance.deleteMany(filter);
  }

  async function bulkInsertTransactions(docs: TransactionData[]): Promise<void> {
    if (!docs.length) {
      return;
    }
    try {
      const Transaction = mongoose.models.Transaction;
      await Transaction.insertMany(docs);
    } catch (error) {
      logger.error('[bulkInsertTransactions] Error inserting transaction docs:', error);
      throw error;
    }
  }

  return {
    updateBalance,
    bulkInsertTransactions,
    findBalanceByUser,
    upsertBalanceFields,
    getTransactions,
    deleteTransactions,
    deleteBalances,
    createTransaction,
    createAutoRefillTransaction,
    createStructuredTransaction,
  };
}

export type TransactionMethods = ReturnType<typeof createTransactionMethods>;
