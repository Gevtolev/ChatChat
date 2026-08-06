import React from 'react';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import type { TConversation } from 'librechat-data-provider';
import type { MutableSnapshot } from 'recoil';
import Root from '~/routes/Root';
import { mainTextareaId } from '~/common';
import store from '~/store';

/**
 * Confirms `useKeyboardShortcuts()` — mounted via `KeyboardShortcutsProvider` inside the real
 * `Root` component tree — actually takes effect once Root renders, and that mounting it doesn't
 * make the window-level dispatcher swallow ordinary typing. `useKeyboardShortcuts.spec.tsx`
 * already covers the dispatcher's internal logic in isolation; this covers the integration point
 * that was previously untested: Root never called the hook at all.
 */

jest.mock('copy-to-clipboard', () => ({
  __esModule: true,
  default: jest.fn(() => true),
}));

jest.mock('~/hooks/useNewConvo', () => ({
  __esModule: true,
  default: () => ({ newConversation: jest.fn() }),
}));

/**
 * Fully replaces `~/hooks` and `~/data-provider` (rather than spreading
 * `jest.requireActual`) because the two modules require each other — partial
 * mocking one while requiring the other's real implementation deadlocks on
 * that cycle. The fakes below cover every export Root and the real
 * `useKeyboardShortcuts` hook touch (`useHasAccess`, `useLocalize`,
 * `useArchiveConvoMutation`), so the dispatcher under test still runs for
 * real — only its data dependencies are stubbed.
 */
jest.mock('~/hooks', () => ({
  useAuthContext: () => ({
    user: { id: 'user-1', role: 'USER' },
    isAuthenticated: true,
    logout: jest.fn(),
  }),
  useAssistantsMap: () => ({}),
  useAgentsMap: () => ({}),
  useFileMap: () => ({}),
  useSearchEnabled: () => undefined,
  useLocalize: () => (key: string) => key,
  useHasAccess: () => false,
  useNewConvo: () => ({ newConversation: jest.fn() }),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: undefined }),
  useUserTermsQuery: () => ({ data: undefined }),
  useHealthCheck: () => undefined,
  useArchiveConvoMutation: () => ({ mutate: jest.fn(), isLoading: false }),
  useDeleteConversationMutation: () => ({ mutate: jest.fn(), isLoading: false }),
}));

jest.mock('~/Providers', () => ({
  PromptGroupsProvider: ({ children }: { children: React.ReactNode }) => children,
  AssistantsMapContext: { Provider: ({ children }: { children: React.ReactNode }) => children },
  AgentsMapContext: { Provider: ({ children }: { children: React.ReactNode }) => children },
  SetConvoProvider: ({ children }: { children: React.ReactNode }) => children,
  FileMapContext: { Provider: ({ children }: { children: React.ReactNode }) => children },
}));

jest.mock('~/components/Auth/GuestUpgradeModal', () => () => null);
jest.mock('~/components/UnifiedSidebar', () => ({
  UnifiedSidebar: () => <div data-testid="unified-sidebar" />,
}));
jest.mock('~/components/ui', () => ({
  TermsAndConditionsModal: () => null,
}));
jest.mock('~/components/Banners', () => ({
  Banner: () => null,
}));

function ChatArea() {
  return (
    <>
      <textarea data-testid="composer" id={mainTextareaId} />
      <input data-testid="text-field" />
    </>
  );
}

function SidebarProbe() {
  const sidebarExpanded = useRecoilValue(store.sidebarExpanded);
  return <output data-testid="sidebar-expanded">{String(sidebarExpanded)}</output>;
}

function renderRoot(route = '/', initialize?: (snapshot: MutableSnapshot) => void) {
  const queryClient = new QueryClient();
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <Root />,
        children: [
          { index: true, element: <ChatArea /> },
          { path: 'c/:conversationId', element: <ChatArea /> },
        ],
      },
    ],
    { initialEntries: [route] },
  );

  return render(
    <RecoilRoot initializeState={initialize}>
      <QueryClientProvider client={queryClient}>
        <SidebarProbe />
        <RouterProvider router={router} />
      </QueryClientProvider>
    </RecoilRoot>,
  );
}

function buildConversation(conversationId: string, title: string): TConversation {
  return { conversationId, title, endpoint: 'agents' } as TConversation;
}

