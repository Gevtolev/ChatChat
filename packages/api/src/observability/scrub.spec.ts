import { scrubEvent } from './scrub';
import type { ErrorEvent } from '@sentry/node';

const USER = '6a58a058df283dd05f0e28b6';

let originalSalt: string | undefined;

beforeAll(() => {
  originalSalt = process.env.POSTHOG_ID_SALT;
  process.env.POSTHOG_ID_SALT = 'test-salt';
});

afterAll(() => {
  if (originalSalt === undefined) {
    delete process.env.POSTHOG_ID_SALT;
  } else {
    process.env.POSTHOG_ID_SALT = originalSalt;
  }
});

const event = (over: Partial<ErrorEvent> = {}): ErrorEvent => ({ ...over }) as ErrorEvent;

describe('credential removal', () => {
  /** Every outbound request this server makes carries a provider key, and an
   *  error thrown mid-request drags the headers along with it. */
  test('redacts credential headers', () => {
    const out = scrubEvent(
      event({
        request: {
          headers: {
            authorization: 'Bearer sk-live-secret',
            Cookie: 'refreshToken=abc',
            'x-api-key': 'sk-another',
            'user-agent': 'Mozilla/5.0',
          },
        },
      }),
    );

    expect(out.request?.headers).toEqual({
      authorization: '[redacted]',
      Cookie: '[redacted]',
      'x-api-key': '[redacted]',
      'user-agent': 'Mozilla/5.0',
    });
  });

  test('redacts cookies wholesale', () => {
    const out = scrubEvent(event({ request: { cookies: { refreshToken: 'abc' } } }));
    expect(JSON.stringify(out.request?.cookies)).not.toContain('abc');
  });

  test('redacts secret-looking keys in extra data', () => {
    const out = scrubEvent(
      event({
        extra: {
          OPENAI_API_KEY: 'sk-live',
          sentryDsn: 'https://x@y/1',
          password: 'hunter2',
          model: 'claude-opus-5',
        },
      }),
    );

    expect(out.extra).toEqual({
      OPENAI_API_KEY: '[redacted]',
      sentryDsn: '[redacted]',
      password: '[redacted]',
      model: 'claude-opus-5',
    });
  });
});

describe('user identity', () => {
  /**
   * The logger attaches a raw `userId` to most errors. Sending it would put a
   * database primary key into a third party's store; the hash — the same one
   * PostHog receives — lets us correlate the two without either vendor holding
   * something that resolves to a person.
   */
  test('replaces a raw user id with the shared hash', () => {
    const out = scrubEvent(event({ extra: { userId: USER } }));

    expect(out.user?.id).toMatch(/^[0-9a-f]{32}$/);
    expect(out.user?.id).not.toBe(USER);
    expect(out.extra?.userId).toBe(out.user?.id);
    expect(JSON.stringify(out)).not.toContain(USER);
  });

  /** Sentry's user object also carries email, username and ip_address. It is
   *  replaced rather than edited so a field added by the SDK later cannot ride
   *  along unnoticed. */
  test('drops email, username and ip alongside the id', () => {
    const out = scrubEvent(
      event({
        user: {
          id: USER,
          email: 'someone@example.com',
          username: 'someone',
          ip_address: '203.0.113.4',
        },
      }),
    );

    expect(out.user).toEqual({ id: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(JSON.stringify(out)).not.toContain('someone@example.com');
    expect(JSON.stringify(out)).not.toContain('203.0.113.4');
  });

  test('leaves no user when there is none to hash', () => {
    expect(scrubEvent(event({})).user).toBeUndefined();
  });
});
