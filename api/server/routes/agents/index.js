const express = require('express');
const { isEnabled, GenerationJobManager } = require('@librechat/api');
const { createSseStreamTelemetry } = require('@librechat/api/telemetry');
const { logger } = require('@librechat/data-schemas');
const {
  uaParser,
  checkBan,
  moderateText,
  requireJwtAuth,
  messageIpLimiter,
  configMiddleware,
  messageUserLimiter,
} = require('~/server/middleware');
const SteerController = require('~/server/controllers/agents/steer');
const {
  GENERATION_PROTOCOL_HEADER,
  getRequestedGenerationProtocol,
  getServerGenerationProtocol,
  negotiateNewGenerationProtocol,
  negotiateExistingGenerationProtocol,
} = require('~/server/controllers/agents/protocol');
const { saveMessage } = require('~/models');
const responses = require('./responses');
const openai = require('./openai');
const { v1 } = require('./v1');
const chat = require('./chat');

const { LIMIT_MESSAGE_IP, LIMIT_MESSAGE_USER } = process.env ?? {};

/** Untenanted jobs (pre-multi-tenancy) remain accessible if the userId check passes. */
function hasTenantMismatch(job, user) {
  return job.metadata?.tenantId != null && job.metadata.tenantId !== user.tenantId;
}

/** Stamps a JSON envelope with the protocol the caller is entitled to see. */
function sendGenerationJson(res, status, body, generationProtocolVersion) {
  res.set(GENERATION_PROTOCOL_HEADER, String(generationProtocolVersion));
  return res.status(status).json({ ...body, generationProtocolVersion });
}

/** Protocol for envelopes sent BEFORE a job is authorized (validation,
 * not-found, unauthorized). Derived from the request and this server's own
 * capability only, so it never leaks an existing job's marker to a caller who
 * has not been shown to own it. */
function negotiateRequestGenerationProtocol(req) {
  return negotiateNewGenerationProtocol(req, GenerationJobManager);
}

/**
 * Status envelope for a conversation whose job record is already gone. The
 * default completeJob path deletes it immediately, so this IS the common
 * after-terminal case — parked steers live under their own bounded-TTL key and
 * authorize from their stored owner.
 *
 * The numeric protocol echo is load-bearing: a v2 client is fail-closed and
 * treats an unmarked snapshot as unusable, re-subscribing to the finished
 * generation until the marker proves the server speaks its protocol.
 */
async function sendJoblessStatus(req, res, conversationId) {
  const requestedProtocolVersion = getRequestedGenerationProtocol(req);
  const claimed = await GenerationJobManager.steering.claimDetailed(
    conversationId,
    {
      userId: req.user.id,
      tenantId: req.user.tenantId,
    },
    requestedProtocolVersion,
  );
  const generationProtocolVersion = Math.min(
    requestedProtocolVersion,
    claimed.steers.length > 0
      ? claimed.generationProtocolVersion
      : getServerGenerationProtocol(GenerationJobManager),
  );
  res.set(GENERATION_PROTOCOL_HEADER, String(generationProtocolVersion));
  return res.json({
    active: false,
    generationProtocolVersion,
    ...(claimed.steers.length > 0 && { unrecoveredSteers: claimed.steers }),
  });
}

const router = express.Router();

/**
 * Open Responses API routes (API key authentication handled in route file)
 * Mounted at /agents/v1/responses (full path: /api/agents/v1/responses)
 * NOTE: Must be mounted BEFORE /v1 to avoid being caught by the less specific route
 * @see https://openresponses.org/specification
 */
router.use('/v1/responses', responses);

/**
 * OpenAI-compatible API routes (API key authentication handled in route file)
 * Mounted at /agents/v1 (full path: /api/agents/v1/chat/completions)
 */
router.use('/v1', openai);

router.use(requireJwtAuth);
router.use(checkBan);
router.use(uaParser);

