const passthrough = (req, res, next) => next();
jest.mock('~/server/middleware/optionalJwtAuth', () => passthrough);
jest.mock('~/server/middleware', () => ({
  checkBan: passthrough,
  checkInviteUser: passthrough,
  logHeaders: passthrough,
  loginLimiter: passthrough,
  registerLimiter: passthrough,
  requireJwtAuth: passthrough,
  requireLocalAuth: passthrough,
  resetPasswordLimiter: passthrough,
  setTwoFactorTempUser: passthrough,
  twoFactorTempLimiter: passthrough,
  validatePasswordReset: passthrough,
  validateRegistration: passthrough,
}));

const mockGetAppConfig = jest.fn();
jest.mock('~/server/services/Config', () => ({
  getAppConfig: (...args) => mockGetAppConfig(...args),
}));

const mockCreateUser = jest.fn();
const mockCreateSubscription = jest.fn();
const mockExpireActiveSubscriptions = jest.fn();
const mockGetActiveSubscriptionRecord = jest.fn();
jest.mock('~/models', () => ({
  createUser: (...args) => mockCreateUser(...args),
  createSubscription: (...args) => mockCreateSubscription(...args),
  expireActiveSubscriptions: (...args) => mockExpireActiveSubscriptions(...args),
  getActiveSubscriptionRecord: (...args) => mockGetActiveSubscriptionRecord(...args),
}));

const mockSetAuthTokens = jest.fn();
jest.mock('~/server/services/AuthService', () => ({
  setAuthTokens: (...args) => mockSetAuthTokens(...args),
}));

const mockApplyPlanChange = jest.fn();
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  applyPlanChange: (...args) => mockApplyPlanChange(...args),
}));

const request = require('supertest');
const express = require('express');
const authRoute = require('../auth');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use('/api/auth', authRoute);
  return app;
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/auth/anonymous', () => {
  it('returns 404 when anonymous access is not enabled', async () => {
    mockGetAppConfig.mockResolvedValue({ anonymousAccess: false });
    const app = createApp();

    const response = await request(app).post('/api/auth/anonymous').send();

    expect(response.statusCode).toBe(404);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it('creates an anonymous user, pins the anonymous plan, and returns a token', async () => {
    mockGetAppConfig.mockResolvedValue({ anonymousAccess: true, balance: { enabled: false } });
    mockCreateUser.mockResolvedValue({
      _id: 'anon-user-id',
      email: 'anon-x@chatchat.anonymous',
      provider: 'anonymous',
      role: 'GUEST',
    });
    mockApplyPlanChange.mockResolvedValue({});
    mockSetAuthTokens.mockResolvedValue('jwt-token');
    const app = createApp();

    const response = await request(app).post('/api/auth/anonymous').send();

    expect(response.statusCode).toBe(200);
    expect(response.body.token).toBe('jwt-token');
    expect(response.body.user).toMatchObject({ id: 'anon-user-id', provider: 'anonymous' });
    expect(mockCreateUser).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'anonymous', role: 'GUEST' }),
      { enabled: false },
      false,
      true,
    );
    expect(mockApplyPlanChange).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'anon-user-id', plan_code: 'anonymous' }),
      expect.any(Object),
    );
  });

  it('returns 500 and fails closed when user creation throws', async () => {
    mockGetAppConfig.mockResolvedValue({ anonymousAccess: true, balance: { enabled: false } });
    mockCreateUser.mockRejectedValue(new Error('db down'));
    const app = createApp();

    const response = await request(app).post('/api/auth/anonymous').send();

    expect(response.statusCode).toBe(500);
    expect(mockSetAuthTokens).not.toHaveBeenCalled();
  });
});
