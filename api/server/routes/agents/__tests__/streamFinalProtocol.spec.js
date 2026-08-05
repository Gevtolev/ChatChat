/**
 * `/chat/stream`'s FINAL frame is the terminal SSE envelope a v2 client
 * evaluates before it will trust `pendingSteers`. The client is fail-closed
 * (`useResumableSSE.ts`): a FINAL frame that does not carry
 * `generationProtocolVersion: 2` is treated as unusable and its
 * `pendingSteers` are discarded wholesale, even when the server already
 * drained a real steer onto that same frame. The route must stamp every
 * terminal frame (and the response header) with the job's negotiated
 * protocol, mirroring upstream's `{ ...event, generationProtocolVersion }` in
 * `onDone`.
 *
 * Uses the REAL `GenerationJobManager` (its default `InMemoryJobStore`) plus
 * the real `/chat/stream` route via supertest, so the natural-completion
 * drain -> FINAL frame path is exercised end to end rather than asserted
 * against a mock that could silently drift from the real contract.
 */

const express = require('express');
const request = require('supertest');

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
  isEnabled: jest.fn().mockReturnValue(false),
}));

jest.mock('~/models', () => ({
  saveMessage: jest.fn(),
}));

let mockUserId = 'user-stream-protocol';

jest.mock('~/server/middleware', () => ({
  uaParser: (req, res, next) => next(),
  checkBan: (req, res, next) => next(),
  requireJwtAuth: (req, res, next) => {
    req.user = { id: mockUserId };
    next();
  },
  moderateText: (req, res, next) => next(),
  messageIpLimiter: (req, res, next) => next(),
  configMiddleware: (req, res, next) => next(),
  messageUserLimiter: (req, res, next) => next(),
}));

jest.mock('~/server/routes/agents/chat', () => require('express').Router());
jest.mock('~/server/routes/agents/v1', () => ({
  v1: require('express').Router(),
}));
jest.mock('~/server/routes/agents/openai', () => require('express').Router());
jest.mock('~/server/routes/agents/responses', () => require('express').Router());

const { GenerationJobManager, toPendingSteer } = require('@librechat/api');
const agentsRouter = require('../index');

const app = express();
app.use(express.json());
app.use('/agents', agentsRouter);

const PROTOCOL_HEADER = 'x-librechat-generation-protocol';
const STEER_TEXT = 'Switch to listing the largest moons instead.';

const parseFrames = (raw) =>
  raw
    .split('\n\n')
    .filter(Boolean)
    .map((chunk) => {
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      return line ? JSON.parse(line.slice('data: '.length)) : null;
    })
    .filter(Boolean);

describe('GET /chat/stream/:streamId - generation protocol stamp on the FINAL frame', () => {
  beforeEach(() => {
    mockUserId = 'user-stream-protocol';
  });

  it('stamps generationProtocolVersion on the FINAL frame and response header for a v2 job with a drained steer', async () => {
    const conversationId = `conv-stream-protocol-v2-${Date.now()}`;
    const job = await GenerationJobManager.createJob(conversationId, mockUserId, conversationId, {
      initialMetadata: { generationProtocolVersion: 2 },
    });

    expect(
      await GenerationJobManager.steering.enqueue(
        conversationId,
        {
          steerId: 'steer-live-1',
          clientSteerId: 'client-steer-1',
          text: STEER_TEXT,
          userId: mockUserId,
          createdAt: Date.now(),
        },
        job.createdAt,
      ),
    ).toBe(1);

    /** Exactly how a v2 client subscribes. */
    const streamPromise = new Promise((resolve, reject) => {
      request(app)
        .get(`/agents/chat/stream/${conversationId}?generationProtocolVersion=2`)
        .set(PROTOCOL_HEADER, '2')
        .end((err, res) => (err ? reject(err) : resolve(res)));
    });

    // Give the route time to subscribe before the job completes naturally.
    await new Promise((resolve) => setTimeout(resolve, 150));

    /** Natural completion, mirroring api/server/controllers/agents/request.js. */
    const terminalClaim = await GenerationJobManager.claimTerminalJob(
      conversationId,
      'complete',
      undefined,
      job.createdAt,
    );
    expect(terminalClaim).not.toBeNull();

    const pendingSteers = terminalClaim.drainedSteers.map(toPendingSteer);
    expect(pendingSteers).toHaveLength(1);

    await GenerationJobManager.emitDone(conversationId, {
      final: true,
      conversation: { conversationId },
      title: 'Planets',
      requestMessage: { messageId: 'msg-1', conversationId, text: 'List the planets' },
      responseMessage: {
        messageId: 'resp-1',
        parentMessageId: 'msg-1',
        conversationId,
        text: 'Jupiter is by far the largest planet...',
      },
      pendingSteers,
    });
    await GenerationJobManager.finishTerminalJob(terminalClaim);

    const res = await streamPromise;
    const finalFrame = parseFrames(res.text).find((frame) => frame.final === true);

    expect(res.headers[PROTOCOL_HEADER]).toBe('2');
    expect(finalFrame).toBeDefined();
    /** THE FIX: the FINAL frame must carry the marker, or a fail-closed v2
     *  client discards `pendingSteers` and the drained steer text is lost. */
    expect(finalFrame.generationProtocolVersion).toBe(2);
    expect(finalFrame.pendingSteers).toHaveLength(1);
    expect(finalFrame.pendingSteers[0].text).toBe(STEER_TEXT);
  }, 20000);

  it('stamps generationProtocolVersion 1 on the FINAL frame and header for a legacy job (no v2 markers requested)', async () => {
    const conversationId = `conv-stream-protocol-v1-${Date.now()}`;
    const job = await GenerationJobManager.createJob(conversationId, mockUserId, conversationId);

    const streamPromise = new Promise((resolve, reject) => {
      request(app)
        .get(`/agents/chat/stream/${conversationId}`)
        .end((err, res) => (err ? reject(err) : resolve(res)));
    });

    await new Promise((resolve) => setTimeout(resolve, 150));

    const terminalClaim = await GenerationJobManager.claimTerminalJob(
      conversationId,
      'complete',
      undefined,
      job.createdAt,
    );
    expect(terminalClaim).not.toBeNull();

    await GenerationJobManager.emitDone(conversationId, {
      final: true,
      conversation: { conversationId },
      title: 'Planets',
      requestMessage: { messageId: 'msg-2', conversationId, text: 'List the planets' },
      responseMessage: {
        messageId: 'resp-2',
        parentMessageId: 'msg-2',
        conversationId,
        text: 'Jupiter is by far the largest planet...',
      },
    });
    await GenerationJobManager.finishTerminalJob(terminalClaim);

    const res = await streamPromise;
    const finalFrame = parseFrames(res.text).find((frame) => frame.final === true);

    expect(res.headers[PROTOCOL_HEADER]).toBe('1');
    expect(finalFrame).toBeDefined();
    expect(finalFrame.generationProtocolVersion).toBe(1);
  }, 20000);
});
