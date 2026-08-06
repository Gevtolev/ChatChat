/**
 * Regression test for the "ghost chip" gap: v2's parked-steer read
 * (`GenerationJobManager.steering.claimDetailed`, backing `/chat/status`) is
 * a replayable lease, not a destructive GETDEL. Upstream turns a *consumed*
 * lease invisible to later readers through two environments this fork never
 * ported into `api/server/controllers/agents/request.js`:
 *
 *   1. `recoveredSteerId` (+ its proof payload) threaded into
 *      `GenerationJobManager.createJob` so the store leases the exact parked
 *      item while the recovery generation is active (upstream request.js:874).
 *   2. `GenerationJobManager.steering.consumeRecovered(...)` called only
 *      after the recovered turn's user message is durably saved (upstream
 *      request.js:910-918).
 *
 * Without both, a steer that was already delivered via terminal drain and
 * auto-resent as a new turn (exactly what `useQueueDrain` does once the
 * FINAL event's `pendingSteers` gets converted to a queued follow-up) still
 * reappears on the NEXT `/chat/status` read (i.e. after a page refresh) as
 * if it had never been recovered -- the words were already sent and
 * answered, yet a ghost chip resurrects them.
 *
 * Uses the REAL `GenerationJobManager` (default real `InMemoryJobStore`),
 * mirroring `request.steerTerminalRecovery.spec.js`.
 */

const mockSaveMessage = jest.fn().mockResolvedValue({});
const mockGetConvo = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  getViolationInfo: jest.fn(),
  buildMessageFiles: jest.fn(() => []),
  sanitizeMessageForTransmit: jest.fn((message) => message),
  isSteerPreemptSupported: jest.fn(() => false),
}));

jest.mock('~/server/cleanup', () => ({
  disposeClient: jest.fn(),
  clientRegistry: null,
  requestDataMap: {
    set: jest.fn(),
    has: jest.fn(() => false),
    delete: jest.fn(),
  },
}));

