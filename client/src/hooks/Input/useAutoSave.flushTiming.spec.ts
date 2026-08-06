/**
 * Regression test for the "draft resurrected by an in-flight debounce" bug.
 *
 * `useAutoSave` debounces the composer's autosave writes. The debounced
 * callback used to close over the value captured AT EVENT-FIRE TIME. A
 * during-run steer/queue consumes the composer text and clears it
 * programmatically right after the user stops typing; if a debounced write
 * from before that clear is still in flight, it lands afterwards and
 * resurrects the just-sent text as a "draft" for the conversation.
 *
 * The fix (matching upstream) reads `textAreaRef.current.value` AT FLUSH
 * TIME instead of the value captured when the input event fired, so the
 * debounced write reflects whatever the composer holds when it actually
 * runs.
 *
 * `useAutoSave.spec.ts` mocks `setDraft`/`getDraft` entirely and never
 * exercises the debounced input-event path, so it cannot catch this class of
 * bug structurally. This test drives the real debounce with real timers and
 * a real DOM textarea to close that gap.
 */

jest.mock('recoil', () => ({
  ...jest.requireActual('recoil'),
  useRecoilValue: jest.fn(),
}));

jest.mock('~/store', () => ({
  saveDrafts: { key: 'saveDrafts', default: true },
}));

jest.mock('~/Providers', () => ({
  useChatFormContext: jest.fn(),
}));

jest.mock('~/data-provider', () => ({
  useGetFiles: jest.fn(),
}));

jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils'),
  getDraft: jest.fn(),
  setDraft: jest.fn(),
  clearDraft: jest.fn(),
  clearAllDrafts: jest.fn(),
}));

import { renderHook } from '@testing-library/react';
import { useRecoilValue } from 'recoil';
import { useChatFormContext } from '~/Providers';
import { useGetFiles } from '~/data-provider';
import { getDraft, setDraft } from '~/utils';
import store from '~/store';
import { useAutoSave } from '~/hooks';

const mockGetDraft = getDraft as jest.Mock;
const mockSetDraft = setDraft as jest.Mock;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  (useRecoilValue as jest.Mock).mockImplementation((atom) => {
    if (atom === store.saveDrafts) return true;
    return undefined;
  });
  (useChatFormContext as jest.Mock).mockReturnValue({ setValue: jest.fn() });
  (useGetFiles as jest.Mock).mockReturnValue({ data: [] });
  mockGetDraft.mockReturnValue('');
});

describe('useAutoSave — debounced draft write reflects value at flush time', () => {
  it('saves the composer value as of flush time, not as of when the input event fired', async () => {
    const textArea = document.createElement('textarea');
    const textAreaRef = { current: textArea };

    renderHook(() =>
      useAutoSave({
        conversationId: 'convo-1',
        textAreaRef,
        files: new Map(),
        setFiles: jest.fn(),
      }),
    );

    // User types "hello" - fires the fast (25ms) debounce.
    textArea.value = 'hello';
    textArea.dispatchEvent(new Event('input', { bubbles: true }));

    // Before the debounce flushes, a during-run steer/queue consumes the
    // text and clears the composer programmatically (as ChatForm's steer
    // submit path does), without firing another `input` event.
    textArea.value = '';

    await wait(50);

    expect(mockSetDraft).toHaveBeenCalledWith({ id: 'convo-1', value: '' });
    expect(mockSetDraft).not.toHaveBeenCalledWith({ id: 'convo-1', value: 'hello' });
  });
});
