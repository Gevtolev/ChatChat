import { ContentTypes } from 'librechat-data-provider';

/** The shape of what LangChain throws out of a run. Everything is optional
 *  because the thrower is a provider SDK, not us. */
export interface RunError {
  message?: string;
  lc_error_code?: string;
}

interface ContentPart {
  type?: string;
}

/**
 * LangChain tags a provider rejecting our credentials — wrong key, expired key,
 * unpaid account — with this code, and rewrites the message to append its
 * troubleshooting URL.
 */
const PROVIDER_AUTH_CODE = 'MODEL_AUTHENTICATION';

export function isProviderAuthError(err?: RunError | null): boolean {
  return err?.lc_error_code === PROVIDER_AUTH_CODE;
}

/**
 * The error text shown in place of the assistant's reply.
 *
 * Provider authentication failures get a code instead of the provider's own
 * words, because those words are about *our* account and read as if they were
 * about the user's. Production returned `401 "Balance is insufficient"` from an
 * upstream whose prepaid balance had run out, and we appended it verbatim — so
 * a user holding 42 million credits was told, in our own product's vocabulary
 * for their allowance, that their balance was insufficient. There is no reading
 * of that sentence that leads them anywhere true.
 *
 * Everything else keeps the provider's message. A malformed request or a
 * context-length error is genuinely about what the user sent, and stripping the
 * detail there would trade one unhelpful message for another.
 */
export function buildRunErrorText(err?: RunError | null): string {
  if (isProviderAuthError(err)) {
    return JSON.stringify({ code: 'provider_unavailable' });
  }
  return `An error occurred while processing the request${err?.message ? `: ${err.message}` : ''}`;
}

/**
 * Whether the turn produced anything the user can actually use.
 *
 * Content parts accumulate as the run streams, so by the time a failure is
 * caught this holds whatever arrived before it. A turn carrying only an error
 * part produced nothing — the provider rejected it outright — and billing for
 * it charges the user for our outage. A turn that streamed real text and *then*
 * failed did consume provider capacity, and stays billable.
 */
export function producedUsableOutput(parts?: ContentPart[] | null): boolean {
  if (!parts?.length) {
    return false;
  }
  return parts.some((part) => part?.type !== ContentTypes.ERROR);
}
