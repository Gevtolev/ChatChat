/**
 * `/chat/stream/:streamId` is keyed by conversation id, which is a stable,
 * long-lived identifier — not a capability. Two fences upstream relies on to
 * keep that endpoint from serving the wrong generation are missing here:
 *
 *   1. `streamId` is conversation-scoped, so the job under it can be REPLACED
 *      by a newer turn. A subscriber that pinned an older generation must get
 *      an explicit handoff signal rather than silently being attached to
 *      whatever generation currently occupies that id — that newer generation
 *      never had its owner authorized against this request.
 *
 *   2. A malformed `generationCreatedAt` must be rejected outright instead of
 *      being coerced (`Number('abc') === NaN`) and silently ignored, which
 *      collapses fence 1 back to "attach to whatever is there".
 *
 * Upstream additionally treats a job with a missing/corrupt owner as
 * unauthorized, where the local check short-circuits on a falsy owner. That
 * is adopted as defense in depth but is deliberately NOT covered here:
 * `createJob` rejects an empty user id outright, so the state can only arise
 * from a corrupted store, and a test would have to fabricate it by reaching
 * past the manager's own invariant.
 *
 * Exercises the REAL `GenerationJobManager` behind the REAL route via
 * supertest, so the authorization path under test is the one that actually
 * serves production traffic.
 */

const express = require('express');
const request = require('supertest');

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  isEnabled: jest.fn().mockReturnValue(false),
}));

jest.mock('~/models', () => ({ saveMessage: jest.fn() }));

let mockUserId = 'owner-user';

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
jest.mock('~/server/routes/agents/v1', () => ({ v1: require('express').Router() }));
jest.mock('~/server/routes/agents/openai', () => require('express').Router());
jest.mock('~/server/routes/agents/responses', () => require('express').Router());

const { GenerationJobManager } = require('@librechat/api');
const agentsRouter = require('../index');

const app = express();
app.use(express.json());
app.use('/agents', agentsRouter);

/** Supertest would otherwise hold an accepted SSE stream open until timeout. */
const requestStream = (path) =>
  new Promise((resolve, reject) => {
    const req = request(app).get(path);
    const timer = setTimeout(() => {
      req.abort();
      resolve({ status: 200, body: {}, timedOut: true });
    }, 1500);
    req.end((err, res) => {
      clearTimeout(timer);
      if (err && !res) {
        return reject(err);
      }
      resolve({ status: res.status, body: res.body, timedOut: false });
    });
  });

describe('GET /chat/stream/:streamId - authorization fences', () => {
  beforeEach(() => {
    mockUserId = 'owner-user';
  });

  it('refuses a request from a user who does not own the job', async () => {
    const conversationId = `conv-foreign-${Date.now()}`;
    const job = await GenerationJobManager.createJob(conversationId, 'owner-user', conversationId);

    mockUserId = 'unrelated-user';
    const res = await requestStream(`/agents/chat/stream/${conversationId}`);

    await GenerationJobManager.completeJob(conversationId, 'complete', undefined, job.createdAt);
    expect(res.status).toBe(403);
  }, 20000);

  it('refuses to attach a stale generation identity instead of serving the replacement', async () => {
    const conversationId = `conv-replaced-${Date.now()}`;
    const first = await GenerationJobManager.createJob(
      conversationId,
      'owner-user',
      conversationId,
    );
    const staleCreatedAt = first.createdAt;

    await GenerationJobManager.completeJob(conversationId, 'complete', undefined, staleCreatedAt);
    /** Same conversation id, brand new turn — a different generation entirely. */
    const replacement = await GenerationJobManager.createJob(
      conversationId,
      'owner-user',
      conversationId,
    );
    expect(replacement.createdAt).not.toBe(staleCreatedAt);

    const res = await requestStream(
      `/agents/chat/stream/${conversationId}?generationCreatedAt=${staleCreatedAt}`,
    );

    await GenerationJobManager.completeJob(
      conversationId,
      'complete',
      undefined,
      replacement.createdAt,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('GENERATION_REPLACED');
  }, 20000);

  it('rejects a malformed generation identity rather than coercing it away', async () => {
    const conversationId = `conv-malformed-${Date.now()}`;
    const job = await GenerationJobManager.createJob(conversationId, 'owner-user', conversationId);

    const res = await requestStream(
      `/agents/chat/stream/${conversationId}?generationCreatedAt=not-a-number`,
    );

    await GenerationJobManager.completeJob(conversationId, 'complete', undefined, job.createdAt);
    expect(res.status).toBe(400);
  }, 20000);

  it('still serves the owner when the generation identity matches', async () => {
    const conversationId = `conv-happy-${Date.now()}`;
    const job = await GenerationJobManager.createJob(conversationId, 'owner-user', conversationId);

    const res = await requestStream(
      `/agents/chat/stream/${conversationId}?generationCreatedAt=${job.createdAt}`,
    );

    await GenerationJobManager.completeJob(conversationId, 'complete', undefined, job.createdAt);
    expect(res.status).toBe(200);
  }, 20000);
});
