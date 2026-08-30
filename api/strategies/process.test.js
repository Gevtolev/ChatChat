const { FileSources } = require('librechat-data-provider');
const { handleExistingUser, createSocialUser } = require('./process');

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(),
}));

jest.mock('~/server/services/Files/images/avatar', () => ({
  resizeAvatar: jest.fn(),
}));

jest.mock('~/models', () => ({
  updateUser: jest.fn(),
  createUser: jest.fn(),
  getUserById: jest.fn(),
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn().mockResolvedValue({}),
}));

/** `buildPlanChangeDeps` stays real: its whole job is to assemble a complete
 *  dependency object, so a stub would defeat the assertion below. */
jest.mock('@librechat/api', () => ({
  getBalanceConfig: jest.fn(() => ({
    enabled: false,
  })),
  applyPlanChange: jest.fn(),
  buildPlanChangeDeps: jest.requireActual('@librechat/api').buildPlanChangeDeps,
}));

const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { resizeAvatar } = require('~/server/services/Files/images/avatar');
const { updateUser, createUser, getUserById } = require('~/models');
const { applyPlanChange } = require('@librechat/api');

describe('handleExistingUser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CDN_PROVIDER = FileSources.local;
  });

  it('should handle null avatar without throwing error', async () => {
    const oldUser = {
      _id: 'user123',
      avatar: null,
    };
    const avatarUrl = 'https://example.com/avatar.png';

    await handleExistingUser(oldUser, avatarUrl);

    expect(updateUser).toHaveBeenCalledWith('user123', { avatar: avatarUrl });
  });

  it('should handle undefined avatar without throwing error', async () => {
    const oldUser = {
      _id: 'user123',
      // avatar is undefined
    };
    const avatarUrl = 'https://example.com/avatar.png';

    await handleExistingUser(oldUser, avatarUrl);

    expect(updateUser).toHaveBeenCalledWith('user123', { avatar: avatarUrl });
  });

  it('should not update avatar if it has manual=true flag', async () => {
    const oldUser = {
      _id: 'user123',
      avatar: 'https://example.com/avatar.png?manual=true',
    };
    const avatarUrl = 'https://example.com/new-avatar.png';

    await handleExistingUser(oldUser, avatarUrl);

    expect(updateUser).not.toHaveBeenCalled();
  });

  it('should update avatar for local storage when avatar has no manual flag', async () => {
    const oldUser = {
      _id: 'user123',
      avatar: 'https://example.com/old-avatar.png',
    };
    const avatarUrl = 'https://example.com/new-avatar.png';

    await handleExistingUser(oldUser, avatarUrl);

    expect(updateUser).toHaveBeenCalledWith('user123', { avatar: avatarUrl });
  });

  it('should process avatar for non-local storage', async () => {
    process.env.CDN_PROVIDER = 's3';

    const mockProcessAvatar = jest.fn().mockResolvedValue('processed-avatar-url');
    getStrategyFunctions.mockReturnValue({ processAvatar: mockProcessAvatar });
    resizeAvatar.mockResolvedValue(Buffer.from('resized-image'));

    const oldUser = {
      _id: 'user123',
      avatar: null,
    };
    const avatarUrl = 'https://example.com/avatar.png';

    await handleExistingUser(oldUser, avatarUrl);

    expect(resizeAvatar).toHaveBeenCalledWith({
      userId: 'user123',
      input: avatarUrl,
    });
    expect(mockProcessAvatar).toHaveBeenCalledWith({
      buffer: Buffer.from('resized-image'),
      userId: 'user123',
      manual: 'false',
    });
    expect(updateUser).toHaveBeenCalledWith('user123', { avatar: 'processed-avatar-url' });
  });

  it('should not update if avatar already has manual flag in non-local storage', async () => {
    process.env.CDN_PROVIDER = 's3';

    const oldUser = {
      _id: 'user123',
      avatar: 'https://cdn.example.com/avatar.png?manual=true',
    };
    const avatarUrl = 'https://example.com/new-avatar.png';

    await handleExistingUser(oldUser, avatarUrl);

    expect(resizeAvatar).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('should handle avatar with query parameters but without manual flag', async () => {
    const oldUser = {
      _id: 'user123',
      avatar: 'https://example.com/avatar.png?size=large&format=webp',
    };
    const avatarUrl = 'https://example.com/new-avatar.png';

    await handleExistingUser(oldUser, avatarUrl);

    expect(updateUser).toHaveBeenCalledWith('user123', { avatar: avatarUrl });
  });

  it('should handle empty string avatar', async () => {
    const oldUser = {
      _id: 'user123',
      avatar: '',
    };
    const avatarUrl = 'https://example.com/avatar.png';

    await handleExistingUser(oldUser, avatarUrl);

    expect(updateUser).toHaveBeenCalledWith('user123', { avatar: avatarUrl });
  });

  it('should handle avatar with manual=false parameter', async () => {
    const oldUser = {
      _id: 'user123',
      avatar: 'https://example.com/avatar.png?manual=false',
    };
    const avatarUrl = 'https://example.com/new-avatar.png';

    await handleExistingUser(oldUser, avatarUrl);

    expect(updateUser).toHaveBeenCalledWith('user123', { avatar: avatarUrl });
  });

  it('should handle oldUser being null gracefully', async () => {
    const avatarUrl = 'https://example.com/avatar.png';

    // This should throw an error when trying to access oldUser._id
    await expect(handleExistingUser(null, avatarUrl)).rejects.toThrow();
  });

  it('should update email when it has changed', async () => {
    const oldUser = {
      _id: 'user123',
      email: 'old@example.com',
      avatar: 'https://example.com/avatar.png?manual=true',
    };
    const avatarUrl = 'https://example.com/avatar.png';
    const newEmail = 'new@example.com';

    await handleExistingUser(oldUser, avatarUrl, {}, newEmail);

    expect(updateUser).toHaveBeenCalledWith('user123', { email: 'new@example.com' });
  });

  it('should update both avatar and email when both have changed', async () => {
    const oldUser = {
      _id: 'user123',
      email: 'old@example.com',
      avatar: null,
    };
    const avatarUrl = 'https://example.com/new-avatar.png';
    const newEmail = 'new@example.com';

    await handleExistingUser(oldUser, avatarUrl, {}, newEmail);

    expect(updateUser).toHaveBeenCalledWith('user123', {
      avatar: avatarUrl,
      email: 'new@example.com',
    });
  });

  it('should not update email when it has not changed', async () => {
    const oldUser = {
      _id: 'user123',
      email: 'same@example.com',
      avatar: 'https://example.com/avatar.png?manual=true',
    };
    const avatarUrl = 'https://example.com/avatar.png';
    const sameEmail = 'same@example.com';

    await handleExistingUser(oldUser, avatarUrl, {}, sameEmail);

    expect(updateUser).not.toHaveBeenCalled();
  });

  it('should trim email before comparison and update', async () => {
    const oldUser = {
      _id: 'user123',
      email: 'test@example.com',
      avatar: 'https://example.com/avatar.png?manual=true',
    };
    const avatarUrl = 'https://example.com/avatar.png';
    const newEmailWithSpaces = '  newemail@example.com  ';

    await handleExistingUser(oldUser, avatarUrl, {}, newEmailWithSpaces);

    expect(updateUser).toHaveBeenCalledWith('user123', { email: 'newemail@example.com' });
  });

  it('should not update when email parameter is not provided', async () => {
    const oldUser = {
      _id: 'user123',
      email: 'test@example.com',
      avatar: 'https://example.com/avatar.png?manual=true',
    };
    const avatarUrl = 'https://example.com/avatar.png';

    await handleExistingUser(oldUser, avatarUrl, {});

    expect(updateUser).not.toHaveBeenCalled();
  });
});

