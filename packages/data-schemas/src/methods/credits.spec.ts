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
  /** Index builds are asynchronous, and the concurrency cases below depend on
   *  the unique `user` index existing — without it a racing insert succeeds and
   *  silently splits the balance across two rows instead of erroring. */
  await Balance.init();
  methods = createMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

/** Pinned rather than assumed. Every case below asserts that a spend *landed*,
 *  which only holds while metering is on; an ambient `DISABLE_BILLING_GATING`
 *  in the shell would turn the whole file red for a reason unrelated to it. */
beforeEach(async () => {
  delete process.env.DISABLE_BILLING_GATING;
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

  /** `tokenCredits` reached `applySpend` without a `?? 0` while
   *  `purchasedCredits` had one. A row missing it therefore produced a NaN that
   *  was written to *both* fields, destroying purchased credits on a user whose
   *  only sin was an oddly-shaped legacy row. */
  it('does not turn a balance into NaN when tokenCredits is absent', async () => {
    const user = userId();
    await Balance.collection.insertOne({ user, purchasedCredits: 500_000 });

    await methods.createTransaction({
      user: user.toString(),
      conversationId: 'c1',
      model: RATE_1_MODEL,
      tokenType: 'prompt',
      endpointTokenConfig: RATE_1_CONFIG,
      rawAmount: -100_000,
    });

    const row = await Balance.findOne({ user }).lean();
    expect(row?.tokenCredits).toBe(0);
    expect(row?.purchasedCredits).toBe(400_000);
  });

  /** Upstream's balance system can leave `tokenCredits` negative. Spending then
   *  charged the purchased bucket for the spend *plus* the overdraft, because
   *  `Math.min(granted, spend)` was itself negative — the user paid twice for
   *  someone else's arithmetic. */
  it('does not charge purchased credits for a negative grant', async () => {
    const user = userId();
    await Balance.create({ user, tokenCredits: -100_000, purchasedCredits: 500_000 });

    await methods.createTransaction({
      user: user.toString(),
      conversationId: 'c1',
      model: RATE_1_MODEL,
      tokenType: 'prompt',
      endpointTokenConfig: RATE_1_CONFIG,
      rawAmount: -50_000,
    });

    const row = await Balance.findOne({ user }).lean();
    expect(row?.tokenCredits).toBe(0);
    expect(row?.purchasedCredits).toBe(450_000);
  });

  /** The debug line `spendTokens` writes after every generation is the only
   *  standing record of what a user had left; reporting the granted half alone
   *  understates it by whatever they bought. */
  it('reports both buckets as the resulting balance', async () => {
    const user = userId();
    await Balance.create({ user, tokenCredits: 300_000, purchasedCredits: 700_000 });

    const result = await methods.createTransaction({
      user: user.toString(),
      conversationId: 'c1',
      model: RATE_1_MODEL,
      tokenType: 'prompt',
      endpointTokenConfig: RATE_1_CONFIG,
      rawAmount: -100_000,
    });

    expect(result?.balance).toBe(900_000);
  });
});

describe('concurrent writes', () => {
  /** `updateBalance` used to upsert on `{ user }` when its read found no row,
   *  `$set`ting absolute values derived from a balance of zero. A grant landing
   *  in that window was overwritten with the result of spending against
   *  nothing. Inserting instead makes the collision a duplicate-key error, and
   *  the retry re-reads and compares-and-swaps. */
  it('does not overwrite a balance created between the read and the write', async () => {
    const user = userId();
    await Balance.create({ user, tokenCredits: 0, purchasedCredits: 1_000_000 });

    /** The interleaving is forced rather than raced. Two real concurrent
     *  operations do not reproduce it reliably — the grant simply wins, and the
     *  window never opens — so racing them would give a test that passes
     *  against the defect. Here the read misses while the row demonstrably
     *  exists, which is exactly the state the old upsert wrote through. */
    jest
      .spyOn(Balance, 'findOne')
      .mockImplementationOnce(() => ({ lean: async () => null }) as never);

    await methods.updateBalance({ user: user.toString(), incrementValue: -100_000 });

    const row = await Balance.findOne({ user }).lean();
    expect(row?.purchasedCredits).toBe(900_000);
  });

  it('keeps exactly one balance row per user', async () => {
    const user = userId();
    await Promise.all(
      Array.from({ length: 5 }, () =>
        methods.updateBalance({ user: user.toString(), incrementValue: 1_000 }),
      ),
    );
    expect(await Balance.countDocuments({ user })).toBe(1);
  });
});
