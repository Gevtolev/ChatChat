import type { AdminUsageUserRow } from 'librechat-data-provider';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { createAdminUsageHandlers } from './usage';

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

const EMPTY = { byUser: [], byModel: [], byDay: [] };

function makeDeps(overrides: Partial<Parameters<typeof createAdminUsageHandlers>[0]> = {}) {
  return {
    aggregateUsage: jest.fn().mockResolvedValue(EMPTY),
    findActiveSubscriptions: jest.fn().mockResolvedValue([]),
    findUserEmails: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

const req = (query: Record<string, string>) => ({ query }) as unknown as ServerRequest;

describe('getUsage — request validation', () => {
  it('rejects a missing range', async () => {
    const res = mockRes();
    await createAdminUsageHandlers(makeDeps()).getUsage(req({}), res);
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unparseable date', async () => {
    const res = mockRes();
    await createAdminUsageHandlers(makeDeps()).getUsage(
      req({ from: 'not-a-date', to: '2026-08-31T00:00:00Z' }),
      res,
    );
    expect(res.statusCode).toBe(400);
  });

  it('rejects an inverted range', async () => {
    const res = mockRes();
    await createAdminUsageHandlers(makeDeps()).getUsage(
      req({ from: '2026-08-31T00:00:00Z', to: '2026-08-01T00:00:00Z' }),
      res,
    );
    expect(res.statusCode).toBe(400);
  });
});

const RANGE = { from: '2026-08-01T00:00:00Z', to: '2026-08-31T00:00:00Z' };

describe('getUsage — margin', () => {
  /** The three paid tiers are all monthly, so proration is an identity for
   *  them and would pass whether or not the code prorates at all. `trial` is
   *  the only plan left whose period is not 30 days, so it is what keeps this
   *  guarantee honest — a yearly tier added later would otherwise report twelve
   *  times its real monthly revenue with nothing catching it. */
  it('prorates a plan whose period is not 30 days to a 30-day figure', async () => {
    const deps = makeDeps({
      aggregateUsage: jest.fn().mockResolvedValue({
        byUser: [{ user_id: 'u1', credits: 1_000_000, calls: 3, models: ['glm-5.2'] }],
        byModel: [],
        byDay: [],
      }),
      findActiveSubscriptions: jest.fn().mockResolvedValue([{ user_id: 'u1', plan_code: 'trial' }]),
      findUserEmails: jest.fn().mockResolvedValue([{ _id: 'u1', email: 'a@example.com' }]),
    });
    const res = mockRes();
    await createAdminUsageHandlers(deps).getUsage(req(RANGE), res);

    const row = (res.body as { users: AdminUsageUserRow[] }).users[0];
    /** 100 cents over 7 days -> 428.57 cents per 30 days -> 4_285_714 credits */
    expect(row.revenue_credits).toBe(Math.round((100 * 30 * 10_000) / 7));
    expect(row.margin_credits).toBe((row.revenue_credits as number) - 1_000_000);
  });

  it('treats a user with no subscription as the implicit free plan', async () => {
    const deps = makeDeps({
      aggregateUsage: jest.fn().mockResolvedValue({
        byUser: [{ user_id: 'u2', credits: 500, calls: 1, models: [] }],
        byModel: [],
        byDay: [],
      }),
      findUserEmails: jest.fn().mockResolvedValue([{ _id: 'u2', email: 'b@example.com' }]),
    });
    const res = mockRes();
    await createAdminUsageHandlers(deps).getUsage(req(RANGE), res);

    const row = (res.body as { users: AdminUsageUserRow[] }).users[0];
    expect(row.plan_code).toBeNull();
    expect(row.plan_recognized).toBe(true);
    expect(row.revenue_credits).toBe(0);
  });

  it('flags an unknown plan instead of scoring it as free', async () => {
    const deps = makeDeps({
      aggregateUsage: jest.fn().mockResolvedValue({
        byUser: [{ user_id: 'u3', credits: 10, calls: 1, models: [] }],
        byModel: [],
        byDay: [],
      }),
      findActiveSubscriptions: jest
        .fn()
        .mockResolvedValue([{ user_id: 'u3', plan_code: 'legacy_gold' }]),
      findUserEmails: jest.fn().mockResolvedValue([{ _id: 'u3', email: 'c@example.com' }]),
    });
    const res = mockRes();
    await createAdminUsageHandlers(deps).getUsage(req(RANGE), res);

    const row = (res.body as { users: AdminUsageUserRow[] }).users[0];
    expect(row.plan_recognized).toBe(false);
    expect(row.revenue_credits).toBe(0);
  });

  it('keeps a deleted user visible with a null email', async () => {
    const deps = makeDeps({
      aggregateUsage: jest.fn().mockResolvedValue({
        byUser: [{ user_id: 'ghost', credits: 42, calls: 1, models: [] }],
        byModel: [],
        byDay: [],
      }),
    });
    const res = mockRes();
    await createAdminUsageHandlers(deps).getUsage(req(RANGE), res);

    const row = (res.body as { users: AdminUsageUserRow[] }).users[0];
    expect(row.user_id).toBe('ghost');
    expect(row.email).toBeNull();
    expect(row.cost_credits).toBe(42);
  });

  it('looks up only the users that actually spent', async () => {
    const deps = makeDeps({
      aggregateUsage: jest.fn().mockResolvedValue({
        byUser: [{ user_id: 'u1', credits: 1, calls: 1, models: [] }],
        byModel: [],
        byDay: [],
      }),
    });
    await createAdminUsageHandlers(deps).getUsage(req(RANGE), mockRes());
    expect(deps.findUserEmails).toHaveBeenCalledWith(['u1']);
    expect(deps.findActiveSubscriptions).toHaveBeenCalledWith(['u1']);
  });

  it('passes model and day views through untouched', async () => {
    const models = [
      {
        model: 'glm-5.2',
        context: 'title',
        credits: 47,
        calls: 1,
        input_tokens: 10,
        write_tokens: 0,
        read_tokens: 2,
      },
    ];
    const days = [{ day: '2026-08-10', credits: 1464 }];
    const deps = makeDeps({
      aggregateUsage: jest.fn().mockResolvedValue({ byUser: [], byModel: models, byDay: days }),
    });
    const res = mockRes();
    await createAdminUsageHandlers(deps).getUsage(req(RANGE), res);

    const body = res.body as { models: unknown[]; days: unknown[] };
    /** The aggregate's `credits` is renamed to `cost_credits` and does not
     *  survive alongside it — spreading the input row here would wrongly assert
     *  both keys are present. */
    expect(body.models).toEqual([
      {
        model: 'glm-5.2',
        context: 'title',
        cost_credits: 47,
        calls: 1,
        input_tokens: 10,
        write_tokens: 0,
        read_tokens: 2,
      },
    ]);
    expect(body.days).toEqual([{ day: '2026-08-10', cost_credits: 1464 }]);
  });

  it('returns empty arrays for a range with no traffic', async () => {
    const res = mockRes();
    await createAdminUsageHandlers(makeDeps()).getUsage(req(RANGE), res);
    /** The handler echoes the range through Date#toISOString, which appends
     *  milliseconds — compare against the normalised form, not the input. */
    expect(res.body).toEqual({
      from: new Date(RANGE.from).toISOString(),
      to: new Date(RANGE.to).toISOString(),
      users: [],
      models: [],
      days: [],
    });
  });
});
