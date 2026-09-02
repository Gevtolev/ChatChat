import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
import { applyPlanChange } from './applyPlanChange';
import { checkBillingAccess } from './gating';
import { buildGatingDeps } from './deps';
import { PLANS } from './plans';

type BalanceDoc = {
  tokenCredits: number;
  autoRefillEnabled: boolean;
  refillIntervalUnit: string;
  refillIntervalValue: number;
  refillAmount: number;
};

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;

function buildApplyDeps() {
  const m = createMethods(mongoose);
  return {
    getActiveSubscriptionRecord: m.getActiveSubscriptionRecord,
    expireActiveSubscriptions: m.expireActiveSubscriptions,
    createSubscription: m.createSubscription,
    createQuota: m.createQuota,
    grantMonthlyCredits: m.grantMonthlyCredits,
  };
}

/**
 * The production factory, not a local copy. A hand-built deps object here is
 * exactly what let four incomplete ones ship: the tests stayed green because
 * they assembled their own correct version and so only ever exercised the
 * TypeScript function, never its JavaScript callers.
 */
function gatingDeps() {
  return buildGatingDeps(methods);
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  for (const modelName of Object.keys(mongoose.models)) {
    await mongoose.models[modelName].ensureIndexes();
  }
  methods = createMethods(mongoose);
});

async function expectDenied(promise: Promise<void>, expectedCode: string): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Error);
  const payload: { code: string } = JSON.parse((thrown as Error).message);
  expect(payload.code).toBe(expectedCode);
}

describe('checkBillingAccess — model tier gating', () => {
  test('free user + expensive model → throws upgrade_required_model', async () => {
    expect.assertions(2);
    const userId = new mongoose.Types.ObjectId();

    await expectDenied(
      checkBillingAccess({ userId, modelId: 'gpt-5.5' }, gatingDeps()),
      'upgrade_required_model',
    );
  });

  test('a credit-metered user with no balance row is denied, not given free capacity', async () => {
    expect.assertions(2);
    /** A `free` user who never went through `applyPlanChange` has no Balance
     *  document. Reading that as "unlimited" would hand out the most expensive
     *  models for nothing, so the gate must treat a missing row as zero. */
    const userId = new mongoose.Types.ObjectId();

    await expectDenied(
      checkBillingAccess({ userId, modelId: 'gpt-5.4-nano' }, gatingDeps()),
      'upgrade_required_quota',
    );
  });

  test('pro user (granted via applyPlanChange) + expensive model → passes', async () => {
    const userId = new mongoose.Types.ObjectId();
    await applyPlanChange(
      { user_id: userId, plan_code: 'plus', source: 'admin' },
      buildApplyDeps(),
    );

    await expect(
      checkBillingAccess({ userId, modelId: 'gpt-5.5' }, gatingDeps()),
    ).resolves.toBeUndefined();
  });

  test('unknown model treated as mid tier → free user denied (mid not in cheap)', async () => {
    expect.assertions(2);
    const userId = new mongoose.Types.ObjectId();

    await expectDenied(
      checkBillingAccess({ userId, modelId: 'totally-unknown-model-xyz' }, gatingDeps()),
      'upgrade_required_model',
    );
  });
});

