/**
 * The bulk path deducts under *this fork's* metering rule, not upstream's flag.
 *
 * `transactions.bulk-parity.spec.ts` passes `balance: { enabled: true }` in
 * every case, which is what let this go unnoticed: production passes what
 * `getBalanceConfig` returns, and we deliberately never enable upstream's
 * balance feature. Under that shape the bulk path — the one `client.js` always
 * takes, since it passes both `pricing` and `bulkWriteOps` — wrote transaction
 * rows and left the balance untouched. Eight beta accounts sat at their full
 * grant across 1,032 transactions.
 *
 * So these cases pin the production argument shape, not a convenient one.
 */
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, balanceSchema, transactionSchema } from '@librechat/data-schemas';
import type { PricingFns, TxMetadata } from './transactions';
import { bulkWriteTransactions, prepareTokenSpend } from './transactions';

function findMatchingPattern(
  modelName: string,
  tokensMap: Record<string, number | Record<string, number>>,
): string | undefined {
  const keys = Object.keys(tokensMap);
  const lowerModelName = modelName.toLowerCase();
  for (let i = keys.length - 1; i >= 0; i--) {
    if (lowerModelName.includes(keys[i])) {
      return keys[i];
    }
  }
  return undefined;
}

function matchModelName(modelName: string): string | undefined {
  return typeof modelName === 'string' ? modelName : undefined;
}

let mongoServer: MongoMemoryServer;
let Balance: mongoose.Model<Record<string, unknown>>;
let dbMethods: ReturnType<typeof createMethods>;
let pricing: PricingFns;

/** Rate of exactly 1, so the assertions state the deduction and not the price
 *  table. */
const MODEL = 'metering-fixture';
const CONFIG = { [MODEL]: { prompt: 1, completion: 1, context: 8192 } };

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  if (!mongoose.models.Transaction) {
    mongoose.model('Transaction', transactionSchema);
  }
  Balance = (mongoose.models.Balance ?? mongoose.model('Balance', balanceSchema)) as mongoose.Model<
    Record<string, unknown>
  >;
  dbMethods = createMethods(mongoose, { matchModelName, findMatchingPattern });
  pricing = {
    getMultiplier: dbMethods.getMultiplier,
    getCacheMultiplier: dbMethods.getCacheMultiplier,
  };
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

/** Pinned rather than merely cleaned up afterwards: these cases assert the
 *  *presence* of a deduction, so an ambient `DISABLE_BILLING_GATING` in the
 *  shell would turn them red for a reason that has nothing to do with the code
 *  under test. */
beforeEach(async () => {
  delete process.env.DISABLE_BILLING_GATING;
  await mongoose.connection.dropDatabase();
});

const dbOps = () => ({
  insertMany: dbMethods.bulkInsertTransactions,
  updateBalance: dbMethods.updateBalance,
});

function txMeta(user: string, balance: TxMetadata['balance']): TxMetadata {
  return {
    user,
    conversationId: 'c1',
    context: 'message',
    model: MODEL,
    endpointTokenConfig: CONFIG,
    balance,
    transactions: { enabled: true },
  };
}

async function spend(balance: TxMetadata['balance']): Promise<number> {
  const user = new mongoose.Types.ObjectId().toString();
  await Balance.create({ user, tokenCredits: 1_000_000 });
  const entries = prepareTokenSpend(
    txMeta(user, balance),
    { promptTokens: 100, completionTokens: 50 },
    pricing,
  );
  await bulkWriteTransactions({ user, docs: entries }, dbOps());
  const row = await Balance.findOne({ user }).lean();
  return row?.tokenCredits as number;
}

describe('bulk path metering', () => {
  test('deducts when upstream balance config is absent', async () => {
    expect(await spend(undefined)).toBe(999_850);
  });

  test('deducts when upstream balance config is explicitly disabled', async () => {
    expect(await spend({ enabled: false })).toBe(999_850);
  });

  test('deducts when upstream balance config is enabled', async () => {
    expect(await spend({ enabled: true })).toBe(999_850);
  });

  test('leaves the balance alone when billing gating is off', async () => {
    process.env.DISABLE_BILLING_GATING = 'true';
    expect(await spend({ enabled: false })).toBe(1_000_000);
  });

  test('still records the transaction rows when gating is off', async () => {
    process.env.DISABLE_BILLING_GATING = 'true';
    const user = new mongoose.Types.ObjectId().toString();
    await Balance.create({ user, tokenCredits: 1_000_000 });
    const entries = prepareTokenSpend(
      txMeta(user, { enabled: false }),
      { promptTokens: 100, completionTokens: 50 },
      pricing,
    );
    await bulkWriteTransactions({ user, docs: entries }, dbOps());
    /** Cost auditing aggregates `Transaction` at read time, so the rows have to
     *  be written whether or not the user was charged. */
    expect(await mongoose.models.Transaction.countDocuments({ user })).toBe(2);
  });
});
