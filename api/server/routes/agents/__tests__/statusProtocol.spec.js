/**
 * `/chat/status` is the authority a v2 client consults before it may tear down
 * a terminal generation. The client is deliberately fail-closed: it only trusts
 * a status snapshot that echoes the exact numeric protocol it negotiated
 * (`supportsGenerationProtocolV2` in `client/src/data-provider/SSE/protocol.ts`).
 * A status response without that marker makes the client preserve the
 * attachment and re-subscribe forever, so the echo is load-bearing, not
 * decorative.
 *
 * Uses the REAL `GenerationJobManager` (its default `InMemoryJobStore`) so the
 * negotiation is exercised against real job metadata rather than a mock.
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

let mockUserId = 'user-protocol-1';

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

const { GenerationJobManager } = require('@librechat/api');
const agentsRouter = require('../index');

const app = express();
app.use(express.json());
app.use('/agents', agentsRouter);

const PROTOCOL_HEADER = 'x-librechat-generation-protocol';

/** Mirrors the client: query marker + request header on every status read. */
const getStatusAsV2Client = (conversationId) =>
  request(app)
    .get(`/agents/chat/status/${conversationId}?generationProtocolVersion=2`)
    .set(PROTOCOL_HEADER, '2');

describe('GET /chat/status/:conversationId - generation protocol echo', () => {
  beforeEach(() => {
    mockUserId = 'user-protocol-1';
  });

  it('echoes v2 for a cleaned-up generation so a v2 client can finish teardown', async () => {
    const conversationId = `conv-status-jobless-${Date.now()}`;

    const res = await getStatusAsV2Client(conversationId);

    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
    expect(res.body.generationProtocolVersion).toBe(2);
    expect(res.headers[PROTOCOL_HEADER]).toBe('2');
  });

  it('echoes v1 to a legacy client that advertises nothing', async () => {
    const conversationId = `conv-status-legacy-${Date.now()}`;

    const res = await request(app).get(`/agents/chat/status/${conversationId}`);

    expect(res.status).toBe(200);
    expect(res.body.generationProtocolVersion).toBe(1);
  });

  it('echoes the running job protocol to a v2 client', async () => {
    const conversationId = `conv-status-running-v2-${Date.now()}`;
    await GenerationJobManager.createJob(conversationId, mockUserId, conversationId, {
      initialMetadata: { generationProtocolVersion: 2 },
    });

    const res = await getStatusAsV2Client(conversationId);

    expect(res.status).toBe(200);
    expect(res.body.active).toBe(true);
    expect(res.body.generationProtocolVersion).toBe(2);
  });

  it('never upgrades a legacy job just because the client asks for v2', async () => {
    const conversationId = `conv-status-running-v1-${Date.now()}`;
    await GenerationJobManager.createJob(conversationId, mockUserId, conversationId, {
      initialMetadata: { generationProtocolVersion: 1 },
    });

    const res = await getStatusAsV2Client(conversationId);

    expect(res.status).toBe(200);
    expect(res.body.active).toBe(true);
    expect(res.body.generationProtocolVersion).toBe(1);
  });
});