function dispatchOn(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('Root — keyboard shortcuts mount', () => {
  it('renders the authenticated tree with the shortcut listener installed', () => {
    renderRoot();
    expect(screen.getByTestId('unified-sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-expanded')).toHaveTextContent('true');
  });

  it('fires a global shortcut dispatched from the real Root tree', () => {
    renderRoot();
    expect(screen.getByTestId('sidebar-expanded')).toHaveTextContent('true');

    dispatchOn(document.body, { key: 'S', ctrlKey: true, shiftKey: true });

    expect(screen.getByTestId('sidebar-expanded')).toHaveTextContent('false');
  });

  it('does not swallow ordinary typing in the composer', () => {
    renderRoot();
    const textarea = screen.getByTestId('composer');
    const event = dispatchOn(textarea, { key: 'a' });

    expect(event.defaultPrevented).toBe(false);
  });

  it('opens the real KeyboardShortcutsDialog on Ctrl+Shift+/ and pressing it again closes it', () => {
    renderRoot();
    expect(screen.queryByText('com_shortcut_keyboard_shortcuts')).not.toBeInTheDocument();

    dispatchOn(document.body, { key: '/', ctrlKey: true, shiftKey: true });
    expect(screen.getByText('com_shortcut_keyboard_shortcuts')).toBeInTheDocument();

    dispatchOn(document.body, { key: '/', ctrlKey: true, shiftKey: true });
    expect(screen.queryByText('com_shortcut_keyboard_shortcuts')).not.toBeInTheDocument();
  });

  it('gates other shortcuts while the dialog is open and restores them once it closes', () => {
    renderRoot();
    dispatchOn(document.body, { key: '/', ctrlKey: true, shiftKey: true });
    expect(screen.getByText('com_shortcut_keyboard_shortcuts')).toBeInTheDocument();

    dispatchOn(document.body, { key: 'S', ctrlKey: true, shiftKey: true });
    expect(screen.getByTestId('sidebar-expanded')).toHaveTextContent('true');

    dispatchOn(document.body, { key: '/', ctrlKey: true, shiftKey: true });
    expect(screen.queryByText('com_shortcut_keyboard_shortcuts')).not.toBeInTheDocument();

    dispatchOn(document.body, { key: 'S', ctrlKey: true, shiftKey: true });
    expect(screen.getByTestId('sidebar-expanded')).toHaveTextContent('false');
  });

  it('ignores a non-editing-allowed shortcut chord typed into a plain text field', () => {
    renderRoot();
    const input = screen.getByTestId('text-field');
    (input as HTMLInputElement).focus();

    const event = dispatchOn(input, { key: 'S', ctrlKey: true, shiftKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(screen.getByTestId('sidebar-expanded')).toHaveTextContent('true');
  });

  it('ignores a non-editing-allowed shortcut chord while the composer (the real mainTextareaId) is focused', () => {
    renderRoot();
    const textarea = screen.getByTestId('composer');
    (textarea as HTMLTextAreaElement).focus();

    dispatchOn(textarea, { key: 'S', ctrlKey: true, shiftKey: true });

    expect(screen.getByTestId('sidebar-expanded')).toHaveTextContent('true');
  });
});

describe('Root — keyboard delete dialog', () => {
  it('opens the real delete confirmation dialog on Ctrl+Shift+Backspace instead of leaving keyboardDeleteTarget unconsumed', () => {
    const conversation = buildConversation('convo-1', 'My Chat');
    renderRoot('/c/convo-1', (snapshot) => {
      snapshot.set(store.conversationByIndex(0), conversation);
    });

    expect(screen.queryByText('com_ui_delete_conversation')).not.toBeInTheDocument();

    dispatchOn(document.body, { key: 'Backspace', ctrlKey: true, shiftKey: true });

    expect(screen.getByText('com_ui_delete_conversation')).toBeInTheDocument();
  });

  it('clears keyboardDeleteTarget and closes the dialog on cancel', () => {
    const conversation = buildConversation('convo-1', 'My Chat');
    renderRoot('/c/convo-1', (snapshot) => {
      snapshot.set(store.conversationByIndex(0), conversation);
    });

    dispatchOn(document.body, { key: 'Backspace', ctrlKey: true, shiftKey: true });
    expect(screen.getByText('com_ui_delete_conversation')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));

    expect(screen.queryByText('com_ui_delete_conversation')).not.toBeInTheDocument();
  });
});