describe('checkBillingAccess — DISABLE_BILLING_GATING escape hatch', () => {
  const ORIGINAL_ENV = process.env.DISABLE_BILLING_GATING;

  afterEach(() => {
    process.env.DISABLE_BILLING_GATING = ORIGINAL_ENV;
  });

  test('free user + expensive model passes when the flag is enabled, quota untouched', async () => {
    process.env.DISABLE_BILLING_GATING = 'true';
    const userId = new mongoose.Types.ObjectId();
    const deps = gatingDeps();

    await expect(checkBillingAccess({ userId, modelId: 'gpt-5.5' }, deps)).resolves.toBeUndefined();

    const quotaRecord = await mongoose.models.Quota.findOne({ user_id: userId }).lean();
    expect(quotaRecord).toBeNull();
  });

  test('gating re-enabled once the flag is turned back off', async () => {
    expect.assertions(2);
    process.env.DISABLE_BILLING_GATING = 'false';
    const userId = new mongoose.Types.ObjectId();

    await expectDenied(
      checkBillingAccess({ userId, modelId: 'gpt-5.5' }, gatingDeps()),
      'upgrade_required_model',
    );
  });

  test('anonymous trial stays enforced even when the flag is enabled', async () => {
    process.env.DISABLE_BILLING_GATING = 'true';
    const userId = new mongoose.Types.ObjectId();
    await applyPlanChange(
      { user_id: userId, plan_code: 'anonymous', source: 'system_default' },
      buildApplyDeps(),
    );
    const deps = gatingDeps();

    // anonymous plan allows all tiers but caps at 3 lifetime messages — 3 pass, 4th denied,
    // independent of DISABLE_BILLING_GATING (which still exempts non-anonymous users).
    await expect(
      checkBillingAccess({ userId, modelId: 'x-ai/grok-4.3' }, deps),
    ).resolves.toBeUndefined();
    await expect(
      checkBillingAccess({ userId, modelId: 'x-ai/grok-4.3' }, deps),
    ).resolves.toBeUndefined();
    await expect(
      checkBillingAccess({ userId, modelId: 'x-ai/grok-4.3' }, deps),
    ).resolves.toBeUndefined();
    await expectDenied(
      checkBillingAccess({ userId, modelId: 'x-ai/grok-4.3' }, deps),
      'upgrade_required_quota',
    );
  });
});

describe('checkBillingAccess — feature gating', () => {
  test('featureFlag set + free plan + cheap model → throws feature_not_available', async () => {
    expect.assertions(2);
    const userId = new mongoose.Types.ObjectId();
    // gpt-5.4-nano is cheap (passes tier check), but agents=false on free plan

    await expectDenied(
      checkBillingAccess({ userId, modelId: 'gpt-5.4-nano', featureFlag: 'agents' }, gatingDeps()),
      'feature_not_available',
    );
  });

  test('featureFlag set + pro plan → passes feature check and quota increment', async () => {
    const userId = new mongoose.Types.ObjectId();
    await applyPlanChange(
      { user_id: userId, plan_code: 'plus', source: 'admin' },
      buildApplyDeps(),
    );

    await expect(
      checkBillingAccess({ userId, modelId: 'gpt-5.4-mini', featureFlag: 'agents' }, gatingDeps()),
    ).resolves.toBeUndefined();
  });
});

describe('checkBillingAccess — payload shape', () => {
  test('upgrade_required_model error includes current_plan and required_tier', async () => {
    const userId = new mongoose.Types.ObjectId();

    let caughtErr: unknown;
    try {
      await checkBillingAccess({ userId, modelId: 'gpt-5.5' }, gatingDeps());
    } catch (err) {
      caughtErr = err;
    }

    expect(caughtErr).toBeInstanceOf(Error);
    const payload: { code: string; current_plan: string; required_tier: string } = JSON.parse(
      (caughtErr as Error).message,
    );
    expect(payload.code).toBe('upgrade_required_model');
    expect(payload.current_plan).toBe('free');
    expect(payload.required_tier).toBe('expensive');
  });

  test('upgrade_required_quota error includes used and limit', async () => {
    const userId = new mongoose.Types.ObjectId();
    /** Anonymous is the message-counted plan, so its payload carries the
     *  message cap; credit-metered plans report their credit grant instead. */
    await applyPlanChange(
      { user_id: userId, plan_code: 'anonymous', source: 'system_default' },
      buildApplyDeps(),
    );
    const deps = gatingDeps();

    for (let i = 0; i < 3; i++) {
      await checkBillingAccess({ userId, modelId: 'gpt-5.4-mini' }, deps);
    }

    let caughtErr: unknown;
    try {
      await checkBillingAccess({ userId, modelId: 'gpt-5.4-mini' }, deps);
    } catch (err) {
      caughtErr = err;
    }

    expect(caughtErr).toBeInstanceOf(Error);
    const payload: { code: string; used: number; limit: number } = JSON.parse(
      (caughtErr as Error).message,
    );
    expect(payload.code).toBe('upgrade_required_quota');
    expect(payload.used).toBe(3);
    expect(payload.limit).toBe(3);
  });
});

