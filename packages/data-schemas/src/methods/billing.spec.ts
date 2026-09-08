import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import subscriptionSchema from '~/schema/subscription';
import quotaSchema from '~/schema/quota';
import auditLogSchema from '~/schema/auditLog';
import type { ISubscription } from '~/types/subscription';
import type { IQuota } from '~/types/quota';
import type { IAuditLog } from '~/types/auditLog';
import { createSubscriptionMethods } from './subscription';
import { createQuotaMethods } from './quota';
import { createAuditLogMethods } from './auditLog';
import { createBillingMethods } from './billing';

let mongoServer: MongoMemoryServer;
let Subscription: mongoose.Model<ISubscription>;
let Quota: mongoose.Model<IQuota>;
let AuditLog: mongoose.Model<IAuditLog>;

let subscriptionMethods: ReturnType<typeof createSubscriptionMethods>;
let quotaMethods: ReturnType<typeof createQuotaMethods>;
let auditLogMethods: ReturnType<typeof createAuditLogMethods>;
let billingMethods: ReturnType<typeof createBillingMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);
  Subscription =
    mongoose.models.Subscription ||
    mongoose.model<ISubscription>('Subscription', subscriptionSchema);
  Quota = mongoose.models.Quota || mongoose.model<IQuota>('Quota', quotaSchema);
  AuditLog = mongoose.models.AuditLog || mongoose.model<IAuditLog>('AuditLog', auditLogSchema);

  subscriptionMethods = createSubscriptionMethods(mongoose);
  quotaMethods = createQuotaMethods(mongoose);
  auditLogMethods = createAuditLogMethods(mongoose);
  billingMethods = createBillingMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  await Subscription.ensureIndexes();
  await Quota.ensureIndexes();
  await AuditLog.ensureIndexes();
});

