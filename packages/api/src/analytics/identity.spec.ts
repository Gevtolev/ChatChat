import { hashUserId } from './identity';

const SALT = 'a-long-random-salt-value';
const USER = '6a58a058df283dd05f0e28b6';

const env = (salt?: string): NodeJS.ProcessEnv =>
  salt === undefined ? {} : { POSTHOG_ID_SALT: salt };

describe('hashUserId', () => {
  test('is stable for the same user', () => {
    expect(hashUserId(USER, env(SALT))).toBe(hashUserId(USER, env(SALT)));
  });

  test('separates different users', () => {
    expect(hashUserId(USER, env(SALT))).not.toBe(hashUserId('6a54a6ac1e3b63316850d10a', env(SALT)));
  });

  test('never contains the original id', () => {
    expect(hashUserId(USER, env(SALT))).not.toContain(USER);
  });

  test('is 32 hex characters', () => {
    expect(hashUserId(USER, env(SALT))).toMatch(/^[0-9a-f]{32}$/);
  });

  /**
   * The salt is what makes a hash unguessable: an ObjectId is a 4-byte
   * timestamp plus a machine id plus a counter, so an unsalted digest of one is
   * enumerable. A deployment that forgot to set the salt must therefore send
   * nothing at all — falling back to an unsalted hash would look like it was
   * working while providing none of the protection it claims.
   */
  test('produces nothing without a salt rather than falling back', () => {
    expect(hashUserId(USER, env(undefined))).toBeNull();
    expect(hashUserId(USER, env(''))).toBeNull();
  });

  test('produces nothing without a user id', () => {
    expect(hashUserId(undefined, env(SALT))).toBeNull();
    expect(hashUserId(null, env(SALT))).toBeNull();
  });

  /**
   * Changing the salt splits every existing user into two unrelated people and
   * no later correction repairs the funnel history. The property is asserted so
   * that anyone tempted to rotate it sees, in a test name, what it costs.
   */
  test('a different salt yields a different person', () => {
    expect(hashUserId(USER, env(SALT))).not.toBe(hashUserId(USER, env('another-salt')));
  });
});
