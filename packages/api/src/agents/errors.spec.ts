import { ContentTypes } from 'librechat-data-provider';
import { buildRunErrorText, isProviderAuthError, producedUsableOutput } from './errors';

/** The exact shape LangChain throws: it sets `lc_error_code` and rewrites the
 *  message to append its troubleshooting URL. Reproduced from a production log
 *  line rather than invented, since both fixes key off it. */
const providerAuthError = () => ({
  lc_error_code: 'MODEL_AUTHENTICATION',
  message:
    '401 "Balance is insufficient"\n\nTroubleshooting URL: https://docs.langchain.com/oss/javascript/langchain/errors/MODEL_AUTHENTICATION/\n',
});

describe('isProviderAuthError', () => {
  test('recognises a provider credential or billing rejection', () => {
    expect(isProviderAuthError(providerAuthError())).toBe(true);
  });

  test.each([
    ['a different LangChain code', { lc_error_code: 'INVALID_PROMPT_INPUT' }],
    ['an untagged error', { message: 'socket hang up' }],
    ['undefined', undefined],
    ['null', null],
  ])('does not match %s', (_label, err) => {
    expect(isProviderAuthError(err)).toBe(false);
  });
});

describe('buildRunErrorText', () => {
  /**
   * The defect: the provider's message was appended verbatim, so an upstream
   * whose prepaid balance had run out told a user holding 42 million credits
   * "Balance is insufficient" — our own product's word for their allowance.
   */
  test('never repeats the provider wording for an auth failure', () => {
    const text = buildRunErrorText(providerAuthError());

    expect(text).not.toMatch(/balance/i);
    expect(text).not.toMatch(/401/);
    expect(JSON.parse(text)).toEqual({ code: 'provider_unavailable' });
  });

  /** A code the client can localize, like every other denial we surface. */
  test('emits a code the client renders rather than raw English', () => {
    expect(JSON.parse(buildRunErrorText(providerAuthError())).code).toBe('provider_unavailable');
  });

  /** Errors that really are about the user's request keep their detail —
   *  stripping it would trade one unhelpful message for another. */
  test('keeps the provider message for non-auth failures', () => {
    const text = buildRunErrorText({ message: 'prompt is too long' });

    expect(text).toBe('An error occurred while processing the request: prompt is too long');
  });

  test('reads sensibly with no message at all', () => {
    expect(buildRunErrorText({})).toBe('An error occurred while processing the request');
  });
});

describe('producedUsableOutput', () => {
  /** The billing decision. A turn holding only an error part produced nothing,
   *  so the provider never charged us and the user must not be charged. */
  test('an error-only turn produced nothing', () => {
    expect(producedUsableOutput([{ type: ContentTypes.ERROR }])).toBe(false);
  });

  test('an empty turn produced nothing', () => {
    expect(producedUsableOutput([])).toBe(false);
    expect(producedUsableOutput(undefined)).toBe(false);
  });

  /** Explicitly billable: the provider streamed real output and *then* failed,
   *  which consumed capacity we were charged for. */
  test('text followed by an error still counts as output', () => {
    expect(producedUsableOutput([{ type: ContentTypes.TEXT }, { type: ContentTypes.ERROR }])).toBe(
      true,
    );
  });

  test('a tool call counts as output', () => {
    expect(producedUsableOutput([{ type: ContentTypes.TOOL_CALL }])).toBe(true);
  });

  test('an ordinary successful turn counts as output', () => {
    expect(producedUsableOutput([{ type: ContentTypes.TEXT }])).toBe(true);
  });
});