jest.mock('~/server/middleware', () => ({
  handleAbortError: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('~/cache', () => ({
  logViolation: jest.fn(),
}));

jest.mock('~/models', () => ({
  saveMessage: (...args) => mockSaveMessage(...args),
  getConvo: (...args) => mockGetConvo(...args),
}));

const { GenerationJobManager } = require('@librechat/api');
const AgentController = require('../request');

const STEER_TEXT = 'actually, focus on X';

async function waitFor(predicate, { timeout = 2000, interval = 5 } = {}) {
  const start = Date.now();
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() - start > timeout) {
      throw new Error('waitFor: condition not met before timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

function buildRes() {
  const res = {
    headersSent: false,
    json: jest.fn(() => res),
    status: jest.fn(() => res),
    set: jest.fn(() => res),
  };
  return res;
}

/** First run: a plain "no tool calls" completion with one steer enqueued
 * mid-run from inside the fake client's `sendMessage`, exactly the way a
 * real `/chat/steer` POST would from another request (same setup as
 * `request.steerTerminalRecovery.spec.js`). Falls through to terminal drain,
 * which both emits `pendingSteers` on FINAL and durably parks the same item
 * for a later `/chat/status` read. */
async function runInitialGenerationWithSteer({ conversationId, userId }) {
  const initializeClient = jest.fn().mockResolvedValue({
    client: {
      sender: 'AI',
      skipSaveUserMessage: true,
      sendMessage: async (_text, options) => {
        const userMessage = {
          messageId: 'user-msg-1',
          parentMessageId: '00000000-0000-0000-0000-000000000000',
          conversationId,
          text: 'hi',
        };
        options.onStart(userMessage, 'response-msg-1', false);

        const job = await GenerationJobManager.getJob(conversationId);
        await GenerationJobManager.steering.enqueue(
          conversationId,
          { steerId: 'steer-1', text: STEER_TEXT, userId, createdAt: Date.now() },
          job.createdAt,
        );

        return {
          messageId: 'response-msg-1',
          content: [],
          databasePromise: Promise.resolve({
            conversation: { conversationId, title: 'Existing Chat' },
          }),
        };
      },
    },
    userMCPAuthMap: undefined,
  });

  const req = {
    user: { id: userId },
    body: {
      text: 'hi',
      conversationId,
      generationProtocolVersion: 2,
      endpointOption: { endpoint: 'openAI', modelOptions: { model: 'gpt-4o-mini' } },
    },
    config: {},
  };
  const res = buildRes();

  const emitDoneSpy = jest.spyOn(GenerationJobManager, 'emitDone');
  await AgentController(req, res, undefined, initializeClient, undefined);
  await waitFor(() => emitDoneSpy.mock.calls.length > 0);
  emitDoneSpy.mockRestore();
}

/** Second run: the client auto-resent the parked steer as a brand-new turn
 * with the same text, tagged `recoverySteerId` -- exactly what
 * `useQueueDrain` sends after converting a FINAL event's `pendingSteers`
 * into a queued follow-up and auto-sending it. `skipSaveUserMessage` is
 * deliberately left falsy: a recovered turn must always persist its user
 * row, and the commit path must refuse to consume the lease otherwise. */
async function runRecoveryGeneration({ conversationId, userId, recoverySteerId, text }) {
  const initializeClient = jest.fn().mockResolvedValue({
    client: {
      sender: 'AI',
      sendMessage: async (_text, options) => {
        const userMessage = {
          messageId: 'user-msg-2',
          parentMessageId: 'user-msg-1',
          conversationId,
          text,
        };
        options.onStart(userMessage, 'response-msg-2', false);

        return {
          messageId: 'response-msg-2',
          content: [],
          databasePromise: Promise.resolve({
            conversation: { conversationId, title: 'Existing Chat' },
          }),
        };
      },
    },
    userMCPAuthMap: undefined,
  });

  const req = {
    user: { id: userId },
    body: {
      text,
      conversationId,
      recoverySteerId,
      overrideUserMessageId: recoverySteerId,
      generationProtocolVersion: 2,
      endpointOption: { endpoint: 'openAI', modelOptions: { model: 'gpt-4o-mini' } },
    },
    config: {},
  };
  const res = buildRes();

  const emitDoneSpy = jest.spyOn(GenerationJobManager, 'emitDone');
  await AgentController(req, res, undefined, initializeClient, undefined);
  await waitFor(() => emitDoneSpy.mock.calls.length > 0);
  emitDoneSpy.mockRestore();
}

describe('ResumableAgentController - recovered steer lease consumption (real GenerationJobManager)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConvo.mockResolvedValue({
      createdAt: new Date().toISOString(),
      title: 'Existing Chat',
    });
  });

  it('stops surfacing a steer as parked once it has been recovered and its user message persisted', async () => {
    const conversationId = `conv-${Date.now()}-${Math.random()}`;
    const userId = 'user-1';

    await runInitialGenerationWithSteer({ conversationId, userId });

    // Sanity: the steer is durably parked after the first terminal drain --
    // this is the same replayable read `/chat/status` performs on refresh.
    const beforeRecovery = await GenerationJobManager.steering.claimDetailed(
      conversationId,
      { userId },
      2,
    );
    expect(beforeRecovery.steers.map((s) => s.steerId)).toContain('steer-1');

    await runRecoveryGeneration({
      conversationId,
      userId,
      recoverySteerId: 'steer-1',
      text: STEER_TEXT,
    });

    expect(mockSaveMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ messageId: 'user-msg-2' }),
      expect.anything(),
    );

    // A page refresh re-reads the SAME parked-steer lease. Once the
    // recovered turn's user message is durably saved, that source must no
    // longer reappear as a pending/unrecovered steer -- otherwise the
    // user's already-sent-and-answered words resurrect as a ghost chip.
    const afterRecovery = await GenerationJobManager.steering.claimDetailed(
      conversationId,
      { userId },
      2,
    );
    expect(afterRecovery.steers.map((s) => s.steerId)).not.toContain('steer-1');
  });
});
