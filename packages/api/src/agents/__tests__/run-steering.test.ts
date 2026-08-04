// Mock winston logger — `format` must be callable so @librechat/data-schemas
// dist module-load completes cleanly; see api/test/__mocks__/logger.js.
jest.mock('winston', () => ({
  createLogger: jest.fn(() => ({
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  })),
  format: Object.assign(
    jest.fn((fn) => () => ({ transform: fn })),
    {
      combine: jest.fn(),
      colorize: jest.fn(),
      simple: jest.fn(),
      label: jest.fn(),
      timestamp: jest.fn(),
      printf: jest.fn(),
      errors: jest.fn(),
      splat: jest.fn(),
      json: jest.fn(),
    },
  ),
  addColors: jest.fn(),
  transports: {
    Console: jest.fn(),
    DailyRotateFile: jest.fn(),
    File: jest.fn(),
  },
}));

// Mock env utilities so header resolution doesn't fail
jest.mock('~/utils/env', () => ({
  resolveHeaders: jest.fn((opts: { headers: unknown }) => opts?.headers ?? {}),
  createSafeUser: jest.fn(() => ({})),
}));

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}));

// Mock Run.create to capture the RunConfig it receives, while keeping every
// other export (HookRegistry, the SDK capability flags) real so the steering
// gate exercises actual capability checks rather than mocked booleans.
jest.mock('@librechat/agents', () => {
  const actual = jest.requireActual('@librechat/agents');
  return {
    ...actual,
    Run: {
      create: jest.fn().mockResolvedValue({
        processStream: jest.fn().mockResolvedValue(undefined),
      }),
    },
  };
});

import { Run } from '@librechat/agents';
import type { HookCallback } from '@librechat/agents';
import { createRun } from '~/agents/run';

/** Minimal RunAgent factory, mirroring run-summarization.test.ts's fixture. */
function makeAgent(
  overrides?: Record<string, unknown>,
): Record<string, unknown> & { id: string; provider: string; model: string } {
  return {
    id: 'agent_1',
    provider: 'openAI',
    endpoint: 'openAI',
    model: 'gpt-4o',
    tools: [],
    model_parameters: { model: 'gpt-4o' },
    maxContextTokens: 100_000,
    toolContextMap: {},
    ...overrides,
  };
}

async function callCreateRun(steering?: Parameters<typeof createRun>[0]['steering']) {
  const signal = new AbortController().signal;
  await createRun({
    agents: [makeAgent()] as never,
    signal,
    steering,
    streaming: true,
    streamUsage: true,
  });

  const createMock = Run.create as jest.Mock;
  expect(createMock).toHaveBeenCalledTimes(1);
  return createMock.mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('createRun — steering wiring', () => {
  it('passes no hooks/preemption to Run.create when steering is not provided', async () => {
    const runConfig = await callCreateRun(undefined);

    expect(runConfig.hooks).toBeUndefined();
    expect(runConfig.preemption).toBeUndefined();
  });

  it('registers the PostToolBatch drain hook and forwards preemption when steering is provided', async () => {
    const hook: HookCallback<'PostToolBatch'> = jest.fn().mockResolvedValue({});
    const preemptHook: HookCallback<'PreemptBoundary'> = jest.fn().mockResolvedValue({});
    const preemption = { shouldPreempt: jest.fn(() => false) };

    const runConfig = await callCreateRun({ hook, preemptHook, preemption });

    expect(runConfig.hooks).toBeDefined();
    const hooks = runConfig.hooks as InstanceType<typeof import('@librechat/agents').HookRegistry>;
    expect(hooks.getMatchers('PostToolBatch')).toEqual([{ hooks: [hook] }]);
    expect(hooks.getMatchers('PreemptBoundary')).toEqual([{ hooks: [preemptHook] }]);
    expect(runConfig.preemption).toBe(preemption);
  });

  it('registers only the PostToolBatch hook when no preemptHook is supplied', async () => {
    const hook: HookCallback<'PostToolBatch'> = jest.fn().mockResolvedValue({});

    const runConfig = await callCreateRun({ hook });

    expect(runConfig.hooks).toBeDefined();
    const hooks = runConfig.hooks as InstanceType<typeof import('@librechat/agents').HookRegistry>;
    expect(hooks.getMatchers('PostToolBatch')).toEqual([{ hooks: [hook] }]);
    expect(hooks.getMatchers('PreemptBoundary')).toEqual([]);
    expect(runConfig.preemption).toBeUndefined();
  });
});
