/**
 * Regression coverage for the during-run Enter path: `useTextarea`'s
 * `handleKeyDown` never submits the form itself — its ONLY path to a submit
 * is `submitButtonRef.current?.click()`. Whether that click reaches the
 * form's `onSubmit` depends entirely on what `ChatForm.tsx` has the ref
 * pointed at: a real, enabled `type="submit"` button lets the click through;
 * a `null` ref (no button mounted) or a `disabled` button silently swallows
 * it (native HTML: `HTMLElement.click()` on a disabled form control fires no
 * event and never submits the form). `shortcuts.spec.ts` already proves
 * `resolveComposerKeyDown` returns `'submit'` in this state; this file proves
 * the DOM side actually delivers that verdict to the form.
 */
jest.mock('~/Providers/AssistantsMapContext', () => ({
  useAssistantsMapContext: () => ({}),
}));
jest.mock('~/Providers/AgentsMapContext', () => ({
  useAgentsMapContext: () => ({}),
}));
jest.mock('~/hooks/Conversations/useGetSender', () => () => () => 'Assistant');
jest.mock('~/hooks/Files/useFileHandling', () => () => ({ handleFiles: jest.fn() }));
jest.mock('~/data-provider', () => ({
  useInteractionHealthCheck: () => jest.fn(),
}));
jest.mock('~/hooks/Messages/useLatestMessage', () => ({
  useLatestMessage: () => null,
}));
jest.mock('~/hooks/Input/useComposerBindings', () => ({
  __esModule: true,
  default: () => ({ submitOverride: undefined, yieldedChords: new Set() }),
}));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));
/**
 * Renders the hovercard eagerly, same rationale as `DuringRunSendButton.test.tsx`:
 * Ariakit's real show path depends on pointer geometry, which jsdom reports as
 * zeros. This test only needs the primary button (ref/type/disabled), not the
 * hovercard's open/close behavior.
 */
jest.mock('@ariakit/react', () => ({
  HovercardProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  HovercardAnchor: ({ render }: { render: React.ReactElement }) => render,
  Hovercard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const mockChatContext = {
  index: 0,
  conversation: null as unknown,
  isSubmitting: true,
  setFilesLoading: jest.fn(),
};
jest.mock('~/Providers/ChatContext', () => ({
  useChatContext: () => mockChatContext,
}));

import React, { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { RecoilRoot } from 'recoil';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { SteeringControls } from '~/hooks/Chat/useSteering';
import DuringRunSendButton from '~/components/Chat/Input/DuringRunSendButton';
import useTextarea from '../useTextarea';
import store from '~/store';

const renderWithRecoil = (ui: React.ReactElement) =>
  render(
    <RecoilRoot
      initializeState={({ set }) => {
        set(store.enterToSend, true);
        set(store.customShortcuts, {});
      }}
    >
      {ui}
    </RecoilRoot>,
  );

const TEXT = 'stop, do not run that command';

const mockSubmitDuringRun = jest.fn();

const steeringStub = {
  effectiveAction: 'steer',
  canSteer: true,
  canControlGeneration: true,
  pausedOnApproval: false,
  duringRunActive: true,
  submitDuringRun: mockSubmitDuringRun,
  steerFromComposer: jest.fn(() => true),
  queueFromComposer: jest.fn(() => true),
  interruptSteer: jest.fn(() => true),
  interruptAndSend: jest.fn(() => true),
} as unknown as SteeringControls;

/**
 * Mirrors `ChatForm.tsx`'s actual wiring: one `submitButtonRef`, one `<form
 * onSubmit>` that routes to `steering.submitDuringRun` while a run is
 * generating (matching the `onSubmit` branch added to `ChatForm.tsx`), and a
 * button slot whose content is the thing under test.
 */
function Harness({
  slot,
}: {
  slot: 'enabled-submit' | 'disabled-submit' | 'none' | 'during-run-send-button';
}) {
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const [, setIsScrollable] = useState(false);
  const methods = useForm<{ text: string }>({ defaultValues: { text: TEXT } });
  const { handleKeyDown } = useTextarea({
    textAreaRef,
    submitButtonRef,
    setIsScrollable,
    allowSubmitWhileGenerating: true,
    onDuringRunModifier: undefined,
  });

  return (
    <form
      onSubmit={methods.handleSubmit((data) => {
        if (steeringStub.duringRunActive) {
          steeringStub.submitDuringRun(data.text);
        }
      })}
    >
      <textarea
        ref={(el) => {
          methods.register('text').ref(el);
          (textAreaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
        }}
        defaultValue={TEXT}
        onKeyDown={handleKeyDown}
      />
      {slot === 'enabled-submit' && (
        // eslint-disable-next-line i18next/no-literal-string
        <button ref={submitButtonRef} type="submit">
          send
        </button>
      )}
      {slot === 'disabled-submit' && (
        // eslint-disable-next-line i18next/no-literal-string
        <button ref={submitButtonRef} type="submit" disabled>
          send
        </button>
      )}
      {slot === 'during-run-send-button' && (
        <DuringRunSendButton
          ref={submitButtonRef}
          control={methods.control}
          steering={steeringStub}
          getText={() => methods.getValues('text')}
          onConsumed={() => methods.reset()}
        />
      )}
      {/* slot === 'none': StopButton-equivalent, submitButtonRef stays null */}
    </form>
  );
}

const pressEnter = () => {
  const textarea = screen.getByRole('textbox');
  fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useTextarea — during-run Enter reaches the form only through a live submit button', () => {
  it('regression: a null submitButtonRef (Stop button mounted, no text) swallows Enter — nothing submits', async () => {
    renderWithRecoil(<Harness slot="none" />);

    pressEnter();

    // Give react-hook-form's async validation a chance to run before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockSubmitDuringRun).not.toHaveBeenCalled();
  });

  it('regression: a disabled submit button (plain SendButton mid-run) swallows Enter — .click() on disabled controls fires nothing', async () => {
    renderWithRecoil(<Harness slot="disabled-submit" />);

    pressEnter();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockSubmitDuringRun).not.toHaveBeenCalled();
  });

  it('sanity: a plain enabled submit button does receive the synthetic click and submits', async () => {
    renderWithRecoil(<Harness slot="enabled-submit" />);

    pressEnter();

    await waitFor(() => expect(mockSubmitDuringRun).toHaveBeenCalledWith(TEXT));
  });

  it('fix: DuringRunSendButton (the real ChatForm wiring) receives the synthetic click and dispatches submitDuringRun', async () => {
    renderWithRecoil(<Harness slot="during-run-send-button" />);

    pressEnter();

    await waitFor(() => expect(mockSubmitDuringRun).toHaveBeenCalledWith(TEXT));
  });
});
