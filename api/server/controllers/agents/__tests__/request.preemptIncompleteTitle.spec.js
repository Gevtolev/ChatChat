/**
 * Regression test for wasted title generation on preempt-incomplete turns.
 *
 * A turn sealed at an EMPTY preempt boundary produces a truncated, contentless
 * answer. Generating a conversation title from it yields a garbage title and,
 * on this fork, costs a real `/api/convos/gen_title/:id` long-poll (a socket
 * held ~15.5s plus a model call) for a turn that said nothing.
 *
 * Upstream reads the boundary state off the SDK run object:
 *   (run.getPreemptStats()?.emptyBoundaries ?? 0) > 0 ||
 *   run.getHaltReason() === 'preempt_incomplete'
 *
 * Both signals must suppress the title. The control case below asserts the
 * suppression does NOT over-fire: an ordinary clean turn must still be titled,
 * otherwise this "fix" would silently disable naming for every new chat.
 *
 * Ref: upstream #14571. Only the `shouldGenerateTitle` half applies here --
 * upstream's `titleAbortController`/`convoReady` half belongs to Immediate
 * Title Generation (#13395), which this fork deliberately does not adopt, so
 * there is no in-flight title task to abort under `titleGenerationTiming:
 * 'final'`.
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

const NO_PARENT = '00000000-0000-0000-0000-000000000000';

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

/**
 * Drives one brand-new conversation to completion.
 * `run` is attached to the client exactly as `AgentClient` does
 * (`this.run = run`), so the controller reads the same shape production does.
 */
async function runNewConversation({ run }) {
  const addTitle = jest.fn().mockResolvedValue(undefined);

  const initializeClient = jest.fn().mockResolvedValue({
    client: {
      sender: 'AI',
      run,
      sendMessage: async (_text, options) => {
        options.onStart(
          {
            messageId: 'user-msg-1',
            parentMessageId: NO_PARENT,
            text: 'hello',
          },
          'response-msg-1',
          false,
        );

        return {
          messageId: 'response-msg-1',
          content: [],
          databasePromise: Promise.resolve({
            conversation: { title: 'New Chat' },
          }),
        };
      },
    },
    userMCPAuthMap: undefined,
  });

  const req = {
    user: { id: 'user-1' },
    body: {
      text: 'hello',
      conversationId: 'new',
      parentMessageId: NO_PARENT,
      endpointOption: { endpoint: 'openAI', modelOptions: { model: 'gpt-4o-mini' } },
    },
    config: {},
  };

  const emitDoneSpy = jest.spyOn(GenerationJobManager, 'emitDone');
  await AgentController(req, buildRes(), undefined, initializeClient, addTitle);
  await waitFor(() => emitDoneSpy.mock.calls.length > 0);
  emitDoneSpy.mockRestore();
  // `addTitle` is fire-and-forget after the terminal event; give the
  // microtask that would invoke it a chance to run before asserting absence.
  await new Promise((resolve) => setTimeout(resolve, 20));

  return { addTitle };
}

describe('ResumableAgentController - title generation on preempt-incomplete turns', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSaveMessage.mockResolvedValue({});
    mockGetConvo.mockResolvedValue(null);
  });

  it('skips title generation when the run reports an empty preempt boundary', async () => {
    const { addTitle } = await runNewConversation({
      run: {
        getPreemptStats: () => ({ emptyBoundaries: 1 }),
        getHaltReason: () => undefined,
      },
    });

    expect(addTitle).not.toHaveBeenCalled();
  });

  it('skips title generation when the run halted as preempt_incomplete', async () => {
    const { addTitle } = await runNewConversation({
      run: {
        getPreemptStats: () => ({ emptyBoundaries: 0 }),
        getHaltReason: () => 'preempt_incomplete',
      },
    });

    expect(addTitle).not.toHaveBeenCalled();
  });

  it('still generates a title for an ordinary clean turn', async () => {
    const { addTitle } = await runNewConversation({
      run: {
        getPreemptStats: () => ({ emptyBoundaries: 0 }),
        getHaltReason: () => undefined,
      },
    });

    expect(addTitle).toHaveBeenCalled();
  });

  it('still generates a title when the run exposes neither accessor', async () => {
    const { addTitle } = await runNewConversation({ run: {} });

    expect(addTitle).toHaveBeenCalled();
  });
});
