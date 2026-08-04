/**
 * Real-object test for the Task 5b `/chat/status` recovery wiring: once a
 * generation job's record is gone (the default `completeJob` path deletes it
 * immediately), any steer parked under its own bounded-TTL key must still be
 * handed back to the owning client as `unrecoveredSteers`.
 *
 * Uses the REAL `GenerationJobManager` (its default `InMemoryJobStore`) so
 * the park -> claimDetailed round trip is exercised for real, not asserted
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

let mockUserId = 'user-1';

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

describe('GET /chat/status/:conversationId - steer recovery (real GenerationJobManager)', () => {
  beforeEach(() => {
    mockUserId = 'user-1';
  });

  it('returns unrecoveredSteers for a jobless conversation once its leftover steer was parked', async () => {
    const conversationId = `conv-jobless-${Date.now()}`;
    await GenerationJobManager.steering.park(
      conversationId,
      [{ steerId: 'steer-parked-1', text: 'left over', createdAt: Date.now() }],
      { userId: mockUserId },
    );

    const res = await request(app).get(`/agents/chat/status/${conversationId}`);

    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
    expect(res.body.unrecoveredSteers).toEqual([
      expect.objectContaining({ steerId: 'steer-parked-1', text: 'left over' }),
    ]);
  });

  it('omits unrecoveredSteers for a jobless conversation with nothing parked', async () => {
    const conversationId = `conv-jobless-empty-${Date.now()}`;

    const res = await request(app).get(`/agents/chat/status/${conversationId}`);

    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
    expect(res.body.unrecoveredSteers).toBeUndefined();
  });

  it('recovers a parked steer for a terminal (non-running) job that has not yet been cleaned up', async () => {
    const conversationId = `conv-terminal-${Date.now()}`;
    const job = await GenerationJobManager.createJob(conversationId, mockUserId, conversationId);
    await GenerationJobManager.steering.park(
      conversationId,
      [{ steerId: 'steer-parked-2', text: 'still queued', createdAt: Date.now() }],
      { userId: mockUserId },
      job.createdAt,
    );
    // Force the job into a terminal, not-yet-cleaned-up state without
    // deleting the record, so the `!isActive` branch (not the jobless one)
    // is what serves this request.
    await GenerationJobManager.claimTerminalJob(conversationId, 'error', 'boom', job.createdAt);

    const res = await request(app).get(`/agents/chat/status/${conversationId}`);

    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
    expect(res.body.unrecoveredSteers).toEqual([
      expect.objectContaining({ steerId: 'steer-parked-2', text: 'still queued' }),
    ]);
  });

  it('does not attempt recovery while the job is actively running', async () => {
    const conversationId = `conv-running-${Date.now()}`;
    await GenerationJobManager.createJob(conversationId, mockUserId, conversationId);
    const claimDetailedSpy = jest.spyOn(GenerationJobManager.steering, 'claimDetailed');

    const res = await request(app).get(`/agents/chat/status/${conversationId}`);

    expect(res.status).toBe(200);
    expect(res.body.active).toBe(true);
    expect(claimDetailedSpy).not.toHaveBeenCalled();
    claimDetailedSpy.mockRestore();
  });
});
