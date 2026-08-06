/**
 * Task 13: `clientRequestId` / `recoverySteerId` / `expectedPredecessorCreatedAt`
 * end-to-end wiring.
 *
 * Before this fix, `ResumableAgentController` never read any of these three
 * `req.body` fields (a `grep` across the controller was a zero-hit). The
 * downstream idempotency-claim infrastructure
 * (`GenerationJobManager.claimGeneration` / `createJob`'s
 * `idempotencyClientRequestId`/`idempotencyClaimToken` options) already
 * existed from the Task 2 SDK upgrade, but nothing on the start-generation
 * path ever called it - so a lost-response network retry that resent the
 * identical `clientRequestId` silently started a SECOND, fully-billed
 * generation instead of being deduped onto the first.
 *
 * This is a real-object test (real `GenerationJobManager`, real default
 * `InMemoryJobStore`) rather than a mocked one, matching
 * `request.steerTerminalRecovery.spec.js`'s rationale: a fully-mocked
 * controller test cannot prove the wiring is actually load-bearing.
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

function buildRes() {
  const res = {
    headersSent: false,
    json: jest.fn(() => res),
    status: jest.fn(() => res),
  };
  return res;
}

function buildInitializeClient(conversationId) {
  return jest.fn().mockResolvedValue({
    client: {
      sender: 'AI',
      skipSaveUserMessage: true,
      sendMessage: async (_text, options) => {
        const userMessage = {
          messageId: `user-${Math.random()}`,
          parentMessageId: '00000000-0000-0000-0000-000000000000',
          conversationId,
          text: 'hi',
        };
        options.onStart(userMessage, `resp-${Math.random()}`, false);
        return {
          messageId: `resp-${Math.random()}`,
          content: [],
          databasePromise: Promise.resolve({
            conversation: { conversationId, title: 'Existing Chat' },
          }),
        };
      },
    },
    userMCPAuthMap: undefined,
  });
}

function buildReq({ userId, conversationId, body = {} }) {
  return {
    user: { id: userId },
    body: {
      text: 'hi',
      conversationId,
      endpointOption: { endpoint: 'openAI', modelOptions: { model: 'gpt-4o-mini' } },
      ...body,
    },
    config: {},
  };
}

describe('ResumableAgentController - clientRequestId idempotency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConvo.mockResolvedValue({
      createdAt: new Date().toISOString(),
      title: 'Existing Chat',
    });
  });

  it('dedupes a retried start-generation request carrying the same clientRequestId', async () => {
    const conversationId = `conv-${Date.now()}-${Math.random()}`;
    const userId = 'user-dedupe';
    const clientRequestId = 'retry-key-1';
    const createJobSpy = jest.spyOn(GenerationJobManager, 'createJob');

    const initializeClient1 = buildInitializeClient(conversationId);
    const req1 = buildReq({ userId, conversationId, body: { clientRequestId } });
    const res1 = buildRes();
    await AgentController(req1, res1, undefined, initializeClient1, undefined);

    expect(res1.json).toHaveBeenCalledTimes(1);
    const [firstResponse] = res1.json.mock.calls[0];
    expect(firstResponse.status).toBe('started');
    expect(createJobSpy).toHaveBeenCalledTimes(1);
    expect(initializeClient1).toHaveBeenCalledTimes(1);

    // A second POST with the identical clientRequestId simulates the
    // client's XHR-retry-on-lost-response path (see useResumableSSE.ts).
    const initializeClient2 = buildInitializeClient(conversationId);
    const req2 = buildReq({ userId, conversationId, body: { clientRequestId } });
    const res2 = buildRes();
    await AgentController(req2, res2, undefined, initializeClient2, undefined);

    expect(res2.json).toHaveBeenCalledTimes(1);
    const [secondResponse] = res2.json.mock.calls[0];

    // The dedup must attach to the SAME stream/epoch instead of starting a
    // second, independently-billed generation.
    expect(secondResponse.streamId).toBe(firstResponse.streamId);
    expect(secondResponse.conversationId).toBe(firstResponse.conversationId);
    expect(secondResponse.generationCreatedAt).toBe(firstResponse.generationCreatedAt);
    expect(createJobSpy).toHaveBeenCalledTimes(1);
    expect(initializeClient2).not.toHaveBeenCalled();

    createJobSpy.mockRestore();
  });

  it('starts independent generations for different clientRequestIds', async () => {
    const conversationId = `conv-${Date.now()}-${Math.random()}`;
    const userId = 'user-independent';
    const createJobSpy = jest.spyOn(GenerationJobManager, 'createJob');

    const initializeClient1 = buildInitializeClient(conversationId);
    const req1 = buildReq({ userId, conversationId, body: { clientRequestId: 'req-a' } });
    const res1 = buildRes();
    await AgentController(req1, res1, undefined, initializeClient1, undefined);

    const initializeClient2 = buildInitializeClient(conversationId);
    const req2 = buildReq({ userId, conversationId, body: { clientRequestId: 'req-b' } });
    const res2 = buildRes();
    await AgentController(req2, res2, undefined, initializeClient2, undefined);

    expect(createJobSpy).toHaveBeenCalledTimes(2);
    expect(initializeClient1).toHaveBeenCalledTimes(1);
    expect(initializeClient2).toHaveBeenCalledTimes(1);

    createJobSpy.mockRestore();
  });

  it('rejects a malformed clientRequestId with a 400 before incrementing pending requests', async () => {
    const conversationId = `conv-${Date.now()}-${Math.random()}`;
    const userId = 'user-invalid';
    const initializeClient = buildInitializeClient(conversationId);
    const req = buildReq({
      userId,
      conversationId,
      body: { clientRequestId: 'has a space and is way too invalid!' },
    });
    const res = buildRes();

    await AgentController(req, res, undefined, initializeClient, undefined);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(initializeClient).not.toHaveBeenCalled();
  });

  it('rejects a malformed expectedPredecessorCreatedAt with a 400', async () => {
    const conversationId = `conv-${Date.now()}-${Math.random()}`;
    const userId = 'user-invalid-predecessor';
    const initializeClient = buildInitializeClient(conversationId);
    const req = buildReq({
      userId,
      conversationId,
      body: { expectedPredecessorCreatedAt: -1 },
    });
    const res = buildRes();

    await AgentController(req, res, undefined, initializeClient, undefined);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(initializeClient).not.toHaveBeenCalled();
  });

  it('rewrites overrideUserMessageId to a save-index-0 id when it echoes recoverySteerId', async () => {
    const conversationId = `conv-${Date.now()}-${Math.random()}`;
    const userId = 'user-recovery';
    const initializeClient = buildInitializeClient(conversationId);
    const req = buildReq({
      userId,
      conversationId,
      body: {
        recoverySteerId: 'source-steer-1',
        overrideUserMessageId: 'source-steer-1',
      },
    });
    const res = buildRes();

    await AgentController(req, res, undefined, initializeClient, undefined);

    expect(req.body.overrideUserMessageId).toBe('source-steer-1__0');
  });
});