router.use('/', v1);

/**
 * Stream endpoints - mounted before chatRouter to bypass rate limiters
 * These are GET requests and don't need message body validation or rate limiting
 */

/**
 * @route GET /chat/stream/:streamId
 * @desc Subscribe to an ongoing generation job's SSE stream with replay support
 * @access Private
 * @description Sends sync event with resume state, replays missed chunks, then streams live
 * @query resume=true - Indicates this is a reconnection (sends sync event)
 */
router.get('/chat/stream/:streamId', async (req, res) => {
  const { streamId } = req.params;
  const isResume = req.query.resume === 'true';
  const requestProtocolVersion = negotiateRequestGenerationProtocol(req);

  /** Coercing this away (`Number('abc') === NaN`) would collapse the identity
   * fence below back to "attach to whatever currently occupies this id". */
  const rawGenerationCreatedAt = req.query.generationCreatedAt;
  let expectedGenerationCreatedAt;
  if (rawGenerationCreatedAt != null) {
    if (
      typeof rawGenerationCreatedAt !== 'string' ||
      !/^\d+$/.test(rawGenerationCreatedAt) ||
      !Number.isSafeInteger(Number(rawGenerationCreatedAt))
    ) {
      return sendGenerationJson(
        res,
        400,
        { error: 'Invalid generation identity' },
        requestProtocolVersion,
      );
    }
    expectedGenerationCreatedAt = Number(rawGenerationCreatedAt);
  }

  let result;
  const attachmentAbortController = new AbortController();
  req.on('close', () => {
    logger.debug(`[AgentStream] Client disconnected from ${streamId}`);
    attachmentAbortController.abort();
    result?.unsubscribe();
  });

  const job = await GenerationJobManager.getJob(streamId);
  if (attachmentAbortController.signal.aborted) {
    return;
  }
  if (!job) {
    return sendGenerationJson(
      res,
      404,
      {
        error: 'Stream not found',
        message: 'The generation job does not exist or has expired.',
      },
      requestProtocolVersion,
    );
  }

  /** Every job has an owner at creation time (`createJob` rejects an empty user
   * id). Treat a missing/corrupt owner as unauthorized anyway, so corrupted
   * store state cannot become a public stream for anyone who knows the
   * conversation id. */
  if (job.metadata?.userId !== req.user.id) {
    return sendGenerationJson(res, 403, { error: 'Unauthorized' }, requestProtocolVersion);
  }

  if (hasTenantMismatch(job, req.user)) {
    return sendGenerationJson(res, 403, { error: 'Unauthorized' }, requestProtocolVersion);
  }

  const generationProtocolVersion = negotiateExistingGenerationProtocol(req, job);

  if (expectedGenerationCreatedAt != null && job.createdAt !== expectedGenerationCreatedAt) {
    /** streamId is conversation-scoped and may now belong to a newer turn. A
     * stale start/reconnect gets a dedicated handoff signal instead of being
     * attached to a generation this request never authorized. */
    return sendGenerationJson(
      res,
      409,
      {
        code: 'GENERATION_REPLACED',
        error: 'Generation replaced',
        message: 'The requested generation has completed or was replaced.',
      },
      generationProtocolVersion,
    );
  }

  /** Pin even legacy (unfenced-query) subscribers to the exact job snapshot
   * that passed the checks above: a replacement can otherwise land between
   * this authorization read and the manager attachment, exposing the
   * replacement generation without ever authorizing its owner. */
  const authorizedGenerationCreatedAt = job.createdAt;
  if (!Number.isSafeInteger(authorizedGenerationCreatedAt) || authorizedGenerationCreatedAt < 0) {
    logger.warn(`[AgentStream] Refusing stream with invalid generation identity: ${streamId}`);
    return sendGenerationJson(res, 403, { error: 'Unauthorized' }, requestProtocolVersion);
  }

  const streamTelemetry = createSseStreamTelemetry({ req, res, streamId, isResume });

  res.setHeader('Content-Encoding', 'identity');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader(GENERATION_PROTOCOL_HEADER, String(generationProtocolVersion));
  res.flushHeaders();
  streamTelemetry.recordHeadersFlushed();

  logger.debug(`[AgentStream] Client subscribed to ${streamId}, resume: ${isResume}`);

  const writeEvent = (event, options = {}) => {
    if (!res.writableEnded) {
      const eventName = options.eventName ?? 'message';
      const payload = `event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`;
      res.write(payload);
      streamTelemetry.recordWrite(payload, { final: options.final });
      if (typeof res.flush === 'function') {
        res.flush();
      }
      return true;
    }

    return false;
  };

  const onDone = (event) => {
    streamTelemetry.recordFinalEventEmitted();
    writeEvent(
      event != null && typeof event === 'object'
        ? { ...event, generationProtocolVersion }
        : { final: true, generationProtocolVersion },
      { final: true },
    );
    res.end();
  };

  const onError = (error) => {
    if (!res.writableEnded) {
      streamTelemetry.recordErrorEventEmitted();
      writeEvent({ error, generationProtocolVersion }, { eventName: 'error' });
      res.end();
    }
  };

  if (isResume) {
    const { subscription, resumeState, pendingEvents } =
      await GenerationJobManager.subscribeWithResume(streamId, writeEvent, onDone, onError, {
        signal: attachmentAbortController.signal,
        expectedCreatedAt: authorizedGenerationCreatedAt,
      });

    if (subscription && !attachmentAbortController.signal.aborted && !res.writableEnded) {
      if (resumeState) {
        writeEvent({ sync: true, resumeState, pendingEvents });
        GenerationJobManager.markSyncSent(streamId, authorizedGenerationCreatedAt);
        logger.debug(
          `[AgentStream] Sent sync event for ${streamId} with ${resumeState.runSteps.length} run steps, ${pendingEvents.length} pending events`,
        );
      } else if (pendingEvents.length > 0) {
        for (const event of pendingEvents) {
          writeEvent(event);
        }
        logger.warn(
          `[AgentStream] Resume state null for ${streamId}, replayed ${pendingEvents.length} gap events directly`,
        );
      }
      /** `subscribeWithResume` attaches live delivery PAUSED so nothing can
       *  race ahead of the sync frame written above. Releasing it is the
       *  caller's job: skip this and the reconnecting client receives the
       *  snapshot and then nothing at all -- no deltas, no FINAL, no close. */
      subscription.activate();
    } else {
      subscription?.unsubscribe();
    }

    result = subscription;
  } else {
    result = await GenerationJobManager.subscribe(streamId, writeEvent, onDone, onError, {
      signal: attachmentAbortController.signal,
      expectedCreatedAt: authorizedGenerationCreatedAt,
    });
  }

  if (!result) {
    streamTelemetry.recordSubscribeFailed();
    onError('Failed to subscribe to stream');
    return;
  }
});

