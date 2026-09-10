import * as Sentry from '@sentry/node';
import Transport from 'winston-transport';
import { scrubEvent } from './scrub';
import type { Logger } from 'winston';

/**
 * Errors that are loud, expected, and tell us nothing. Matched against the
 * message. Kept short on purpose — the temptation with an ignore list is to
 * silence whatever is currently noisy, and the thing you silence is eventually
 * the thing that broke.
 */
const IGNORED = [
  /RAG API is either not running/,
  /\[mongoMeili\].*fetch failed/,
  /Error: aborted$/,
];

export function shouldIgnore(message: string): boolean {
  return IGNORED.some((pattern) => pattern.test(message));
}

interface WinstonInfo {
  level?: string;
  message?: unknown;
  stack?: string;
  [key: string]: unknown;
}

/** Winston stores extra arguments under this symbol. `logger.error('msg', err)`
 *  puts the Error there rather than on `info`. */
const SPLAT = Symbol.for('splat');

export function findError(info: WinstonInfo): Error | null {
  if (info instanceof Error) {
    return info;
  }
  const splat = (info as Record<symbol, unknown>)[SPLAT];
  if (Array.isArray(splat)) {
    for (const arg of splat) {
      if (arg instanceof Error) {
        return arg;
      }
    }
  }
  for (const value of Object.values(info)) {
    if (value instanceof Error) {
      return value;
    }
  }
  return null;
}

/**
 * Forwards `logger.error` to Sentry as an **issue**, not a log line.
 *
 * `@sentry/node` ships `createSentryWinstonTransport`, which calls `captureLog`
 * — that populates Sentry Logs, a separate product from Issues, and Logs do not
 * raise the alerts this exists for. Hence the small transport.
 */
class SentryIssueTransport extends Transport {
  log(info: WinstonInfo, callback: () => void): void {
    setImmediate(() => this.emit('logged', info));
    try {
      const message = typeof info.message === 'string' ? info.message : String(info.message ?? '');
      if (shouldIgnore(message)) {
        callback();
        return;
      }
      const { level: _level, message: _message, ...rest } = info;
      const error = findError(info);
      if (error) {
        Sentry.captureException(error, { extra: { logMessage: message, ...rest } });
      } else {
        Sentry.captureMessage(message, { level: 'error', extra: rest });
      }
    } catch {
      /* observability is never a failure source */
    }
    callback();
  }
}

let initialised = false;

/**
 * Starts error reporting, if a DSN is configured.
 *
 * Attaches to winston rather than instrumenting call sites. Every error in this
 * codebase already flows through `logger.error`, including the process-level
 * `uncaughtException` and `unhandledRejection` handlers in
 * `api/server/index.js` — so one transport catches everything, where hand-placed
 * `captureException` calls would only catch what someone thought to instrument.
 * The outage that prompted this was twelve seconds of upstream 401s, found
 * because a human asked; it was seven `logger.error` lines and not one of them
 * was at a site anybody would have chosen to instrument in advance.
 *
 * No DSN means no SDK, no transport, and no warning — a local checkout and CI
 * should not have to care that this exists.
 */
export function initSentry(logger: Logger, env: NodeJS.ProcessEnv = process.env): boolean {
  if (initialised || !env.SENTRY_DSN) {
    return false;
  }

  try {
    Sentry.init({
      dsn: env.SENTRY_DSN,
      environment: env.NODE_ENV ?? 'development',
      release: env.SENTRY_RELEASE,
      /** Errors only. Traces are a different budget and a different question. */
      tracesSampleRate: 0,
      /** Off by default in the SDK, restated because sending them would defeat
       *  the point of hashing the user id. */
      sendDefaultPii: false,
      beforeSend: (event) => {
        try {
          return scrubEvent(event);
        } catch {
          /** A scrubber that throws must drop the event, not ship it unscrubbed. */
          return null;
        }
      },
    });
    logger.add(new SentryIssueTransport({ level: 'error' }));
    initialised = true;
    return true;
  } catch {
    return false;
  }
}

/** Test seam. */
export function resetSentry(): void {
  initialised = false;
}

export { SentryIssueTransport };
