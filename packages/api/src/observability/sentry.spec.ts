/** The SDK is mocked at the module boundary rather than spied on: TypeScript's
 *  `__importStar` copies the namespace when compiling `import * as Sentry`, so a
 *  spy on the real module never reaches the reference `sentry.ts` holds. An
 *  external SDK is also the one category this project sanctions mocking. */
jest.mock('@sentry/node', () => ({
  init: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

import * as Sentry from '@sentry/node';
import { SentryIssueTransport, findError, initSentry, resetSentry, shouldIgnore } from './sentry';
import type { Logger } from 'winston';

const sentry = Sentry as unknown as {
  init: jest.Mock;
  captureException: jest.Mock;
  captureMessage: jest.Mock;
};

function fakeLogger() {
  return { add: jest.fn() } as unknown as Logger & { add: jest.Mock };
}

beforeEach(() => {
  jest.clearAllMocks();
  sentry.init.mockImplementation(() => undefined);
});

afterEach(() => {
  resetSentry();
});

describe('initSentry', () => {
  /** A local checkout and CI have no DSN and must not be asked to care that
   *  this module exists — no SDK, no transport, no warning. */
  test('does nothing without a DSN', () => {
    const logger = fakeLogger();

    expect(initSentry(logger, {})).toBe(false);
    expect(sentry.init).not.toHaveBeenCalled();
    expect(logger.add).not.toHaveBeenCalled();
  });

  test('attaches an error-level transport when configured', () => {
    const logger = fakeLogger();

    expect(initSentry(logger, { SENTRY_DSN: 'https://key@example.ingest.sentry.io/1' })).toBe(true);
    expect(logger.add).toHaveBeenCalledTimes(1);
    expect(logger.add.mock.calls[0][0].level).toBe('error');
  });

  test('attaches once even if called twice', () => {
    const logger = fakeLogger();
    const env = { SENTRY_DSN: 'https://key@example.ingest.sentry.io/1' };

    initSentry(logger, env);
    expect(initSentry(logger, env)).toBe(false);
    expect(logger.add).toHaveBeenCalledTimes(1);
  });

  /** An SDK that fails to start must not take the server down with it. */
  test('survives an SDK that throws', () => {
    const logger = fakeLogger();
    sentry.init.mockImplementation(() => {
      throw new Error('bad dsn');
    });

    expect(initSentry(logger, { SENTRY_DSN: 'nonsense' })).toBe(false);
  });
});

describe('the winston transport', () => {
  const log = (info: Record<string, unknown>) => {
    const transport = new SentryIssueTransport({ level: 'error' });
    const done = jest.fn();
    transport.log(info, done);
    return done;
  };

  /**
   * Errors reach Sentry as issues, which is what raises alerts.
   * `@sentry/node` ships `createSentryWinstonTransport`, but it calls
   * `captureLog` — that populates Sentry Logs, a different product that does not
   * alert. Hence this transport.
   */
  test('reports an error as an exception', () => {
    const boom = new Error('upstream returned 401');

    log({ level: 'error', message: 'call failed', [Symbol.for('splat')]: [boom] });

    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException.mock.calls[0][0]).toBe(boom);
  });

  test('reports a bare string as an error-level message', () => {
    log({ level: 'error', message: 'something went wrong' });

    expect(sentry.captureMessage).toHaveBeenCalledWith(
      'something went wrong',
      expect.objectContaining({ level: 'error' }),
    );
  });

  /** Known-benign lines that would otherwise spend the monthly quota saying
   *  nothing. Deliberately short — the risk of an ignore list is that the thing
   *  silenced turns out to be the thing that broke. */
  test('ignores known-benign noise', () => {
    log({ level: 'error', message: 'RAG API is either not running or not reachable' });

    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });

  /** Observability is never a failure source: a broken transport must not stop
   *  winston from finishing the log call. */
  test('calls back even when Sentry throws', () => {
    sentry.captureMessage.mockImplementation(() => {
      throw new Error('sentry is down');
    });

    const done = log({ level: 'error', message: 'anything' });

    expect(done).toHaveBeenCalled();
  });
});

describe('findError', () => {
  /** `logger.error('text:', err)` is the shape this codebase uses everywhere;
   *  winston puts the Error in the splat, not on `info`. */
  test('finds an Error passed as a trailing argument', () => {
    const boom = new Error('boom');
    expect(findError({ message: 'failed:', [Symbol.for('splat')]: [boom] })).toBe(boom);
  });

  test('finds an Error on a named field', () => {
    const boom = new Error('boom');
    expect(findError({ message: 'failed', reason: boom })).toBe(boom);
  });

  test('returns null when there is no Error anywhere', () => {
    expect(findError({ message: 'just a string', code: 42 })).toBeNull();
  });
});

describe('shouldIgnore', () => {
  test.each([
    'RAG API is either not running or not reachable at undefined',
    '[mongoMeili] Error checking index convos: fetch failed',
  ])('silences %j', (message) => {
    expect(shouldIgnore(message)).toBe(true);
  });

  /** The list must stay narrow. An upstream 401 is the exact event this system
   *  exists to catch, and it mentions a failure like the ignored ones do. */
  test('does not silence an upstream rejection', () => {
    expect(shouldIgnore('Operation aborted 401 "Balance is insufficient"')).toBe(false);
  });
});
