import { buildGatingDeps, buildPlanChangeDeps } from './deps';
import type { BillingDbMethods } from './deps';

/**
 * These assert the *shape* the factories hand back, not the behaviour of the
 * methods inside it. That is the whole point: every one of the four production
 * call sites is JavaScript, so nothing checked that the `deps` object it built
 * by hand was complete, and four of them were not. The gate silently lost
 * `getBalanceCredits`; three plan-change callers lost `grantMonthlyCredits`.
 *
 * A missing key is a `TypeError` thrown from inside the billing code on the
 * first request that reaches the branch needing it — which for the gate meant
 * every `free` user the moment enforcement was switched on.
 */

/** Stand-ins: the factories only forward references, so identity is all we check. */
const db = {
  getActiveSubscriptionRecord: jest.fn(),
  refreshMonthlyGrant: jest.fn(),
  incrementQuota: jest.fn(),
  expireActiveSubscriptions: jest.fn(),
  grantMonthlyCredits: jest.fn(),
  createSubscription: jest.fn(),
  createQuota: jest.fn(),
} as unknown as BillingDbMethods;

describe('buildGatingDeps', () => {
  const REQUIRED = ['getActiveSubscriptionRecord', 'refreshMonthlyGrant', 'incrementQuota'];

  test('supplies every key GatingDeps declares', () => {
    const deps = buildGatingDeps(db);
    for (const key of REQUIRED) {
      expect(typeof deps[key as keyof typeof deps]).toBe('function');
    }
  });

  test('carries no keys beyond the interface', () => {
    expect(Object.keys(buildGatingDeps(db)).sort()).toEqual([...REQUIRED].sort());
  });

  test('forwards the db methods themselves rather than wrapping them', () => {
    const deps = buildGatingDeps(db);
    expect(deps.refreshMonthlyGrant).toBe(db.refreshMonthlyGrant);
    expect(deps.incrementQuota).toBe(db.incrementQuota);
  });
});

describe('buildPlanChangeDeps', () => {
  const REQUIRED = [
    'getActiveSubscriptionRecord',
    'expireActiveSubscriptions',
    'grantMonthlyCredits',
    'createSubscription',
    'createQuota',
  ];

  test('supplies every key PlanChangeDeps declares', () => {
    const deps = buildPlanChangeDeps(db);
    for (const key of REQUIRED) {
      expect(typeof deps[key as keyof typeof deps]).toBe('function');
    }
  });

  test('carries no keys beyond the interface', () => {
    expect(Object.keys(buildPlanChangeDeps(db)).sort()).toEqual([...REQUIRED].sort());
  });

  /** The omission that broke `set-plan` for every plan carrying credits, and
   *  registration for anyone upgrading from an anonymous session. */
  test('includes grantMonthlyCredits', () => {
    expect(buildPlanChangeDeps(db).grantMonthlyCredits).toBe(db.grantMonthlyCredits);
  });
});