/**
 * @route GET /chat/active
 * @desc Get all active generation job IDs for the current user
 * @access Private
 * @returns { activeJobIds: string[] }
 */
router.get('/chat/active', async (req, res) => {
  const activeJobIds = await GenerationJobManager.getActiveJobIdsForUser(
    req.user.id,
    req.user.tenantId,
  );
  res.json({ activeJobIds });
});

/**
 * @route GET /chat/status/:conversationId
 * @desc Check if there's an active generation job for a conversation
 * @access Private
 * @returns { active, streamId, status, aggregatedContent, createdAt, resumeState }
 */
router.get('/chat/status/:conversationId', async (req, res) => {
  const { conversationId } = req.params;

  // streamId === conversationId, so we can use getJob directly
  const job = await GenerationJobManager.getJob(conversationId);

  if (!job) {
    return sendJoblessStatus(req, res, conversationId);
  }

  if (job.metadata.userId !== req.user.id) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  if (hasTenantMismatch(job, req.user)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  // Get resume state which contains aggregatedContent
  // Avoid calling both getStreamInfo and getResumeState (both fetch content)
  const resumeState = await GenerationJobManager.getResumeState(conversationId);
  const isActive = job.status === 'running';

  /** A job never changes protocol mid-flight: the epoch it was created with
   * governs every later read, even if the server-wide capability moves. */
  let generationProtocolVersion = negotiateExistingGenerationProtocol(req, job);
  res.set(GENERATION_PROTOCOL_HEADER, String(generationProtocolVersion));

  let unrecoveredSteers;
  if (!isActive || job.metadata.steersClosed === true) {
    const claimed = await GenerationJobManager.steering.claimDetailed(
      conversationId,
      {
        userId: req.user.id,
        tenantId: req.user.tenantId,
      },
      getRequestedGenerationProtocol(req),
    );
    if (claimed.steers.length > 0) {
      generationProtocolVersion = Math.min(
        generationProtocolVersion,
        claimed.generationProtocolVersion,
      );
      res.set(GENERATION_PROTOCOL_HEADER, String(generationProtocolVersion));
      unrecoveredSteers = claimed.steers;
    }
  }

  res.json({
    active: isActive,
    generationProtocolVersion,
    streamId: conversationId,
    status: job.status,
    aggregatedContent: resumeState?.aggregatedContent ?? [],
    createdAt: job.createdAt,
    resumeState,
    ...(unrecoveredSteers && { unrecoveredSteers }),
  });
});

/**
 * @route POST /chat/abort
 * @desc Abort an ongoing generation job
 * @access Private
 * @description Mounted before chatRouter to bypass buildEndpointOption middleware
 */
router.post('/chat/abort', async (req, res) => {
  logger.debug(`[AgentStream] ========== ABORT ENDPOINT HIT ==========`);
  logger.debug(`[AgentStream] Method: ${req.method}, Path: ${req.path}`);
  logger.debug(`[AgentStream] Body:`, req.body);

  const { streamId, conversationId, abortKey } = req.body;
  const userId = req.user?.id;

  // streamId === conversationId, so try any of the provided IDs
  // Skip "new" as it's a placeholder for new conversations, not an actual ID
  let jobStreamId =
    streamId || (conversationId !== 'new' ? conversationId : null) || abortKey?.split(':')[0];
  let job = jobStreamId ? await GenerationJobManager.getJob(jobStreamId) : null;

  // Fallback: if job not found and we have a userId, look up active jobs for user
  // This handles the case where frontend sends "new" but job was created with a UUID
  if (!job && userId) {
    logger.debug(`[AgentStream] Job not found by ID, checking active jobs for user: ${userId}`);
    const activeJobIds = await GenerationJobManager.getActiveJobIdsForUser(
      userId,
      req.user.tenantId,
    );
    if (activeJobIds.length > 0) {
      // Abort the most recent active job for this user
      jobStreamId = activeJobIds[0];
      job = await GenerationJobManager.getJob(jobStreamId);
      logger.debug(`[AgentStream] Found active job for user: ${jobStreamId}`);
    }
  }

  logger.debug(`[AgentStream] Computed jobStreamId: ${jobStreamId}`);

  if (job && jobStreamId) {
    if (job.metadata?.userId && job.metadata.userId !== userId) {
      logger.warn(`[AgentStream] Unauthorized abort attempt for ${jobStreamId} by user ${userId}`);
      return res.status(403).json({ error: 'Unauthorized' });
    }

    if (hasTenantMismatch(job, req.user)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const generationProtocolVersion = negotiateExistingGenerationProtocol(req, job);

    logger.debug(`[AgentStream] Job found, aborting: ${jobStreamId}`);
    const abortResult = await GenerationJobManager.abortJob(jobStreamId);
    logger.debug(`[AgentStream] Job aborted successfully: ${jobStreamId}`, {
      abortResultSuccess: abortResult.success,
      abortResultUserMessageId: abortResult.jobData?.userMessage?.messageId,
      abortResultResponseMessageId: abortResult.jobData?.responseMessageId,
    });

    // CRITICAL: Save partial response BEFORE returning to prevent race condition.
    // If user sends a follow-up immediately after abort, the parentMessageId must exist in DB.
    // Only save if we have a valid responseMessageId (skip early aborts before generation started)
    if (
      abortResult.success &&
      abortResult.jobData?.userMessage?.messageId &&
      abortResult.jobData?.responseMessageId
    ) {
      const { jobData, content, text } = abortResult;
      const responseMessage = {
        messageId: jobData.responseMessageId,
        parentMessageId: jobData.userMessage.messageId,
        conversationId: jobData.conversationId,
        content: content || [],
        text: text || '',
        sender: jobData.sender || 'AI',
        endpoint: jobData.endpoint,
        model: jobData.model,
        unfinished: true,
        error: false,
        isCreatedByUser: false,
        user: userId,
      };

      try {
        await saveMessage(
          {
            userId: req?.user?.id,
            isTemporary: req?.body?.isTemporary,
            interfaceConfig: req?.config?.interfaceConfig,
          },
          responseMessage,
          { context: 'api/server/routes/agents/index.js - abort endpoint' },
        );
        logger.debug(`[AgentStream] Saved partial response for: ${jobStreamId}`);
      } catch (saveError) {
        logger.error(`[AgentStream] Failed to save partial response: ${saveError.message}`);
      }
    }

    return res.json({
      success: true,
      aborted: jobStreamId,
      generationProtocolVersion,
      ...(abortResult.pendingSteers?.length > 0 && { pendingSteers: abortResult.pendingSteers }),
    });
  }

  logger.warn(`[AgentStream] Job not found for streamId: ${jobStreamId}`);
  return res.status(404).json({ error: 'Job not found', streamId: jobStreamId });
});

/**
 * @route POST /chat/steer
 * @desc Queue a mid-run user message for injection at the next tool boundary
 * @access Private
 * @description Mounted before chatRouter to bypass buildEndpointOption middleware,
 * but a steer is model-bound user text, so it carries the same guards as a normal
 * message: the configured IP/user rate limiters, then `moderateText`.
 */
const steerLimiters = [];
if (isEnabled(LIMIT_MESSAGE_IP)) {
  steerLimiters.push(messageIpLimiter);
}
if (isEnabled(LIMIT_MESSAGE_USER)) {
  steerLimiters.push(messageUserLimiter);
}
router.post('/chat/steer', configMiddleware, ...steerLimiters, moderateText, SteerController);

/**
 * @route POST /chat/steer/cancel
 * @desc Remove a still-queued steer before injection (no model-bound content,
 * so no moderation pass — just the shared rate limiters)
 * @access Private
 */
router.post(
  '/chat/steer/cancel',
  configMiddleware,
  ...steerLimiters,
  SteerController.SteerCancelController,
);

/**
 * @route POST /chat/steer/arm
 * @desc Escalate a still-queued steer to an interrupt in place (no new
 * model-bound content, so no moderation pass — just the shared limiters)
 * @access Private
 */
router.post(
  '/chat/steer/arm',
  configMiddleware,
  ...steerLimiters,
  SteerController.SteerArmController,
);

const chatRouter = express.Router();
chatRouter.use(configMiddleware);

if (isEnabled(LIMIT_MESSAGE_IP)) {
  chatRouter.use(messageIpLimiter);
}

if (isEnabled(LIMIT_MESSAGE_USER)) {
  chatRouter.use(messageUserLimiter);
}

chatRouter.use('/', chat);
router.use('/chat', chatRouter);

module.exports = router;
