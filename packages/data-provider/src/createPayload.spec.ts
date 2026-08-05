import { EModelEndpoint } from './schemas';
import createPayload from './createPayload';
import type * as t from './types';

function buildSubmission(overrides: Partial<t.TSubmission> = {}): t.TSubmission {
  const userMessage: t.TMessage = {
    messageId: 'user-message-1',
    conversationId: 'convo-1',
    parentMessageId: null,
    text: 'hello',
    isCreatedByUser: true,
  };

  return {
    userMessage,
    isTemporary: false,
    messages: [],
    conversation: { conversationId: 'convo-1', endpoint: EModelEndpoint.agents },
    endpointOption: { endpoint: EModelEndpoint.agents } as t.TEndpointOption,
    ...overrides,
  };
}

describe('createPayload', () => {
  it('forwards clientRequestId, recoverySteerId, and expectedPredecessorCreatedAt onto the payload', () => {
    const submission = buildSubmission({
      clientRequestId: 'client-request-1',
      recoverySteerId: 'source-steer-1',
      expectedPredecessorCreatedAt: 1234,
    });

    const { payload } = createPayload(submission);

    expect(payload.clientRequestId).toBe('client-request-1');
    expect(payload.recoverySteerId).toBe('source-steer-1');
    expect(payload.expectedPredecessorCreatedAt).toBe(1234);
  });

  it('leaves the three fields undefined when the submission does not carry them', () => {
    const submission = buildSubmission();

    const { payload } = createPayload(submission);

    expect(payload.clientRequestId).toBeUndefined();
    expect(payload.recoverySteerId).toBeUndefined();
    expect(payload.expectedPredecessorCreatedAt).toBeUndefined();
  });

  it('does not forward the client-only queuedMessageOrigin field', () => {
    const submission = buildSubmission({
      queuedMessageOrigin: { item: { id: 'queued-1' }, beforeIds: [], afterIds: [] },
    });

    const { payload } = createPayload(submission);

    expect(payload).not.toHaveProperty('queuedMessageOrigin');
  });
});
