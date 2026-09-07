import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods } from './index';
import transactionSchema from '~/schema/transaction';
import balanceSchema from '~/schema/balance';

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;
let Balance: mongoose.Model<Record<string, unknown>>;

const userId = () => new mongoose.Types.ObjectId();

/** `tokenValue` is `rawAmount * multiplier`, so a real model's rate would make
 *  every expectation below a disguised assertion about the price table. Pinning
 *  the multiplier at 1 lets the numbers state the spend split and nothing else. */
const RATE_1_MODEL = 'spend-order-fixture';
const RATE_1_CONFIG = { [RATE_1_MODEL]: { prompt: 1, completion: 1 } };

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  Balance =
    (mongoose.models.Balance as mongoose.Model<Record<string, unknown>>) ??
    mongoose.model('Balance', balanceSchema);
  /** `createTransaction` constructs `mongoose.models.Transaction` directly, so
   *  the spend path is unreachable without it registered. */
  if (!mongoose.models.Transaction) {
    mongoose.model('Transaction', transactionSchema);
  }
  methods = createMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Balance.deleteMany({});
});

describe('purchased credits survive the monthly renewal', () => {
  /** The defect this bucket exists for. `refreshMonthlyGrant` *overwrites*
   *  `tokenCredits` rather than adding to it — that is what makes an unused
   *  month not roll over — so a top-up sharing that field was erased on the
   *  user's renewal date along with whatever they paid for it. */
  it('keeps a top-up when the grant is overwritten', async () => {
    const user = userId();
    await Balance.create({
      user,
      tokenCredits: 5_000_000,
      autoRefillEnabled: true,
      /** Older than the refill interval, so this renewal is due. */
      lastRefill: new Date('2020-01-01'),
    });
    await methods.grantPurchasedCredits({ userId: user, credits: 50_000_000 });

    const spendable = await methods.refreshMonthlyGrant({
      userId: user,
      credits: 14_950_000,
    });

    const row = await Balance.findOne({ user }).lean();
    expect(row?.tokenCredits).toBe(14_950_000);
    expect(row?.purchasedCredits).toBe(50_000_000);
    /** Reported spendable is both buckets — the gate refuses at <= 0, and
     *  counting only the granted half would lock out someone who just paid. */
    expect(spendable).toBe(64_950_000);
  });

  it('adds across repeated purchases rather than replacing', async () => {
    const user = userId();
    await methods.grantPurchasedCredits({ userId: user, credits: 25_000_000 });
    const total = await methods.grantPurchasedCredits({ userId: user, credits: 50_000_000 });
    expect(total).toBe(75_000_000);
  });

  it('refuses a non-positive amount rather than silently deducting', async () => {
    const user = userId();
    await expect(methods.grantPurchasedCredits({ userId: user, credits: -1 })).rejects.toThrow(
      /must be positive/,
    );
  });
});

describe('spend order', () => {
  /** Granted credits are overwritten at renewal whether or not they were used,
   *  so anything left in that bucket is about to be lost. Spending purchased
   *  credits first would destroy value the user paid for while the perishable
   *  half expired underneath. */
  it('draws the perishable grant down before touching purchased credits', async () => {
    const user = userId();
    await Balance.create({ user, tokenCredits: 1_000_000, purchasedCredits: 5_000_000 });

    await methods.createTransaction({
      user: user.toString(),
      conversationId: 'c1',
      model: RATE_1_MODEL,
      tokenType: 'prompt',
      endpointTokenConfig: RATE_1_CONFIG,
      rawAmount: -400_000,
    });

    const row = await Balance.findOne({ user }).lean();
    expect(row?.tokenCredits).toBe(600_000);
    expect(row?.purchasedCredits).toBe(5_000_000);
  });

  it('spills into purchased credits once the grant is exhausted', async () => {
    const user = userId();
    await Balance.create({ user, tokenCredits: 1_000_000, purchasedCredits: 5_000_000 });

    await methods.createTransaction({
      user: user.toString(),
      conversationId: 'c1',
      model: RATE_1_MODEL,
      tokenType: 'prompt',
      endpointTokenConfig: RATE_1_CONFIG,
      rawAmount: -1_500_000,
    });

    const row = await Balance.findOne({ user }).lean();
    expect(row?.tokenCredits).toBe(0);
    expect(row?.purchasedCredits).toBe(4_500_000);
  });

  it('clamps both buckets at zero rather than going negative', async () => {
    const user = userId();
    await Balance.create({ user, tokenCredits: 100, purchasedCredits: 200 });

    await methods.createTransaction({
      user: user.toString(),
      conversationId: 'c1',
      model: RATE_1_MODEL,
      tokenType: 'prompt',
      endpointTokenConfig: RATE_1_CONFIG,
      rawAmount: -10_000,
    });

    const row = await Balance.findOne({ user }).lean();
    expect(row?.tokenCredits).toBe(0);
    expect(row?.purchasedCredits).toBe(0);
  });

  /** Every row written before this field existed has no `purchasedCredits` at
   *  all, and `{ purchasedCredits: 0 }` does not match a missing field. Without
   *  the `$exists` arm in the concurrency filter, every balance update for those
   *  users would fail all ten retries and throw — which is every existing
   *  account in production. */
  it('still updates a balance row predating the field', async () => {
    const user = userId();
    await Balance.collection.insertOne({ user, tokenCredits: 1_000_000 });

    await methods.createTransaction({
      user: user.toString(),
      conversationId: 'c1',
      model: RATE_1_MODEL,
      tokenType: 'prompt',
      endpointTokenConfig: RATE_1_CONFIG,
      rawAmount: -250_000,
    });

    const row = await Balance.findOne({ user }).lean();
    expect(row?.tokenCredits).toBe(750_000);
  });
});
