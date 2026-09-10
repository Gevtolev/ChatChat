import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { CREDIT_DISPLAY_DIVISOR } from 'librechat-data-provider';
import { createModels, createMethods } from '@librechat/data-schemas';
import type { IQuotaLean } from '@librechat/data-schemas';
import { matchModelName, findMatchingPattern } from '~/utils/tokens';
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
    grantMonthlyCredits: m.grantMonthlyCredits,
  };
}

/**
 * The real matchers, adapted to what `createMethods` declares — `api/models`
 * wires these same two functions in untyped JavaScript, so the shapes have
 * never had to line up. Re-implementing them here instead would test a copy;
 * the premium-rate band depends on which key the model name resolves to, which
 * is the whole thing being asserted.
 */
const nameMatchers = {
  matchModelName: (model: string): string | undefined => matchModelName(model),
  /** The map is only ever read for its keys, so narrowing it is safe. */
  findMatchingPattern: (
    model: string,
    values: Record<string, number | Record<string, number>>,
  ): string | undefined =>
    findMatchingPattern(model, values as Record<string, number>) ?? undefined,
};

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

/** `unknown` because the gate now resolves to the plan it applied; these
 *  cases only care that it rejected. */
async function expectDenied(promise: Promise<unknown>, expectedCode: string): Promise<void> {
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
      'insufficient_credits',
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
    ).resolves.toBeDefined();
  });

  /** A row whose `plan_code` is no longer in `PLANS` — what retiring a plan
   *  leaves behind, since the schema enum only constrains writes. This used to
   *  dereference `undefined` and 500 every message that user sent. */
  test('retired plan_code falls back to free rather than throwing', async () => {
    /** Four, not two: `expectDenied` asserts both the rejection and its code. */
    expect.assertions(4);
    const userId = new mongoose.Types.ObjectId();
    const deps = {
      ...gatingDeps(),
      getActiveSubscriptionRecord: async () => ({
        user_id: userId,
        plan_code: 'pro_q',
        status: 'active',
      }),
    } as unknown as Parameters<typeof checkBillingAccess>[1];

    /** Both calls are refused, and the point is *which* refusal: each one is a
     *  distinct check reached in order, which only happens if a real plan was
     *  resolved. An expensive model stops at the tier gate — free allows cheap
     *  only... */
    await expectDenied(
      checkBillingAccess({ userId, modelId: 'claude-opus-5' }, deps),
      'upgrade_required_model',
    );
    /** ...while a cheap one clears that gate and stops at the quota instead,
     *  this account having no Balance row. Before the fallback both threw a
     *  TypeError on `plan.code`, indistinguishable from each other and from a
     *  genuine outage. */
    await expectDenied(
      checkBillingAccess({ userId, modelId: 'gpt-5.4-nano' }, deps),
      'insufficient_credits',
    );
  });

  /** Spending clamps at zero, so without an estimate a user one credit from
   *  empty could start a request costing millions and we would absorb the
   *  difference. Prompt tokens only — completion length is unknowable
   *  beforehand — so this bounds the overdraft rather than removing it. */
  describe('overdraft', () => {
    const RATE_1 = { 'gpt-5.4-nano': { prompt: 1, completion: 1 } };

    async function fundedUser(credits: number) {
      const userId = new mongoose.Types.ObjectId();
      await applyPlanChange(
        { user_id: userId, plan_code: 'plus', source: 'admin' },
        buildApplyDeps(),
      );
      await mongoose.models.Balance.updateOne(
        { user: userId },
        { $set: { tokenCredits: credits } },
      );
      return userId;
    }

    test('refuses a call the remaining balance cannot cover', async () => {
      expect.assertions(2);
      const userId = await fundedUser(1_000);

      await expectDenied(
        checkBillingAccess(
          {
            userId,
            modelId: 'gpt-5.4-nano',
            promptTokens: 500_000,
            endpointTokenConfig: RATE_1,
          },
          gatingDeps(),
        ),
        'insufficient_credits',
      );
    });

    /** Above 200k input tokens `gemini-3.1` costs 4 per prompt token instead of
     *  2. Pricing that band needs `inputTokenCount`, and the estimate omitted
     *  it — so the check under-priced by half on exactly the calls it exists to
     *  refuse, the largest ones. Needs the real name matchers, which
     *  `createMethods(mongoose)` stubs out. */
    test('prices a long prompt at the premium rate', async () => {
      expect.assertions(2);
      const userId = await fundedUser(700_000);
      const deps = buildGatingDeps(createMethods(mongoose, nameMatchers));

      await expectDenied(
        checkBillingAccess(
          { userId, modelId: 'gemini-3.1-pro-preview', promptTokens: 250_000 },
          deps,
        ),
        'insufficient_credits',
      );
    });

    test('reports the shortfall in display credits, not internal cost units', async () => {
      /** The only unit the user has ever been shown. Reporting raw
       *  `tokenCredits` would put a number on screen that matches nothing in
       *  the product — the old wording quoted 14,950,000 and called them
       *  "messages". */
      const userId = await fundedUser(14_950);

      let caught: unknown;
      try {
        await checkBillingAccess(
          { userId, modelId: 'gpt-5.4-nano', promptTokens: 500_000, endpointTokenConfig: RATE_1 },
          gatingDeps(),
        );
      } catch (err) {
        caught = err;
      }

      const payload: { code: string; remaining: number; required: number } = JSON.parse(
        (caught as Error).message,
      );
      expect(payload.code).toBe('insufficient_credits');
      expect(payload.remaining).toBe(1_000);
      expect(payload.required).toBe(Math.ceil(500_000 / CREDIT_DISPLAY_DIVISOR));
    });

    test('allows a call the balance covers', async () => {
      const userId = await fundedUser(1_000_000);

      await expect(
        checkBillingAccess(
          {
            userId,
            modelId: 'gpt-5.4-nano',
            promptTokens: 500_000,
            endpointTokenConfig: RATE_1,
          },
          gatingDeps(),
        ),
      ).resolves.toBeDefined();
    });

    /** A caller that cannot estimate must not be blocked: a missing number is
     *  not evidence that the call is unaffordable. */
    test('falls back to the old zero-balance rule when no estimate is given', async () => {
      const userId = await fundedUser(1_000);

      await expect(
        checkBillingAccess({ userId, modelId: 'gpt-5.4-nano' }, gatingDeps()),
      ).resolves.toBeDefined();
    });
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

    /** Resolves to the plan it applied — `free` here, since the escape hatch
     *  exempts the user rather than upgrading them. */
    await expect(checkBillingAccess({ userId, modelId: 'gpt-5.5' }, deps)).resolves.toBe('free');

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
    ).resolves.toBeDefined();
    await expect(
      checkBillingAccess({ userId, modelId: 'x-ai/grok-4.3' }, deps),
    ).resolves.toBeDefined();
    await expect(
      checkBillingAccess({ userId, modelId: 'x-ai/grok-4.3' }, deps),
    ).resolves.toBeDefined();
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
    ).resolves.toBeDefined();
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
    /** Anonymous is the only message-counted plan, and this payload is only
     *  ever about messages. A credit-metered plan denies with
     *  `insufficient_credits` and a credit count — reusing this code told a
     *  paying customer they had run out of *messages*, quoting their credit
     *  grant as the number. */
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

  /**
   * The trial counter belongs to a `User` that MongoDB collects after 7 days,
   * and TTL does not cascade — so the counter carries its own expiry. Set a day
   * later than the user's, never earlier: a counter that vanished first would
   * hand a visitor still inside their trial three more messages.
   */
  test('the anonymous counter expires, a day after its user would', async () => {
    const userId = new mongoose.Types.ObjectId();
    await applyPlanChange(
      { user_id: userId, plan_code: 'anonymous', source: 'system_default' },
      buildApplyDeps(),
    );

    await checkBillingAccess({ userId, modelId: 'gpt-5.4-mini' }, gatingDeps());

    const row = await mongoose.models.Quota.findOne({ user_id: userId }).lean<IQuotaLean>();
    const USER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
    expect(row?.expiresAt).toBeInstanceOf(Date);
    expect(row!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + USER_TTL_MS);
  });

  /** `$setOnInsert`, so message two does not push the expiry a day further out
   *  each time — the trial would then outlive its own user indefinitely. */
  test('a second message does not extend the counter expiry', async () => {
    const userId = new mongoose.Types.ObjectId();
    await applyPlanChange(
      { user_id: userId, plan_code: 'anonymous', source: 'system_default' },
      buildApplyDeps(),
    );
    const deps = gatingDeps();

    await checkBillingAccess({ userId, modelId: 'gpt-5.4-mini' }, deps);
    const first = await mongoose.models.Quota.findOne({ user_id: userId }).lean<IQuotaLean>();
    await checkBillingAccess({ userId, modelId: 'gpt-5.4-mini' }, deps);
    const second = await mongoose.models.Quota.findOne({ user_id: userId }).lean<IQuotaLean>();

    expect(second!.messages_used).toBe(2);
    expect(second!.expiresAt!.getTime()).toBe(first!.expiresAt!.getTime());
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
    ).resolves.toBeDefined();

    await mongoose.models.Balance.updateOne({ user: userId }, { $set: { tokenCredits: 0 } });

    await expectDenied(
      checkBillingAccess({ userId, modelId: 'gpt-5.4-mini' }, deps),
      'insufficient_credits',
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
    ).resolves.toBeDefined();

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
      'insufficient_credits',
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
