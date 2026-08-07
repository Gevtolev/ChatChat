/**
 * Regression test for a data-loss bug in the disconnect partial-response
 * save path: `job.emitter.on('allSubscribersLeft', ...)` discards the return
 * value of `saveMessage`/`tenantStorage.run` entirely. If the write resolves
 * falsy (didn't actually persist), the pre-fix code still logs
 * "Saved partial response" and moves on as if nothing was lost -- the
 * partial response is gone with no trace and no retry.
 *
 * Mirrors the harness in `request.partialDisconnect.spec.js` (mocked
 * `GenerationJobManager`, tenant-context focus); this file isolates the
 * separate persistence-guard defect instead.
 */

const mockLogger = {
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
};

const mockTenantStorageRun = jest.fn(async (_context, callback) => callback());
const mockSaveMessage = jest.fn();
const mockGetConvo = jest.fn();
const mockGetMessages = jest.fn();
const mockFilterPersistableAbortContent = jest.fn((content) => content);
const mockCheckAndIncrementPendingRequest = jest.fn();
const mockDecrementPendingRequest = jest.fn();
const mockGenerationJobManager = {
  createJob: jest.fn(),
  emitError: jest.fn(),
  completeJob: jest.fn(),
  getResumeState: jest.fn(),
  updateMetadata: jest.fn(),
  claimGeneration: jest.fn(),
  releaseGeneration: jest.fn(),
  hasJob: jest.fn(),
  steering: {
    closeAndDrain: jest.fn(),
    park: jest.fn(),
  },
};

jest.mock('@librechat/data-schemas', () => ({
  logger: mockLogger,
  tenantStorage: {
    run: (...args) => mockTenantStorageRun(...args),
  },
}));

jest.mock('@librechat/api', () => ({
  sendEvent: jest.fn(),
  toPendingSteer: jest.fn((item) => item),
  isSteerPreemptSupported: jest.fn(() => true),
  buildRecoveredSteerPayload: jest.fn(() => null),
  deleteAgentCheckpoint: jest.fn(),
  getViolationInfo: jest.fn(() => ({
    type: 'concurrent',
    limit: 2,
    pendingRequests: 3,
    score: 1,
  })),
  buildMessageFiles: jest.fn(() => []),
  resolveTitleTiming: jest.fn(() => 'immediate'),
  resolveConversationAnchor: jest.requireActual('@librechat/api').resolveConversationAnchor,
  GenerationJobManager: mockGenerationJobManager,
  getReferencedQuotes: jest.fn(() => null),
  cleanupMCPRequestContext: jest.fn(),
  createMCPRequestContext: jest.fn(() => ({
    connections: new Map(),
    pending: new Map(),
    cleanupStarted: false,
  })),
  getMCPRequestContext: jest.fn(() => ({
    connections: new Map(),
    pending: new Map(),
    cleanupStarted: false,
  })),
  filterPersistableAbortContent: (...args) => mockFilterPersistableAbortContent(...args),
  cleanupMCPRequestContextForReq: jest.fn(),
  decrementPendingRequest: (...args) => mockDecrementPendingRequest(...args),
  sanitizeMessageForTransmit: jest.fn((message) => message),
  checkAndIncrementPendingRequest: (...args) => mockCheckAndIncrementPendingRequest(...args),
  getAgentStartupTelemetry: jest.fn(() => undefined),
  acceptAgentStartupTelemetry: jest.fn(),
  isUnpersistedPreliminaryParent: jest.fn(async () => false),
}));

jest.mock('~/server/cleanup', () => ({
  disposeClient: jest.fn(),
  clientRegistry: null,
  requestDataMap: {
    set: jest.fn(),
  },
}));

jest.mock('~/server/middleware', () => ({
  handleAbortError: jest.fn(() => Promise.resolve()),
}));

jest.mock('~/cache', () => ({
  logViolation: jest.fn(),
}));

jest.mock('~/models', () => ({
  saveMessage: (...args) => mockSaveMessage(...args),
  getMessages: (...args) => mockGetMessages(...args),
  getConvo: (...args) => mockGetConvo(...args),
}));