describe('billing schemas', () => {
  const userId = new mongoose.Types.ObjectId();
  const adminId = new mongoose.Types.ObjectId();
  const targetUserId = new mongoose.Types.ObjectId();

  describe('Subscription', () => {
    test('creates a valid subscription document', async () => {
      const now = new Date();
      const end = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      const sub = await Subscription.create({
        user_id: userId,
        plan_code: 'plus',
        status: 'active',
        source: 'admin',
        current_period_start: now,
        current_period_end: end,
        external_ref: null,
        granted_by: adminId,
        metadata: {},
      });
      expect(sub._id).toBeDefined();
      expect(sub.plan_code).toBe('plus');
      expect(sub.status).toBe('active');
      expect(sub.source).toBe('admin');
    });

    test('rejects missing user_id', async () => {
      const now = new Date();
      const end = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      await expect(
        Subscription.create({
          plan_code: 'free',
          status: 'active',
          source: 'system_default',
          current_period_start: now,
          current_period_end: end,
        }),
      ).rejects.toThrow();
    });

    test('rejects invalid plan_code', async () => {
      const now = new Date();
      const end = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      await expect(
        Subscription.create({
          user_id: userId,
          plan_code: 'invalid_plan',
          status: 'active',
          source: 'admin',
          current_period_start: now,
          current_period_end: end,
        }),
      ).rejects.toThrow();
    });
  });

  describe('Quota', () => {
    test('creates a valid quota document', async () => {
      const periodStart = new Date('2026-06-01T00:00:00Z');
      const quota = await Quota.create({
        user_id: userId,
        period_start: periodStart,
        messages_used: 0,
      });
      expect(quota._id).toBeDefined();
      expect(quota.messages_used).toBe(0);
      expect(quota.period_start.toISOString()).toBe(periodStart.toISOString());
    });

    test('rejects missing user_id', async () => {
      await expect(
        Quota.create({
          period_start: new Date(),
          messages_used: 0,
        }),
      ).rejects.toThrow();
    });

    test('rejects duplicate {user_id, period_start} (unique index)', async () => {
      const periodStart = new Date('2026-06-01T00:00:00Z');
      await Quota.create({ user_id: userId, period_start: periodStart, messages_used: 0 });
      await expect(
        Quota.create({ user_id: userId, period_start: periodStart, messages_used: 5 }),
      ).rejects.toThrow();
    });
  });

  describe('AuditLog', () => {
    test('creates a valid audit log document', async () => {
      const log = await AuditLog.create({
        actor_id: adminId,
        action: 'plan.grant',
        target_user_id: targetUserId,
        payload: { plan_code: 'plus', days: 30 },
      });
      expect(log._id).toBeDefined();
      expect(log.action).toBe('plan.grant');
      expect(log.actor_id.toString()).toBe(adminId.toString());
    });

    test('rejects missing actor_id', async () => {
      await expect(
        AuditLog.create({
          action: 'plan.grant',
          target_user_id: targetUserId,
          payload: {},
        }),
      ).rejects.toThrow();
    });

    test('rejects missing action', async () => {
      await expect(
        AuditLog.create({
          actor_id: adminId,
          target_user_id: targetUserId,
          payload: {},
        }),
      ).rejects.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Methods tests
// ---------------------------------------------------------------------------

describe('billing methods', () => {
  const userId = new mongoose.Types.ObjectId();
  const adminId = new mongoose.Types.ObjectId();
  const targetUserId = new mongoose.Types.ObjectId();

  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  describe('SubscriptionMethods', () => {
    test('getActiveSubscriptionRecord returns newest non-expired active sub', async () => {
      /**
       * An hour, not a second. `getActiveSubscriptionRecord` filters on
       * `current_period_end: { $gt: new Date() }`, and `now` above is evaluated
       * when jest *loads* this file — not when this case runs — so the margin
       * has to cover every preceding case in the suite too. A one-second window
       * made this fail intermittently under a full run while passing in
       * isolation, which reads exactly like a real regression.
       *
       * The case is about "newest non-expired wins", not about a boundary, so
       * the exact margin carries no meaning beyond being comfortably clear of
       * the run time.
       */
      const older = new Date(now.getTime() - 60 * 60 * 1000);
      const newer = new Date(now.getTime() + 60 * 60 * 1000);

      await Subscription.create({
        user_id: userId,
        plan_code: 'plus',
        status: 'active',
        source: 'admin',
        current_period_start: periodStart,
        current_period_end: older, // already expired
        external_ref: null,
        granted_by: adminId,
        metadata: {},
      });
      const activeSub = await Subscription.create({
        user_id: userId,
        plan_code: 'trial',
        status: 'admin_granted',
        source: 'admin',
        current_period_start: periodStart,
        current_period_end: newer,
        external_ref: null,
        granted_by: adminId,
        metadata: {},
      });

      const result = await subscriptionMethods.getActiveSubscriptionRecord(userId);
      expect(result).not.toBeNull();
      expect(result!._id.toString()).toBe(activeSub._id.toString());
      expect(result!.plan_code).toBe('trial');
    });

    test('getActiveSubscriptionRecord returns null when no active sub exists', async () => {
      const otherId = new mongoose.Types.ObjectId();
      const result = await subscriptionMethods.getActiveSubscriptionRecord(otherId);
      expect(result).toBeNull();
    });

    test('expireActiveSubscriptions flips active→expired', async () => {
      const uid = new mongoose.Types.ObjectId();
      await Subscription.create({
        user_id: uid,
        plan_code: 'plus',
        status: 'active',
        source: 'admin',
        current_period_start: periodStart,
        current_period_end: periodEnd,
        external_ref: null,
        granted_by: null,
        metadata: {},
      });
      await Subscription.create({
        user_id: uid,
        plan_code: 'trial',
        status: 'trialing',
        source: 'admin',
        current_period_start: periodStart,
        current_period_end: periodEnd,
        external_ref: null,
        granted_by: null,
        metadata: {},
      });

      const modified = await subscriptionMethods.expireActiveSubscriptions(uid);
      expect(modified).toBe(2);

      const remaining = await Subscription.find({
        user_id: uid,
        status: { $in: ['active', 'trialing', 'admin_granted'] },
      });
      expect(remaining).toHaveLength(0);
    });

    test('createSubscription persists a new record', async () => {
      const uid = new mongoose.Types.ObjectId();
      const result = await subscriptionMethods.createSubscription({
        userId: uid,
        planCode: 'plus',
        status: 'active',
        source: 'admin',
        periodStart,
        periodEnd,
        grantedBy: adminId,
        metadata: { note: 'test' },
      });

      expect(result._id).toBeDefined();
      expect(result.plan_code).toBe('plus');
      expect(result.status).toBe('active');

      const inDb = await Subscription.findById(result._id).lean();
      expect(inDb).not.toBeNull();
    });

    it('findActiveSubscriptions returns one row per user, entitled statuses only', async () => {
      const userA = new mongoose.Types.ObjectId();
      const userB = new mongoose.Types.ObjectId();
      const userC = new mongoose.Types.ObjectId();
      const now = new Date();
      await Subscription.create([
        {
          user_id: userA,
          plan_code: 'plus',
          status: 'active',
          source: 'admin',
          current_period_start: now,
          current_period_end: now,
        },
        {
          user_id: userB,
          plan_code: 'trial',
          status: 'trialing',
          source: 'admin',
          current_period_start: now,
          current_period_end: now,
        },
        {
          user_id: userC,
          plan_code: 'max',
          status: 'expired',
          source: 'admin',
          current_period_start: now,
          current_period_end: now,
        },
      ]);

      const rows = await subscriptionMethods.findActiveSubscriptions([
        userA.toString(),
        userB.toString(),
        userC.toString(),
      ]);

      const byUser = new Map(rows.map((row) => [row.user_id, row.plan_code]));
      expect(byUser.get(userA.toString())).toBe('plus');
      expect(byUser.get(userB.toString())).toBe('trial');
      /** An expired subscription grants nothing, so it must not appear. */
      expect(byUser.has(userC.toString())).toBe(false);
    });

    it('findActiveSubscriptions returns an empty array for an empty id list', async () => {
      expect(await subscriptionMethods.findActiveSubscriptions([])).toEqual([]);
    });
  });

  describe('QuotaMethods', () => {
    test('incrementQuota allows up to limit, then returns null', async () => {
      const uid = new mongoose.Types.ObjectId();
      const limit = 3;
      const ps = new Date('2026-06-01T00:00:00Z');

      for (let i = 0; i < limit; i++) {
        const doc = await quotaMethods.incrementQuota({ userId: uid, periodStart: ps, limit });
        expect(doc).not.toBeNull();
        expect(doc!.messages_used).toBe(i + 1);
      }

      const over = await quotaMethods.incrementQuota({ userId: uid, periodStart: ps, limit });
      expect(over).toBeNull();
    });

    test('resetQuota sets messages_used to 0', async () => {
      const uid = new mongoose.Types.ObjectId();
      const ps = new Date('2026-06-01T00:00:00Z');
      /** Written directly: `createQuota` is gone. It had one caller,
       *  `applyPlanChange`, writing a row nothing ever read. */
      await Quota.create({ user_id: uid, period_start: ps, messages_used: 5 });

      const reset = await quotaMethods.resetQuota({ userId: uid, periodStart: ps });
      expect(reset).not.toBeNull();
      expect(reset!.messages_used).toBe(0);
    });

    /**
     * Concurrency / race test (spec §10.2):
     * Fire 20 parallel incrementQuota calls with limit=10.
     * Exactly 10 should succeed (non-null); 10 should return null.
     * This proves the atomic filter prevents quota overrun.
     */
    test('concurrent incrementQuota: exactly limit succeed (race test)', async () => {
      const TOTAL = 20;
      const LIMIT = 10;
      const uid = new mongoose.Types.ObjectId();
      const ps = new Date('2026-07-01T00:00:00Z');

      const results = await Promise.all(
        Array.from({ length: TOTAL }, () =>
          quotaMethods.incrementQuota({ userId: uid, periodStart: ps, limit: LIMIT }),
        ),
      );

      const successes = results.filter((r) => r !== null).length;
      const failures = results.filter((r) => r === null).length;

      expect(successes).toBe(LIMIT);
      expect(failures).toBe(TOTAL - LIMIT);
    }, 15000);
  });

  describe('AuditLogMethods', () => {
    test('writeAuditLog persists a record', async () => {
      const result = await auditLogMethods.writeAuditLog({
        actorId: adminId,
        action: 'plan.grant',
        targetUserId,
        payload: { plan_code: 'plus', days: 30 },
      });

      expect(result._id).toBeDefined();
      expect(result.action).toBe('plan.grant');

      const inDb = await AuditLog.findById(result._id).lean();
      expect(inDb).not.toBeNull();
      expect(inDb!.action).toBe('plan.grant');
    });

    test('writeAuditLog stores payload correctly', async () => {
      const payload = { plan_code: 'trial', days: 7, reason: 'onboarding' };
      const result = await auditLogMethods.writeAuditLog({
        actorId: adminId,
        action: 'plan.trial',
        targetUserId,
        payload,
      });

      const inDb = await AuditLog.findById(result._id).lean();
      expect(inDb!.payload).toMatchObject(payload);
    });
  });

  describe('deleteBillingRecords', () => {
    /**
     * The omission this exists for: `Subscription` and `Quota` arrived with plan
     * gating and were never added to any of the three deletion paths. A user
     * could delete their account, be told every trace was gone, and leave their
     * plan record behind — and `config/backfill-plan-credits.js`, which scans
     * active subscriptions, would then grant the deleted account a fresh
     * balance.
     */
    test('removes both collections for the user', async () => {
      const uid = new mongoose.Types.ObjectId();
      await subscriptionMethods.createSubscription({
        userId: uid,
        planCode: 'plus',
        status: 'active',
        source: 'admin',
        periodStart: new Date(),
        periodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });
      await Quota.create({ user_id: uid, period_start: new Date(0), messages_used: 3 });

      const result = await billingMethods.deleteBillingRecords(uid);

      expect(result).toEqual({ subscriptions: 1, quotas: 1 });
      expect(await Subscription.countDocuments({ user_id: uid })).toBe(0);
      expect(await Quota.countDocuments({ user_id: uid })).toBe(0);
    });

    test('leaves other users alone', async () => {
      const target = new mongoose.Types.ObjectId();
      const bystander = new mongoose.Types.ObjectId();
      for (const uid of [target, bystander]) {
        await subscriptionMethods.createSubscription({
          userId: uid,
          planCode: 'plus',
          status: 'active',
          source: 'admin',
          periodStart: new Date(),
          periodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        });
        await Quota.create({ user_id: uid, period_start: new Date(0), messages_used: 1 });
      }

      await billingMethods.deleteBillingRecords(target);

      expect(await Subscription.countDocuments({ user_id: bystander })).toBe(1);
      expect(await Quota.countDocuments({ user_id: bystander })).toBe(1);
    });

    /** Every deletion path calls this unconditionally, and most accounts have
     *  no quota row at all — throwing on "nothing to delete" would fail the
     *  whole account deletion. */
    test('reports zero rather than throwing when there is nothing to delete', async () => {
      const result = await billingMethods.deleteBillingRecords(new mongoose.Types.ObjectId());
      expect(result).toEqual({ subscriptions: 0, quotas: 0 });
    });

    /** Callers hold the id in both shapes: `deleteUserController` passes
     *  `user._id`, the admin handler a re-parsed ObjectId, and Express params
     *  arrive as strings. */
    test('accepts the id as a string', async () => {
      const uid = new mongoose.Types.ObjectId();
      await Quota.create({ user_id: uid, period_start: new Date(0), messages_used: 1 });

      const result = await billingMethods.deleteBillingRecords(uid.toString());

      expect(result.quotas).toBe(1);
    });
  });
});
