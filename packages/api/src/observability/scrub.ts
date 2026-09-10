import { hashUserId } from '~/analytics/identity';
import type { ErrorEvent } from '@sentry/node';

/** Header names that carry credentials. Compared lowercased. */
const SECRET_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'proxy-authorization',
]);

/** Keys whose values are secrets wherever they appear in extra data. */
const SECRET_KEY_PATTERN = /(authorization|cookie|api[_-]?key|secret|password|token|dsn)/i;

const REDACTED = '[redacted]';

function scrubRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : value;
  }
  return out;
}

/**
 * Removes credentials and direct user identifiers before an event leaves the
 * process.
 *
 * Runs as Sentry's `beforeSend`, which is the last point we control. Two things
 * it must handle:
 *
 * Credentials — every request this server makes carries a provider API key, and
 * an error thrown mid-request can drag the headers along with it.
 *
 * User identity — the logger attaches a raw `userId` to most errors. Sending it
 * would put a database primary key in a third party's store, and would let
 * Sentry and PostHog be joined against each other on a value that resolves to a
 * real person in our own database. The hash replaces it, and is the *same* hash
 * PostHog uses, so the two can still be correlated by us without either vendor
 * holding an identifier that means anything.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request?.headers) {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(event.request.headers)) {
      headers[name] = SECRET_HEADERS.has(name.toLowerCase()) ? REDACTED : value;
    }
    event.request.headers = headers;
  }
  if (event.request?.cookies) {
    event.request.cookies = { [REDACTED]: REDACTED };
  }

  if (event.extra) {
    event.extra = scrubRecord(event.extra);
  }
  if (event.contexts) {
    event.contexts = scrubRecord(event.contexts) as ErrorEvent['contexts'];
  }

  const rawUserId =
    (event.extra?.userId as string | undefined) ?? (event.user?.id as string | undefined);
  const hashed = hashUserId(rawUserId);
  /** Replaced wholesale rather than edited: Sentry's user object also carries
   *  `email`, `username` and `ip_address`, none of which we want. */
  event.user = hashed ? { id: hashed } : undefined;
  if (event.extra && 'userId' in event.extra) {
    event.extra.userId = hashed ?? REDACTED;
  }

  return event;
}
