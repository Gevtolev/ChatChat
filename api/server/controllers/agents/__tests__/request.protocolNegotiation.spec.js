/**
 * Task 16: generation protocol v2 negotiation.
 *
 * Before this fix, `ResumableAgentController` had ZERO reference to
 * `./protocol` (`negotiateNewGenerationProtocol` / `negotiateExistingGenerationProtocol`
 * / `GENERATION_PROTOCOL_HEADER` were never imported), so negotiation never ran and
 * every response silently behaved as protocol v1 - even though this machine has no
 * Redis configured and `getServerGenerationProtocol` would otherwise resolve v2.
 * The frontend's 21 v2-only branches (`useResumableSSE.ts` / `useSteering.ts`) were
 * therefore dead code.
 *
 * This spec pins the wiring: every JSON response exit must carry the negotiated
 * `generationProtocolVersion` in both the body and the `x-librechat-generation-protocol`
 * header, and the negotiation must actually take the request's advertised protocol
 * and the server's capability into account (not just hardcode a constant).
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
const { GENERATION_PROTOCOL_HEADER } = require('../protocol');
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

/**
 * Mirrors the real client: `postGenerationRequest` (client/src/data-provider/SSE/protocol.ts)
 * always advertises v2 support via BOTH the header and a `generationProtocolVersion: 2`
 * body field on every start-generation POST. Pass `advertiseV2: false` to simulate a
 * legacy/pre-negotiation client that sends neither marker, or override `headers`/`body`
 * directly to simulate a client that explicitly negotiates down to v1.
 */
function buildReq({ userId, conversationId, body = {}, headers = {}, advertiseV2 = true }) {
  return {
    user: { id: userId },
    headers: {
      ...(advertiseV2 && { [GENERATION_PROTOCOL_HEADER]: '2' }),
      ...headers,
    },
    body: {
      text: 'hi',
      conversationId,
      endpointOption: { endpoint: 'openAI', modelOptions: { model: 'gpt-4o-mini' } },
      ...(advertiseV2 && { generationProtocolVersion: 2 }),
      ...body,
    },
    config: {},
  };
}

describe('ResumableAgentController - generation protocol negotiation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConvo.mockResolvedValue({
      createdAt: new Date().toISOString(),
      title: 'Existing Chat',
    });
  });

  it('negotiates v2 for a real client request (header + body both advertise v2, no Redis configured)', async () => {
    const conversationId = `conv-${Date.now()}-${Math.random()}`;
    const userId = 'user-proto-v2';
    const initializeClient = buildInitializeClient(conversationId);
    const req = buildReq({ userId, conversationId });
    const res = buildRes();

    const emitDoneSpy = jest.spyOn(GenerationJobManager, 'emitDone');
    await AgentController(req, res, undefined, initializeClient, undefined);
    await waitFor(() => emitDoneSpy.mock.calls.length > 0);
    emitDoneSpy.mockRestore();

    expect(res.json).toHaveBeenCalledTimes(1);
    const [startResponse] = res.json.mock.calls[0];
    expect(startResponse.status).toBe('started');
    expect(startResponse.generationProtocolVersion).toBe(2);
    expect(res.set).toHaveBeenCalledWith(GENERATION_PROTOCOL_HEADER, '2');
  });

  it('stays on v1 for a legacy client that advertises no protocol markers at all', async () => {
    const conversationId = `conv-${Date.now()}-${Math.random()}`;
    const userId = 'user-proto-legacy';
    const initializeClient = buildInitializeClient(conversationId);
    const req = buildReq({ userId, conversationId, advertiseV2: false });
    const res = buildRes();

    const emitDoneSpy = jest.spyOn(GenerationJobManager, 'emitDone');
    await AgentController(req, res, undefined, initializeClient, undefined);
    await waitFor(() => emitDoneSpy.mock.calls.length > 0);
    emitDoneSpy.mockRestore();

    const [startResponse] = res.json.mock.calls[0];
    expect(startResponse.generationProtocolVersion).toBe(1);
    expect(res.set).toHaveBeenCalledWith(GENERATION_PROTOCOL_HEADER, '1');
  });

  it('fails closed to v1 when the header and body markers disagree', async () => {
    const conversationId = `conv-${Date.now()}-${Math.random()}`;
    const userId = 'user-proto-mismatch';
    const initializeClient = buildInitializeClient(conversationId);
    const req = buildReq({
      userId,
      conversationId,
      advertiseV2: false,
      headers: { [GENERATION_PROTOCOL_HEADER]: '2' },
      body: { generationProtocolVersion: 1 },
    });
    const res = buildRes();

    const emitDoneSpy = jest.spyOn(GenerationJobManager, 'emitDone');
    await AgentController(req, res, undefined, initializeClient, undefined);
    await waitFor(() => emitDoneSpy.mock.calls.length > 0);
    emitDoneSpy.mockRestore();

    const [startResponse] = res.json.mock.calls[0];
    expect(startResponse.generationProtocolVersion).toBe(1);
    expect(res.set).toHaveBeenCalledWith(GENERATION_PROTOCOL_HEADER, '1');
  });

  it('stamps the negotiated protocol on a 400 validation rejection issued before any job exists', async () => {
    const conversationId = `conv-${Date.now()}-${Math.random()}`;
    const userId = 'user-proto-400';
    const initializeClient = buildInitializeClient(conversationId);
    const req = buildReq({
      userId,
      conversationId,
      body: { clientRequestId: 'has a space and is way too invalid!' },
    });
    const res = buildRes();

    await AgentController(req, res, undefined, initializeClient, undefined);

    expect(res.status).toHaveBeenCalledWith(400);
    const [rejectionBody] = res.json.mock.calls[0];
    expect(rejectionBody.generationProtocolVersion).toBe(2);
    expect(res.set).toHaveBeenCalledWith(GENERATION_PROTOCOL_HEADER, '2');
  });

  it('stamps the job-pinned protocol on a deduped retry of an existing generation', async () => {
    const conversationId = `conv-${Date.now()}-${Math.random()}`;
    const userId = 'user-proto-dedupe';
    const clientRequestId = 'retry-key-protocol-1';

    const initializeClient1 = buildInitializeClient(conversationId);
    const req1 = buildReq({ userId, conversationId, body: { clientRequestId } });
    const res1 = buildRes();
    await AgentController(req1, res1, undefined, initializeClient1, undefined);
    const [firstResponse] = res1.json.mock.calls[0];
    expect(firstResponse.generationProtocolVersion).toBe(2);

    const initializeClient2 = buildInitializeClient(conversationId);
    const req2 = buildReq({ userId, conversationId, body: { clientRequestId } });
    const res2 = buildRes();
    await AgentController(req2, res2, undefined, initializeClient2, undefined);

    expect(initializeClient2).not.toHaveBeenCalled();
    const [secondResponse] = res2.json.mock.calls[0];
    expect(secondResponse.generationProtocolVersion).toBe(2);
    expect(res2.set).toHaveBeenCalledWith(GENERATION_PROTOCOL_HEADER, '2');
  });
});