describe('checkBillingAccess — the anonymous trial is not credit-metered', () => {
  /** The visitor trial is a product rule expressed in messages, so it survives
   *  the billing escape hatch and never consults a Balance row — an anonymous
   *  visitor has none. It also must not reset: a lifetime counter, not a period. */
  test('anonymous is capped at three messages and does not reset', async () => {
    expect.assertions(2);
    const userId = new mongoose.Types.ObjectId();
    await applyPlanChange(
      { user_id: userId, plan_code: 'anonymous', source: 'system_default' },
      buildApplyDeps(),
    );
    const deps = gatingDeps();

    for (let i = 0; i < 3; i++) {
      await checkBillingAccess({ userId, modelId: 'gpt-5.4-mini' }, deps);
    }

    await expectDenied(
      checkBillingAccess({ userId, modelId: 'gpt-5.4-mini' }, deps),
      'upgrade_required_quota',
    );
  });

  test('anonymous never reads a balance', async () => {
    const userId = new mongoose.Types.ObjectId();
    await applyPlanChange(
      { user_id: userId, plan_code: 'anonymous', source: 'system_default' },
      buildApplyDeps(),
    );
    const refreshMonthlyGrant = jest.fn();
    await checkBillingAccess(
      { userId, modelId: 'gpt-5.4-mini' },
      { ...gatingDeps(), refreshMonthlyGrant },
    );
    expect(refreshMonthlyGrant).not.toHaveBeenCalled();
  });
});

describe('checkBillingAccess — balance-driven quota', () => {
  /** Credits are the metering unit now: a plan's monthly grant lands in the
   *  user's Balance and `spendTokens` draws it down after each generation.
   *  The gate here only asks whether anything is left — it must not consume
   *  quota of its own, or a turn would be charged twice. */
  test('denies once the balance is exhausted', async () => {
    expect.assertions(3);
    const userId = new mongoose.Types.ObjectId();
    await applyPlanChange(
      { user_id: userId, plan_code: 'plus', source: 'admin' },
      buildApplyDeps(),
    );
    const deps = gatingDeps();

    await expect(
      checkBillingAccess({ userId, modelId: 'gpt-5.4-mini' }, deps),
    ).resolves.toBeUndefined();

    await mongoose.models.Balance.updateOne({ user: userId }, { $set: { tokenCredits: 0 } });

    await expectDenied(
      checkBillingAccess({ userId, modelId: 'gpt-5.4-mini' }, deps),
      'upgrade_required_quota',
    );
  });

  test("a plan change grants that plan's monthly credits", async () => {
    const userId = new mongoose.Types.ObjectId();
    await applyPlanChange(
      { user_id: userId, plan_code: 'plus', source: 'admin' },
      buildApplyDeps(),
    );

    const balance = await mongoose.models.Balance.findOne({ user: userId }).lean<BalanceDoc>();
    expect(balance?.tokenCredits).toBe(PLANS.plus.monthly_token_credits);
    /** Monthly reset is Balance's own auto-refill, not a quota period. */
    expect(balance?.autoRefillEnabled).toBe(true);
    expect(balance?.refillIntervalUnit).toBe('months');
    expect(balance?.refillIntervalValue).toBe(1);
    expect(balance?.refillAmount).toBe(PLANS.plus.monthly_token_credits);
  });

  test('the gate does not itself consume credits', async () => {
    const userId = new mongoose.Types.ObjectId();
    await applyPlanChange(
      { user_id: userId, plan_code: 'plus', source: 'admin' },
      buildApplyDeps(),
    );
    const deps = gatingDeps();

    const before = await mongoose.models.Balance.findOne({ user: userId }).lean<BalanceDoc>();
    for (let i = 0; i < 5; i++) {
      await checkBillingAccess({ userId, modelId: 'gpt-5.4-mini' }, deps);
    }
    const after = await mongoose.models.Balance.findOne({ user: userId }).lean<BalanceDoc>();

    expect(after?.tokenCredits).toBe(before?.tokenCredits);
  });
});