describe('createSocialUser — plan grant', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CDN_PROVIDER = FileSources.local;
    getUserById.mockResolvedValue({ _id: 'newuser123' });
    createUser.mockResolvedValue('newuser123');
  });

  const args = {
    email: 'someone@example.com',
    avatarUrl: null,
    provider: 'google',
    providerKey: 'googleId',
    providerId: 'g-1',
    username: 'someone',
    name: 'Some One',
    appConfig: {},
    emailVerified: true,
  };

  /** OAuth signup created the account and stopped, leaving no Subscription and
   *  no Balance. The gate reads a missing Balance as zero, so those accounts
   *  would be denied outright once enforcement is on. */
  it('grants the free plan to a socially-registered user', async () => {
    await createSocialUser(args);

    expect(applyPlanChange).toHaveBeenCalledTimes(1);
    expect(applyPlanChange.mock.calls[0][0]).toEqual({
      user_id: 'newuser123',
      plan_code: 'free',
      source: 'system_default',
    });
  });

  /** The omission that would throw a TypeError out of `applyPlanChange` rather
   *  than denying cleanly — see packages/api/src/billing/deps.ts. */
  it('passes a complete dependency set, grantMonthlyCredits included', () => {
    return createSocialUser(args).then(() => {
      const deps = applyPlanChange.mock.calls[0][1];
      expect(Object.keys(deps).sort()).toEqual(
        [
          'createQuota',
          'createSubscription',
          'expireActiveSubscriptions',
          'getActiveSubscriptionRecord',
          'grantMonthlyCredits',
        ].sort(),
      );
    });
  });
});
