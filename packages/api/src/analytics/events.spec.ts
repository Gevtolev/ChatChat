import { TelemetryEvents } from 'librechat-data-provider';
import * as client from './client';
import { analytics } from './index';

const USER = '6a58a058df283dd05f0e28b6';

/** A stand-in for the PostHog client that records what it was asked to send.
 *  The emitter's own logic — the allowlist, the hashing, the swallowing — runs
 *  for real; only the network boundary is replaced. */
function fakeClient() {
  return { capture: jest.fn() };
}

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

afterEach(() => {
  jest.restoreAllMocks();
});

describe('event emission', () => {
  test('sends the event name and a hashed identifier', () => {
    const fake = fakeClient();
    jest.spyOn(client, 'getAnalyticsClient').mockReturnValue(fake as never);

    analytics.signupCompleted(USER, 'google');

    expect(fake.capture).toHaveBeenCalledTimes(1);
    const call = fake.capture.mock.calls[0][0];
    expect(call.event).toBe(TelemetryEvents.SIGNUP_COMPLETED);
    expect(call.properties).toEqual({ method: 'google' });
    /** Never the raw id. */
    expect(call.distinctId).not.toBe(USER);
    expect(call.distinctId).toMatch(/^[0-9a-f]{32}$/);
  });

  test('labels a message with model, plan and endpoint', () => {
    const fake = fakeClient();
    jest.spyOn(client, 'getAnalyticsClient').mockReturnValue(fake as never);

    analytics.messageSent(USER, {
      model: 'claude-opus-5',
      plan: 'plus',
      endpoint: 'agents',
      is_new_conversation: true,
    });

    expect(fake.capture.mock.calls[0][0].properties).toEqual({
      model: 'claude-opus-5',
      plan: 'plus',
      endpoint: 'agents',
      is_new_conversation: true,
    });
  });

  test('distinguishes the trial cap from a spent allowance', () => {
    const fake = fakeClient();
    jest.spyOn(client, 'getAnalyticsClient').mockReturnValue(fake as never);

    analytics.quotaExhausted(USER, { plan: 'anonymous', limit_type: 'trial_messages' });
    analytics.quotaExhausted(USER, { plan: 'plus', limit_type: 'credits', credits_at_block: 12 });

    expect(fake.capture.mock.calls[0][0].properties.limit_type).toBe('trial_messages');
    expect(fake.capture.mock.calls[1][0].properties).toEqual({
      plan: 'plus',
      limit_type: 'credits',
      credits_at_block: 12,
    });
  });
});

/**
 * The allowlist is asserted positively — "these properties and no others" —
 * rather than by checking that a few known-bad names are absent. A denylist only
 * catches the leaks somebody already thought of; the one that matters is a
 * `conversationId` or a message title added to an event in a hurry, which no
 * reviewer would catch and which this test fails on by default.
 */
describe('property allowlist', () => {
  test('drops anything not explicitly allowed', () => {
    const fake = fakeClient();
    jest.spyOn(client, 'getAnalyticsClient').mockReturnValue(fake as never);

    analytics.messageSent(USER, {
      model: 'claude-opus-5',
      conversationId: '12cbfbfc-a230-4117-bc0f-6c72689ac108',
      title: 'How do I file my taxes',
      text: 'the actual message',
      email: 'someone@example.com',
    } as never);

    expect(fake.capture.mock.calls[0][0].properties).toEqual({ model: 'claude-opus-5' });
  });

  test('drops null and undefined rather than sending empty keys', () => {
    const fake = fakeClient();
    jest.spyOn(client, 'getAnalyticsClient').mockReturnValue(fake as never);

    analytics.messageSent(USER, { model: 'claude-opus-5', plan: undefined, endpoint: undefined });

    expect(fake.capture.mock.calls[0][0].properties).toEqual({ model: 'claude-opus-5' });
  });
});

describe('telemetry is never a failure source', () => {
  test('sends nothing when unconfigured', () => {
    jest.spyOn(client, 'getAnalyticsClient').mockReturnValue(null);

    expect(() => analytics.messageSent(USER, { model: 'x' })).not.toThrow();
  });

  test('a throwing client does not reach the caller', () => {
    const fake = {
      capture: jest.fn(() => {
        throw new Error('posthog is down');
      }),
    };
    jest.spyOn(client, 'getAnalyticsClient').mockReturnValue(fake as never);

    expect(() => analytics.messageSent(USER, { model: 'x' })).not.toThrow();
  });

  /** No salt means no identifier, and an event with no identifier is worse than
   *  no event — it would land in PostHog as an anonymous row nobody can use. */
  test('sends nothing when the salt is missing', () => {
    const fake = fakeClient();
    jest.spyOn(client, 'getAnalyticsClient').mockReturnValue(fake as never);
    const salt = process.env.POSTHOG_ID_SALT;
    delete process.env.POSTHOG_ID_SALT;

    analytics.messageSent(USER, { model: 'x' });

    process.env.POSTHOG_ID_SALT = salt;
    expect(fake.capture).not.toHaveBeenCalled();
  });
});
