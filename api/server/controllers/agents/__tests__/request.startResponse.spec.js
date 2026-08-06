/**
 * Contract test for the ResumableAgentController's immediate "started" JSON
 * response.
 *
 * The client subscribes to the SSE stream using the streamId/conversationId
 * returned by this response, and (per the upstream Interrupt & Steer design)
 * uses `generationCreatedAt` to detect whether a later-fetched job is the
 * same generation it originally started. Before this fix the field was
 * silently dropped, so the client fell back to protocol v1 behavior and the
 * during-run steer UI never activated on the default path - with no test
 * anywhere asserting the shape of this response.
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

describe('ResumableAgentController - start response contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConvo.mockResolvedValue({
      createdAt: new Date().toISOString(),
      title: 'Existing Chat',
    });
  });

  it('includes generationCreatedAt matching the created job on the immediate "started" response', async () => {
    const conversationId = `conv-${Date.now()}-${Math.random()}`;
    const userId = 'user-1';

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
    const createJobSpy = jest.spyOn(GenerationJobManager, 'createJob');

    await AgentController(req, res, undefined, initializeClient, undefined);
    await waitFor(() => emitDoneSpy.mock.calls.length > 0);

    const job = await createJobSpy.mock.results[0].value;
    emitDoneSpy.mockRestore();
    createJobSpy.mockRestore();

    expect(res.json).toHaveBeenCalledTimes(1);
    const [startResponse] = res.json.mock.calls[0];

    expect(startResponse).toMatchObject({
      streamId: conversationId,
      conversationId,
      status: 'started',
    });
    expect(startResponse.generationCreatedAt).toBeDefined();
    // The job may already be completed by the time we inspect it via getJob,
    // but its createdAt is stable across its lifecycle - it must match what
    // was sent to the client at start time.
    expect(startResponse.generationCreatedAt).toBe(job.createdAt);
  });
});
