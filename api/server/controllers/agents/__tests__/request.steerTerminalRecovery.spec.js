/**
 * Real-object regression test for the Task 5b critical bug: a steer queued
 * mid-run that never crosses a PostToolBatch/PreemptBoundary drain point (the
 * common case for a plain chat answer with no tool calls) must still be
 * surfaced to the client when the run ends normally.
 *
 * This deliberately uses the REAL `GenerationJobManager` (backed by its
 * default real `InMemoryJobStore`) instead of mocking it — the earlier
 * reviews in this merge plan found Critical bugs that fully-mocked
 * controller tests could never have caught, because the mock itself stood
 * in for the exact wiring that was missing.
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

/** Drives the controller through a full "no tool calls" completion, enqueuing
 * one steer mid-run from inside the fake client's `sendMessage`, exactly the
 * way a real `/chat/steer` POST would from another request. */
async function runControllerWithMidRunSteer({ conversationId, userId }) {
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
          { steerId: 'steer-1', text: 'actually, focus on X', userId, createdAt: Date.now() },
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
      endpointOption: { endpoint: 'openAI', modelOptions: { model: 'gpt-4o-mini' } },
    },
    config: {},
  };
  const res = buildRes();

  const emitDoneSpy = jest.spyOn(GenerationJobManager, 'emitDone');

  await AgentController(req, res, undefined, initializeClient, undefined);
  await waitFor(() => emitDoneSpy.mock.calls.length > 0);

  const finalEvent = emitDoneSpy.mock.calls[0][1];
  emitDoneSpy.mockRestore();
  return finalEvent;
}

describe('ResumableAgentController - steer terminal recovery (real GenerationJobManager)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConvo.mockResolvedValue({
      createdAt: new Date().toISOString(),
      title: 'Existing Chat',
    });
  });

  it('surfaces a steer queued mid-run (no tool/preempt boundary crossed) as pendingSteers on the FINAL event', async () => {
    const conversationId = `conv-${Date.now()}-${Math.random()}`;
    const finalEvent = await runControllerWithMidRunSteer({ conversationId, userId: 'user-1' });

    expect(finalEvent.pendingSteers).toEqual([
      expect.objectContaining({ steerId: 'steer-1', text: 'actually, focus on X' }),
    ]);
  });
});
