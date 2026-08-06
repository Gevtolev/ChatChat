/**
 * Root-cause regression test for the "recovered queued message disappears
 * instead of returning to a chip" bug.
 *
 * `useSteering.ts`'s `sendQueuedNow` (a recovered/queued send) forwards
 * `clientRequestId` / `recoverySteerId` / `expectedPredecessorCreatedAt` /
 * `queuedMessageOrigin` all the way down to `ask()` via `sendNow` ->
 * `submitMessage`. `ask()` is where the `TSubmission` object actually gets
 * built and handed to `setSubmission` - and until this fix it silently
 * dropped all four fields.
 *
 * That omission is the entire root cause of the disappearing-text bug:
 * `client/src/hooks/SSE/useResumableSSE.ts` already has fully-implemented,
 * already-tested consumption logic for these fields (see e.g.
 * `useResumableSSE.spec.ts`'s "re-queues a released recovery source after an
 * ambiguous start failure", which constructs its `TSubmission` fixture by
 * hand). But that consumption logic reads `submission.recoverySteerId`
 * (via `getRecoverySteerId`) and `submission.queuedMessageOrigin` off the
 * REAL submission that `ask()` produces - so as long as `ask()` drops them,
 * every one of those already-correct branches is unreachable dead code in
 * production, and a failed resend of a recovered message just vanishes
 * instead of returning to the composer as a chip.
 */
import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { RecoilRoot } from 'recoil';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TConversation, TMessage, TSubmission } from 'librechat-data-provider';
import useChatFunctions from '../useChatFunctions';

jest.mock('react-router-dom', () => ({
  useNavigate: () => jest.fn(),
}));

jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: { id: 'user-1' } }),
}));

jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider'),
  useGetEndpointsQuery: () => ({ data: {} }),
}));

jest.mock('librechat-data-provider/react-query', () => ({
  ...jest.requireActual('librechat-data-provider/react-query'),
  useUserKeyQuery: () => ({ data: undefined }),
  useUpdateUserKeysMutation: () => ({ mutate: jest.fn() }),
}));

const CONVO_ID = 'convo-recovery-1';

const conversation: TConversation = {
  conversationId: CONVO_ID,
  endpoint: EModelEndpoint.agents,
  endpointType: EModelEndpoint.agents,
} as TConversation;

function setup() {
  const setSubmission = jest.fn();
  const setMessages = jest.fn();
  const getMessages = jest.fn(() => [] as TMessage[]);
  const queryClient = new QueryClient();

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>{children}</RecoilRoot>
    </QueryClientProvider>
  );

  const { result } = renderHook(
    () =>
      useChatFunctions({
        index: 0,
        conversation,
        latestMessage: null,
        getMessages,
        setMessages,
        isSubmitting: false,
        setSubmission,
      }),
    { wrapper },
  );

  return { result, setSubmission };
}

describe('useChatFunctions ask() - recovery/queue override propagation', () => {
  it('carries clientRequestId, recoverySteerId, expectedPredecessorCreatedAt, and queuedMessageOrigin onto the submission', () => {
    const { result, setSubmission } = setup();
    const queuedMessageOrigin = {
      item: { id: 'queued-1', text: 'recovered text', createdAt: 1 },
      beforeIds: [],
      afterIds: [],
    };

    act(() => {
      result.current.ask(
        { text: 'recovered text' },
        {
          overrideClientRequestId: 'client-request-1',
          overrideRecoverySteerId: 'source-steer-1',
          overrideExpectedPredecessorCreatedAt: 1234,
          overrideQueuedMessageOrigin: queuedMessageOrigin,
        },
      );
    });

    expect(setSubmission).toHaveBeenCalledTimes(1);
    const submission = setSubmission.mock.calls[0][0] as TSubmission;
    expect(submission.clientRequestId).toBe('client-request-1');
    expect(submission.recoverySteerId).toBe('source-steer-1');
    expect(submission.expectedPredecessorCreatedAt).toBe(1234);
    expect(submission.queuedMessageOrigin).toBe(queuedMessageOrigin);
  });

  it('generates a fresh clientRequestId per ask() call when none is provided', () => {
    const { result, setSubmission } = setup();

    act(() => {
      result.current.ask({ text: 'hello' });
    });

    expect(setSubmission).toHaveBeenCalledTimes(1);
    const submission = setSubmission.mock.calls[0][0] as TSubmission;
    expect(typeof submission.clientRequestId).toBe('string');
    expect(submission.clientRequestId?.length).toBeGreaterThan(0);
    expect(submission.recoverySteerId).toBeUndefined();
    expect(submission.expectedPredecessorCreatedAt).toBeUndefined();
    expect(submission.queuedMessageOrigin).toBeUndefined();
  });
});
