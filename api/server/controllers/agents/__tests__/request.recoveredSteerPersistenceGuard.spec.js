/**
 * Regression test for a data-loss bug in the recovered-steer commit path:
 * `commitRecoveredSteer()` (and, through it,
 * `GenerationJobManager.steering.consumeRecovered`) must only run AFTER the
 * recovered turn's user message has been durably persisted. The parked steer
 * lease is the ONLY durable copy of the user's recovered words -- consuming
 * it without a confirmed write permanently loses them.
 *
 * Two ways the guard can fail silently:
 *   1. `userMessage` was never captured (e.g. `onStart` never fired) --
 *      the pre-fix code's `if (!client.skipSaveUserMessage && userMessage)`
 *      simply skips the save instead of treating a missing message as fatal.
 *   2. `saveMessage` resolves falsy (write didn't actually happen) -- the
 *      pre-fix code discards the return value entirely.
 *
 * In both cases the pre-fix controller falls straight through to
 * `commitRecoveredSteer()`, which consumes the parked lease regardless.
 *
 * Uses the REAL `GenerationJobManager` (default real `InMemoryJobStore`),
 * mirroring `request.recoveredSteerLease.spec.js`, so the parked lease this
 * test guards against losing is a genuine one (not a mock stand-in).
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

/** First run: parks a steer the same way a real `/chat/steer` POST would,
 * so the recovery run below has a genuine lease to (mis)consume. */
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

/** Second run: a recovery turn tagged `recoverySteerId`, with a controllable
 * `callOnStart` (simulates `userMessage` never being captured) so callers can
 * drive both failure modes described above. Resolves once the run reaches
 * ONE of the terminal events -- the normal FINAL (`emitDone`) or the error
 * path (`emitError`), whichever the code under test takes. */
async function runRecoveryGeneration({
  conversationId,
  userId,
  recoverySteerId,
  text,
  callOnStart,
  userMessageId,
}) {
  const initializeClient = jest.fn().mockResolvedValue({
    client: {
      sender: 'AI',
      sendMessage: async (_text, options) => {
        if (callOnStart) {
          const userMessage = {
            messageId: userMessageId,
            parentMessageId: 'user-msg-1',
            conversationId,
            text,
          };
          options.onStart(userMessage, 'response-msg-2', false);
        }

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
  const emitErrorSpy = jest.spyOn(GenerationJobManager, 'emitError');
  await AgentController(req, res, undefined, initializeClient, undefined);
  await waitFor(() => emitDoneSpy.mock.calls.length > 0 || emitErrorSpy.mock.calls.length > 0);
  const emitErrorCalls = [...emitErrorSpy.mock.calls];
  emitDoneSpy.mockRestore();
  emitErrorSpy.mockRestore();
  return { emitErrorCalls };
}

describe('ResumableAgentController - recovered steer commit requires durable persistence (real GenerationJobManager)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSaveMessage.mockResolvedValue({});
    mockGetConvo.mockResolvedValue({
      createdAt: new Date().toISOString(),
      title: 'Existing Chat',
    });
  });

  it('must not consume the recovered steer lease when the user message was never captured', async () => {
    const conversationId = `conv-${Date.now()}-${Math.random()}`;
    const userId = 'user-1';

    await runInitialGenerationWithSteer({ conversationId, userId });

    const consumeRecoveredSpy = jest.spyOn(GenerationJobManager.steering, 'consumeRecovered');

    const { emitErrorCalls } = await runRecoveryGeneration({
      conversationId,
      userId,
      recoverySteerId: 'steer-1',
      text: STEER_TEXT,
      callOnStart: false,
      userMessageId: 'user-msg-2',
    });

    expect(mockSaveMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ messageId: 'user-msg-2' }),
      expect.anything(),
    );
    // The commit path must refuse to run at all once the missing user
    // message is treated as fatal -- the lease stays parked instead of
    // being silently consumed.
    expect(consumeRecoveredSpy).not.toHaveBeenCalled();
    expect(emitErrorCalls).toContainEqual([
      expect.anything(),
      'User message was unavailable before terminal persistence',
    ]);
    consumeRecoveredSpy.mockRestore();
  });

  it('must not consume the recovered steer lease when saveMessage resolves falsy', async () => {
    const conversationId = `conv-${Date.now()}-${Math.random()}`;
    const userId = 'user-1';

    await runInitialGenerationWithSteer({ conversationId, userId });

    mockSaveMessage.mockResolvedValueOnce(null);
    const consumeRecoveredSpy = jest.spyOn(GenerationJobManager.steering, 'consumeRecovered');

    const { emitErrorCalls } = await runRecoveryGeneration({
      conversationId,
      userId,
      recoverySteerId: 'steer-1',
      text: STEER_TEXT,
      callOnStart: true,
      userMessageId: 'user-msg-3',
    });

    expect(mockSaveMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ messageId: 'user-msg-3' }),
      expect.anything(),
    );
    // The write resolved falsy (not durable) -- the commit path must refuse
    // to consume the lease instead of treating an untrusted return value as
    // success.
    expect(consumeRecoveredSpy).not.toHaveBeenCalled();
    expect(emitErrorCalls).toContainEqual([
      expect.anything(),
      'User message could not be persisted before terminal publication',
    ]);
    consumeRecoveredSpy.mockRestore();
  });
});