const AgentController = require('../request');

describe('ResumableAgentController - partial response persistence guard on disconnect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckAndIncrementPendingRequest.mockResolvedValue({ allowed: true });
    mockDecrementPendingRequest.mockResolvedValue(undefined);
    mockGetConvo.mockResolvedValue({ createdAt: '2026-07-31T00:00:00.000Z' });
    mockGetMessages.mockResolvedValue([]);
    mockGenerationJobManager.updateMetadata.mockResolvedValue(undefined);
    mockGenerationJobManager.emitError.mockResolvedValue(undefined);
    mockGenerationJobManager.completeJob.mockResolvedValue(undefined);
    mockGenerationJobManager.claimGeneration.mockResolvedValue({ claimed: true });
    mockGenerationJobManager.releaseGeneration.mockResolvedValue(undefined);
    mockGenerationJobManager.hasJob.mockResolvedValue(true);
    mockGenerationJobManager.steering.closeAndDrain.mockResolvedValue([]);
    mockGenerationJobManager.steering.park.mockResolvedValue(undefined);
  });

  /**
   * Drives the controller far enough to register the `allSubscribersLeft`
   * handler and fires it with aggregated content.
   */
  const firePartialDisconnect = async (user) => {
    let allSubscribersLeftHandler;
    mockGenerationJobManager.createJob.mockResolvedValue({
      createdAt: 1000,
      readyPromise: Promise.resolve(),
      abortController: new AbortController(),
      emitter: {
        on: jest.fn((event, handler) => {
          if (event === 'allSubscribersLeft') {
            allSubscribersLeftHandler = handler;
          }
        }),
      },
    });
    mockGenerationJobManager.getResumeState.mockResolvedValue({
      conversationId: 'conversation-123',
      responseMessageId: 'response-message',
      userMessage: {
        messageId: 'user-message',
      },
    });

    const initializeClient = jest.fn().mockRejectedValue(new Error('stop after setup'));
    const req = {
      user,
      body: {
        text: 'Continue the analysis',
        messageId: 'user-message',
        parentMessageId: 'parent-message',
        conversationId: 'conversation-123',
        endpointOption: {
          endpoint: 'agents',
          modelOptions: { model: 'gpt-4.1' },
        },
      },
      config: {},
    };
    const res = {
      headersSent: true,
      json: jest.fn(),
      status: jest.fn(() => res),
      set: jest.fn(() => res),
    };

    await AgentController(req, res, jest.fn(), initializeClient, null);
    expect(allSubscribersLeftHandler).toEqual(expect.any(Function));

    await allSubscribersLeftHandler([{ type: 'text', text: 'Partial response' }]);
  };

  it('must not report a saved partial response when saveMessage resolves falsy (no tenant)', async () => {
    mockSaveMessage.mockResolvedValue(null);

    await firePartialDisconnect({ id: 'user-123' });

    // The write resolved falsy (not durable) -- the guard must surface this
    // as an error instead of logging a false "Saved partial response".
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[ResumableAgentController] Error saving partial response:',
      expect.objectContaining({
        message: 'Partial response could not be persisted after disconnect',
      }),
    );
    expect(mockLogger.debug).not.toHaveBeenCalledWith(
      expect.stringContaining('Saved partial response'),
    );
  });

  it('must not report a saved partial response when saveMessage resolves falsy (tenant-scoped)', async () => {
    mockSaveMessage.mockResolvedValue(null);

    await firePartialDisconnect({ id: 'user-123', tenantId: 'tenant-a' });

    expect(mockTenantStorageRun).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', userId: 'user-123' },
      expect.any(Function),
    );
    // Same defect through the tenant-scoped branch.
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[ResumableAgentController] Error saving partial response:',
      expect.objectContaining({
        message: 'Partial response could not be persisted after disconnect',
      }),
    );
    expect(mockLogger.debug).not.toHaveBeenCalledWith(
      expect.stringContaining('Saved partial response'),
    );
  });
});
