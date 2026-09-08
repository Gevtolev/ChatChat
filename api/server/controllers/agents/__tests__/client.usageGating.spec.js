const AgentClient = require('../client');
const { producedUsableOutput } = require('@librechat/api');
const { ContentTypes } = require('librechat-data-provider');

/** Minimal `this` — the method reads one field and logs. */
const decide = (state) => AgentClient.prototype.shouldRecordUsage.call(state, state.wasAborted);

describe('AgentClient.shouldRecordUsage', () => {
  test('bills an ordinary completed turn', () => {
    expect(decide({ failedWithoutOutput: false })).toBe(true);
  });

  /** `abortMiddleware` bills the partial turn itself; doing it here too would
   *  charge the user twice for one stop. */
  test('leaves an aborted turn to the abort middleware', () => {
    expect(decide({ wasAborted: true, failedWithoutOutput: false })).toBe(false);
  });

  /**
   * The defect this exists for. An upstream whose prepaid balance had run out
   * returned 401 twice in twelve seconds, and both turns were billed in full —
   * 69,257 credits for two requests the provider never processed and we were
   * never charged for.
   */
  test('does not bill a turn the provider rejected outright', () => {
    expect(decide({ failedWithoutOutput: true })).toBe(false);
  });

  /** Explicitly billable, per the product rule: output that reached the user
   *  consumed capacity we pay for, however the turn ended. */
  test('bills a turn that produced output before failing', () => {
    expect(decide({ failedWithoutOutput: false })).toBe(true);
  });

  /** A fresh client has never set the field; absent must not read as "failed". */
  test('bills when the flag was never set', () => {
    expect(decide({})).toBe(true);
  });
});

/**
 * The two halves have to agree, and they are wired a file apart: the catch
 * block in `chatCompletion` sets `failedWithoutOutput` from
 * `producedUsableOutput(this.contentParts)`, and `shouldRecordUsage` reads it.
 * Testing each alone would pass even if the sense of the flag were inverted.
 */
describe('the flag the catch block sets drives the billing decision', () => {
  const decideForParts = (parts) => decide({ failedWithoutOutput: !producedUsableOutput(parts) });

  test('a provider rejection with only an error part is not billed', () => {
    expect(decideForParts([{ type: ContentTypes.ERROR }])).toBe(false);
  });

  test('a stream that produced text and then failed is billed', () => {
    expect(decideForParts([{ type: ContentTypes.TEXT }, { type: ContentTypes.ERROR }])).toBe(true);
  });

  test('a turn that made a tool call before failing is billed', () => {
    expect(decideForParts([{ type: ContentTypes.TOOL_CALL }, { type: ContentTypes.ERROR }])).toBe(
      true,
    );
  });
});
