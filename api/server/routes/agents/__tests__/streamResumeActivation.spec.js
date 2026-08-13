/**
 * `subscribeWithResume` deliberately attaches its live subscription PAUSED:
 *
 *   "Live delivery remains paused until the caller writes its sync frame and
 *    activates the subscription."  -- GenerationJobManager.subscribeWithResume
 *
 * The route is therefore obliged to call `subscription.activate()` after it
 * writes the sync frame. Without that call the reconnecting client receives
 * exactly one frame -- the resume snapshot -- and then nothing, forever: no
 * further deltas, no terminal FINAL, and no connection close. The browser
 * symptom is a half-written answer frozen mid-sentence under a stop button
 * that never goes away, while the generation completes and persists normally
 * server-side. Reloading a second time renders the full message from the DB,
 * so the damage is confined to that one live view.
 *
 * This exercises the REAL `GenerationJobManager` (default `InMemoryJobStore`)
 * behind the REAL `/chat/stream` route over a real socket, reading frames
 * incrementally rather than awaiting completion -- awaiting completion is
 * precisely what hangs when the bug is present.
 */

const http = require('http');
const express = require('express');

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  isEnabled: jest.fn().mockReturnValue(false),
}));

jest.mock('~/models', () => ({ saveMessage: jest.fn() }));

const mockUserId = 'user-resume-activation';

jest.mock('~/server/middleware', () => ({
  uaParser: (req, res, next) => next(),
  checkBan: (req, res, next) => next(),
  requireJwtAuth: (req, res, next) => {
    req.user = { id: 'user-resume-activation' };
    next();
  },
  moderateText: (req, res, next) => next(),
  messageIpLimiter: (req, res, next) => next(),
  configMiddleware: (req, res, next) => next(),
  messageUserLimiter: (req, res, next) => next(),
}));

jest.mock('~/server/routes/agents/chat', () => require('express').Router());
jest.mock('~/server/routes/agents/v1', () => ({ v1: require('express').Router() }));
jest.mock('~/server/routes/agents/openai', () => require('express').Router());
jest.mock('~/server/routes/agents/responses', () => require('express').Router());

const { GenerationJobManager } = require('@librechat/api');
const agentsRouter = require('../index');

const app = express();
app.use(express.json());
app.use('/agents', agentsRouter);

const parseFrames = (raw) =>
  raw
    .split('\n\n')
    .filter(Boolean)
    .map((chunk) => {
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      try {
        return line ? JSON.parse(line.slice('data: '.length)) : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);

/** Opens a resume subscription and exposes frames as they arrive. */
function openResumeStream(server, conversationId, createdAt) {
  const { port } = server.address();
  const state = { raw: '', req: null, ended: false };
  state.req = http.get(
    {
      port,
      path: `/agents/chat/stream/${conversationId}?resume=true&generationCreatedAt=${createdAt}`,
    },
    (res) => {
      res.setEncoding('utf8');
      res.on('data', (d) => {
        state.raw += d;
      });
      res.on('end', () => {
        state.ended = true;
      });
    },
  );
  state.frames = () => parseFrames(state.raw);
  return state;
}

async function waitFor(predicate, { timeout = 3000, interval = 25 } = {}) {
  const start = Date.now();
  for (;;) {
    if (predicate()) {
      return true;
    }
    if (Date.now() - start > timeout) {
      return false;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

describe('GET /chat/stream/:streamId?resume=true - live delivery after the sync frame', () => {
  let server;

  beforeAll(async () => {
    await new Promise((resolve) => {
      server = app.listen(0, resolve);
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('delivers events emitted after the sync frame to the resumed subscriber', async () => {
    const conversationId = `conv-resume-activate-${Date.now()}`;
    const job = await GenerationJobManager.createJob(conversationId, mockUserId, conversationId);

    /** Content the reconnecting client must catch up on via the snapshot. */
    await GenerationJobManager.emitChunk(
      conversationId,
      { text: 'BEFORE_REFRESH', streamId: conversationId },
      { expectedCreatedAt: job.createdAt },
    );

    const stream = openResumeStream(server, conversationId, job.createdAt);

    const sawSync = await waitFor(() => stream.frames().some((f) => f.sync === true));
    expect(sawSync).toBe(true);

    /** A delta produced while the resumed client is attached. This is what the
     *  paused-and-never-activated subscription silently swallows. */
    await GenerationJobManager.emitChunk(
      conversationId,
      { text: 'AFTER_REFRESH', streamId: conversationId },
      { expectedCreatedAt: job.createdAt },
    );

    const sawLiveDelta = await waitFor(() =>
      stream.frames().some((f) => f.text === 'AFTER_REFRESH'),
    );

    stream.req.destroy();
    expect(sawLiveDelta).toBe(true);
  }, 20000);

  it('delivers the terminal FINAL frame and closes the resumed connection', async () => {
    const conversationId = `conv-resume-final-${Date.now()}`;
    const job = await GenerationJobManager.createJob(conversationId, mockUserId, conversationId);

    await GenerationJobManager.emitChunk(
      conversationId,
      { text: 'BEFORE_REFRESH', streamId: conversationId },
      { expectedCreatedAt: job.createdAt },
    );

    const stream = openResumeStream(server, conversationId, job.createdAt);
    expect(await waitFor(() => stream.frames().some((f) => f.sync === true))).toBe(true);

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
      requestMessage: { messageId: 'msg-1', conversationId, text: 'hi' },
      responseMessage: { messageId: 'resp-1', parentMessageId: 'msg-1', conversationId },
    });
    await GenerationJobManager.finishTerminalJob(terminalClaim);

    /** Without activation the stop button never clears, because this frame --
     *  and the socket close that follows it -- never reach the client. */
    const sawFinal = await waitFor(() => stream.frames().some((f) => f.final === true));
    const closed = await waitFor(() => stream.ended, { timeout: 2000 });

    stream.req.destroy();
    expect(sawFinal).toBe(true);
    expect(closed).toBe(true);
  }, 20000);
});
