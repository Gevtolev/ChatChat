/**
 * Route-level regression guard for the agent Action credential reconciliation
 * (upstream 07af6ee28). Before that fix, `POST /agents/actions/:agent_id`
 * merged stored metadata under the incoming payload, so re-pointing an Action
 * at a new domain silently carried the previous credentials to the new target.
 */
jest.mock('~/models', () => ({
  getAgent: jest.fn(),
  getActions: jest.fn(),
  updateAgent: jest.fn(),
  updateAction: jest.fn(),
  deleteTokens: jest.fn(async () => ({ deletedCount: 0 })),
  getRoleByName: jest.fn(),
  getListAgentsByAccess: jest.fn(),
}));
jest.mock('~/server/middleware', () => ({
  canAccessAgentResource: () => (req, res, next) => next(),
}));
jest.mock('~/server/services/PermissionService', () => ({
  findAccessibleResources: jest.fn(async () => []),
}));
jest.mock('~/server/services/ActionService', () => ({
  /** Mirrors the real encryptMetadata contract without needing CREDS_KEY. */
  encryptMetadata: jest.fn(async (metadata) => {
    const result = { ...metadata };
    if (metadata.auth?.type === 'service_http' && metadata.api_key) {
      result.api_key = `enc(${metadata.api_key})`;
    }
    return result;
  }),
  domainParser: jest.fn(async (domain) => domain?.replace(/^https?:\/\//, '').replace(/\./g, '_')),
  legacyDomainEncode: jest.fn((domain) => (domain ? domain.replace(/\./g, '_') : '')),
}));
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  generateCheckAccess: () => (req, res, next) => next(),
}));

const express = require('express');
const request = require('supertest');
const db = require('~/models');
const actionsRouter = require('~/server/routes/agents/actions');

const AGENT_ID = 'agent_abc';
const ACTION_ID = 'act_existing';
const TRUSTED_DOMAIN = 'api.trusted-partner.com';
const ATTACKER_DOMAIN = 'exfil.attacker.example';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 'user_1', role: 'USER' };
    req.config = { actions: {} };
    next();
  });
  app.use('/actions', actionsRouter);
  return app;
}

describe('agent action update must not carry credentials to a new target', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    db.getAgent.mockResolvedValue({
      id: AGENT_ID,
      author: 'user_1',
      actions: [`${TRUSTED_DOMAIN.replace(/\./g, '_')}_action_act_existing`],
      tools: [],
    });
    db.getActions.mockResolvedValue([
      {
        action_id: ACTION_ID,
        agent_id: AGENT_ID,
        metadata: {
          domain: TRUSTED_DOMAIN,
          api_key: 'enc(SUPER-SECRET-PARTNER-KEY)',
          auth: { type: 'service_http', authorization_type: 'bearer' },
        },
      },
    ]);
    db.updateAgent.mockResolvedValue({ id: AGENT_ID });
    db.updateAction.mockImplementation(async (_query, data) => ({
      action_id: ACTION_ID,
      agent_id: AGENT_ID,
      metadata: { ...data.metadata },
    }));
  });

  test('re-pointing an action at a new domain without re-entering credentials', async () => {
    const res = await request(buildApp())
      .post(`/actions/${AGENT_ID}`)
      .send({
        action_id: ACTION_ID,
        functions: [{ type: 'function', function: { name: 'exfiltrate', description: 'x' } }],
        metadata: {
          domain: ATTACKER_DOMAIN,
          auth: { type: 'service_http', authorization_type: 'bearer' },
        },
      });

    const persisted = db.updateAction.mock.calls[0]?.[1]?.metadata;

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/credentials must be re-entered/i);
    expect(db.updateAction).not.toHaveBeenCalled();
    expect(db.updateAgent).not.toHaveBeenCalled();
    expect(persisted).toBeUndefined();
  });

  test('stale OAuth tokens are revoked when the target moves', async () => {
    db.getActions.mockResolvedValue([
      {
        action_id: ACTION_ID,
        agent_id: AGENT_ID,
        metadata: {
          domain: TRUSTED_DOMAIN,
          auth: {
            type: 'oauth',
            client_url: `https://${TRUSTED_DOMAIN}/authorize`,
            authorization_url: `https://${TRUSTED_DOMAIN}/token`,
          },
          oauth_client_id: 'enc(old-id)',
          oauth_client_secret: 'enc(old-secret)',
        },
      },
    ]);

    const res = await request(buildApp())
      .post(`/actions/${AGENT_ID}`)
      .send({
        action_id: ACTION_ID,
        functions: [{ type: 'function', function: { name: 'moved', description: 'x' } }],
        metadata: {
          domain: ATTACKER_DOMAIN,
          auth: {
            type: 'oauth',
            client_url: `https://${ATTACKER_DOMAIN}/authorize`,
            authorization_url: `https://${ATTACKER_DOMAIN}/token`,
          },
          oauth_client_id: 'fresh-id',
          oauth_client_secret: 'fresh-secret',
        },
      });

    expect(res.status).toBe(200);
    expect(db.deleteTokens).toHaveBeenCalledTimes(2);
    expect(db.deleteTokens.mock.calls.map(([q]) => q.type).sort()).toEqual([
      'oauth',
      'oauth_refresh',
    ]);
  });
});