describe('checkBillingAccess — monthly grant renewal', () => {
  /** Ages the balance so the next gate check sees a full interval elapsed. */
  async function backdateLastRefill(userId: mongoose.Types.ObjectId, monthsAgo: number) {
    const when = new Date();
    when.setMonth(when.getMonth() - monthsAgo);
    await mongoose.models.Balance.updateOne({ user: userId }, { $set: { lastRefill: when } });
  }

  async function balanceOf(userId: mongoose.Types.ObjectId): Promise<BalanceDoc> {
    return (await mongoose.models.Balance.findOne({
      user: userId,
    }).lean()) as unknown as BalanceDoc;
  }

  test('a spent balance is restored once a month has passed', async () => {
    const userId = new mongoose.Types.ObjectId();
    await applyPlanChange(
      { user_id: userId, plan_code: 'plus', source: 'admin' },
      buildApplyDeps(),
    );

    await mongoose.models.Balance.updateOne({ user: userId }, { $set: { tokenCredits: 0 } });
    await backdateLastRefill(userId, 2);

    await expect(
      checkBillingAccess({ userId, modelId: 'gpt-5.5' }, gatingDeps()),
    ).resolves.toBeUndefined();

    expect((await balanceOf(userId)).tokenCredits).toBe(PLANS.plus.monthly_token_credits);
  });

  test('a spent balance stays spent inside the same month', async () => {
    expect.assertions(3);
    const userId = new mongoose.Types.ObjectId();
    await applyPlanChange(
      { user_id: userId, plan_code: 'plus', source: 'admin' },
      buildApplyDeps(),
    );

    await mongoose.models.Balance.updateOne({ user: userId }, { $set: { tokenCredits: 0 } });

    await expectDenied(
      checkBillingAccess({ userId, modelId: 'gpt-5.5' }, gatingDeps()),
      'upgrade_required_quota',
    );
    expect((await balanceOf(userId)).tokenCredits).toBe(0);
  });

  /** The subscription sells a monthly allowance, not a savings account: an
   *  untouched month must not stack on top of the next one. */
  test('renewal sets the grant rather than adding to it', async () => {
    const userId = new mongoose.Types.ObjectId();
    await applyPlanChange(
      { user_id: userId, plan_code: 'plus', source: 'admin' },
      buildApplyDeps(),
    );
    await backdateLastRefill(userId, 2);

    await checkBillingAccess({ userId, modelId: 'gpt-5.5' }, gatingDeps());

    expect((await balanceOf(userId)).tokenCredits).toBe(PLANS.plus.monthly_token_credits);
  });

  /** Two requests arriving together must not each hand out a grant. */
  test('concurrent checks renew exactly once', async () => {
    const userId = new mongoose.Types.ObjectId();
    await applyPlanChange(
      { user_id: userId, plan_code: 'plus', source: 'admin' },
      buildApplyDeps(),
    );
    await mongoose.models.Balance.updateOne({ user: userId }, { $set: { tokenCredits: 5 } });
    await backdateLastRefill(userId, 2);

    const deps = gatingDeps();
    await Promise.all([
      checkBillingAccess({ userId, modelId: 'gpt-5.5' }, deps),
      checkBillingAccess({ userId, modelId: 'gpt-5.5' }, deps),
      checkBillingAccess({ userId, modelId: 'gpt-5.5' }, deps),
    ]);

    expect((await balanceOf(userId)).tokenCredits).toBe(PLANS.plus.monthly_token_credits);
  });

  test('renewal reuses the interval grantMonthlyCredits armed', async () => {
    const userId = new mongoose.Types.ObjectId();
    await applyPlanChange(
      { user_id: userId, plan_code: 'beta', source: 'admin' },
      buildApplyDeps(),
    );

    const record = await balanceOf(userId);
    expect(record.autoRefillEnabled).toBe(true);
    expect(record.refillIntervalValue).toBe(1);
    expect(record.refillIntervalUnit).toBe('months');
  });
});
