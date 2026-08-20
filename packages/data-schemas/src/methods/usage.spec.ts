import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels } from '~/models';
import { createUsageMethods } from './usage';

let mongoServer: MongoMemoryServer;
let usageMethods: ReturnType<typeof createUsageMethods>;

const USER_A = new mongoose.Types.ObjectId();
const USER_B = new mongoose.Types.ObjectId();
const USER_C = new mongoose.Types.ObjectId();

/** Transactions store spends as negatives; the pipeline must return positives. */
async function seed() {
  const Transaction = mongoose.models.Transaction;
  await Transaction.create([
    {
      user: USER_A,
      tokenType: 'prompt',
      model: 'glm-5.2',
      context: 'message',
      rate: 0.966,
      rawAmount: -387,
      tokenValue: -1161,
      inputTokens: -259,
      writeTokens: 0,
      readTokens: -128,
      createdAt: new Date('2026-08-10T05:00:00Z'),
    },
    {
      user: USER_A,
      tokenType: 'completion',
      model: 'glm-5.2',
      context: 'message',
      rate: 3.036,
      rawAmount: -100,
      tokenValue: -303,
      createdAt: new Date('2026-08-10T06:00:00Z'),
    },
    {
      user: USER_A,
      tokenType: 'prompt',
      model: 'kimi-k2.6',
      context: 'title',
      rate: 0.95,
      rawAmount: -50,
      tokenValue: -47,
      createdAt: new Date('2026-08-11T01:00:00Z'),
    },
    {
      user: USER_B,
      tokenType: 'prompt',
      model: 'glm-5.2',
      context: 'message',
      rate: 0.966,
      rawAmount: -10,
      tokenValue: -9,
      createdAt: new Date('2026-08-11T02:00:00Z'),
    },
    {
      user: USER_B,
      tokenType: 'prompt',
      model: 'glm-5.2',
      context: 'message',
      rate: 0.966,
      rawAmount: -999,
      tokenValue: -999,
      createdAt: new Date('2026-07-01T00:00:00Z'),
    },
    {
      user: USER_C,
      tokenType: 'prompt',
      model: 'glm-5.2',
      context: 'message',
      rate: 1,
      rawAmount: -21,
      tokenValue: -21,
      createdAt: new Date('2026-08-01T00:00:00Z'),
    },
    {
      user: USER_C,
      tokenType: 'prompt',
      model: 'glm-5.2',
      context: 'message',
      rate: 1,
      rawAmount: -34,
      tokenValue: -34,
      createdAt: new Date('2026-08-31T23:59:59Z'),
    },
  ]);
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  usageMethods = createUsageMethods(mongoose);
  await seed();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

const RANGE = { from: new Date('2026-08-01T00:00:00Z'), to: new Date('2026-08-31T23:59:59Z') };

describe('aggregateUsage', () => {
  it('sums spend per user as a positive number', async () => {
    const result = await usageMethods.aggregateUsage(RANGE);
    const a = result.byUser.find((row) => row.user_id === USER_A.toString());
    expect(a).toBeDefined();
    expect(a?.credits).toBe(1161 + 303 + 47);
    expect(a?.calls).toBe(3);
  });

  it('excludes documents outside the range', async () => {
    const result = await usageMethods.aggregateUsage(RANGE);
    const b = result.byUser.find((row) => row.user_id === USER_B.toString());
    /** The July document must not be counted. */
    expect(b?.credits).toBe(9);
    expect(b?.calls).toBe(1);
  });

  it('sorts users by spend descending', async () => {
    const result = await usageMethods.aggregateUsage(RANGE);
    expect(result.byUser[0].user_id).toBe(USER_A.toString());
  });

  it('lists the distinct models a user touched', async () => {
    const result = await usageMethods.aggregateUsage(RANGE);
    const a = result.byUser.find((row) => row.user_id === USER_A.toString());
    expect(a?.models.sort()).toEqual(['glm-5.2', 'kimi-k2.6']);
  });

  it('splits models by context so titling is visible separately', async () => {
    const result = await usageMethods.aggregateUsage(RANGE);
    const titleRow = result.byModel.find((row) => row.context === 'title');
    expect(titleRow?.model).toBe('kimi-k2.6');
    expect(titleRow?.credits).toBe(47);
  });

  it('returns cache token counts as positives', async () => {
    const result = await usageMethods.aggregateUsage(RANGE);
    const row = result.byModel.find((r) => r.model === 'glm-5.2' && r.context === 'message');
    expect(row?.input_tokens).toBe(259);
    expect(row?.read_tokens).toBe(128);
    expect(row?.write_tokens).toBe(0);
  });

  it('groups by UTC day, ascending', async () => {
    const result = await usageMethods.aggregateUsage(RANGE);
    expect(result.byDay.map((d) => d.day)).toEqual([
      '2026-08-01',
      '2026-08-10',
      '2026-08-11',
      '2026-08-31',
    ]);
    expect(result.byDay[1].credits).toBe(1161 + 303);
  });

  it('includes documents exactly on the inclusive range boundaries', async () => {
    const result = await usageMethods.aggregateUsage(RANGE);
    const c = result.byUser.find((row) => row.user_id === USER_C.toString());
    expect(c?.credits).toBe(21 + 34);
    expect(c?.calls).toBe(2);

    const days = result.byDay;
    expect(days.find((d) => d.day === '2026-08-01')?.credits).toBe(21);
    expect(days.find((d) => d.day === '2026-08-31')?.credits).toBe(34);
  });

  it('returns empty arrays rather than throwing when nothing matches', async () => {
    const result = await usageMethods.aggregateUsage({
      from: new Date('2020-01-01T00:00:00Z'),
      to: new Date('2020-01-02T00:00:00Z'),
    });
    expect(result).toEqual({ byUser: [], byModel: [], byDay: [] });
  });
});
