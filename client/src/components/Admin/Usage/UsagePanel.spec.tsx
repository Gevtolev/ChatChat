import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { RecoilRoot } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SystemRoles } from 'librechat-data-provider';
import UsagePanel from './UsagePanel';

const mockUseAdminUsageQuery = jest.fn();
const mockUseAuthContext = jest.fn();

jest.mock('~/data-provider', () => ({
  useAdminUsageQuery: (...args: unknown[]) => mockUseAdminUsageQuery(...args),
}));

jest.mock('~/hooks', () => ({
  useAuthContext: () => mockUseAuthContext(),
  useLocalize: () => (key: string) => key,
}));

interface MockVirtualItem {
  key: number;
  index: number;
  start: number;
  end: number;
  size: number;
}

/**
 * jsdom performs no layout, so the real @tanstack/react-virtual always
 * measures a zero-size viewport and renders no rows regardless of `count`.
 * UserMarginTable's DataTable depends on it — so this suite needs a mock,
 * scoped to this file only, to have real row content to assert against.
 *
 * `packages/client` carries its own nested copy of @tanstack/react-virtual
 * (see packages/client/node_modules/@tanstack/react-virtual) rather than
 * resolving to the workspace-root one this test file would otherwise mock,
 * so the module name is resolved relative to @librechat/client itself
 * rather than passed as the bare specifier.
 */
jest.mock(
  require.resolve('@tanstack/react-virtual', {
    paths: [require.resolve('@librechat/client')],
  }),
  () => ({
    useVirtualizer: ({
      count,
      estimateSize,
    }: {
      count: number;
      estimateSize: (index: number) => number;
    }) => {
      const items: MockVirtualItem[] = [];
      let offset = 0;
      for (let index = 0; index < count; index += 1) {
        const size = estimateSize(index);
        items.push({ key: index, index, start: offset, end: offset + size, size });
        offset += size;
      }
      return {
        getVirtualItems: () => items,
        getTotalSize: () => offset,
      };
    },
  }),
);

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <RecoilRoot>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <UsagePanel />
        </MemoryRouter>
      </QueryClientProvider>
    </RecoilRoot>,
  );
}

beforeEach(() => {
  mockUseAuthContext.mockReturnValue({ user: { role: SystemRoles.ADMIN } });
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('UsagePanel', () => {
  it('renders a loading state while the query is in flight', () => {
    mockUseAdminUsageQuery.mockReturnValue({ isLoading: true, data: undefined, error: null });
    renderPanel();
    expect(screen.queryByText('com_ui_admin_usage_error')).not.toBeInTheDocument();
    expect(screen.getByText('com_ui_admin_usage_title')).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders the three sections on success', () => {
    mockUseAdminUsageQuery.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        from: '2026-08-01T00:00:00Z',
        to: '2026-08-31T00:00:00Z',
        users: [
          {
            user_id: 'u1',
            email: 'a@example.com',
            plan_code: 'pro_m',
            plan_recognized: true,
            cost_credits: 1_000_000,
            revenue_credits: 29_990_000,
            margin_credits: 28_990_000,
            calls: 4,
            model_count: 2,
          },
        ],
        models: [
          {
            model: 'glm-5.2',
            context: 'message',
            cost_credits: 1_000_000,
            calls: 4,
            input_tokens: 100,
            write_tokens: 0,
            read_tokens: 20,
          },
        ],
        days: [
          { day: '2026-08-10', cost_credits: 600_000 },
          { day: '2026-08-11', cost_credits: 400_000 },
        ],
      },
    });
    renderPanel();
    expect(screen.getByText('com_ui_admin_usage_by_user')).toBeInTheDocument();
    expect(screen.getByText('com_ui_admin_usage_breakdown')).toBeInTheDocument();
    expect(screen.getByText('com_ui_admin_usage_trend')).toBeInTheDocument();
    expect(screen.getByText('a@example.com')).toBeInTheDocument();
  });

  it('suppresses revenue and margin outside the 30-day preset', () => {
    mockUseAdminUsageQuery.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        from: '2026-08-01T00:00:00Z',
        to: '2026-08-31T00:00:00Z',
        users: [
          {
            user_id: 'u1',
            email: 'a@example.com',
            plan_code: 'pro_m',
            plan_recognized: true,
            cost_credits: 1_000_000,
            revenue_credits: 29_990_000,
            margin_credits: 28_990_000,
            calls: 4,
            model_count: 2,
          },
        ],
        models: [],
        days: [],
      },
    });
    renderPanel();
    /** Default preset is the 30-day range: revenue/margin are shown. */
    expect(screen.getByText('com_ui_admin_usage_revenue')).toBeInTheDocument();
    expect(screen.getByText('com_ui_admin_usage_margin')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_admin_usage_margin_unavailable')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('com_ui_admin_usage_range_month'));

    expect(screen.queryByText('com_ui_admin_usage_revenue')).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_admin_usage_margin')).not.toBeInTheDocument();
    expect(screen.getByText('com_ui_admin_usage_margin_unavailable')).toBeInTheDocument();
  });

  it('renders an error message when the query fails', () => {
    mockUseAdminUsageQuery.mockReturnValue({
      isLoading: false,
      data: undefined,
      error: new Error('boom'),
    });
    renderPanel();
    expect(screen.getByText('com_ui_admin_usage_error')).toBeInTheDocument();
  });

  it('renders an empty state rather than a spinner when there is no traffic', () => {
    mockUseAdminUsageQuery.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        from: '2026-08-01T00:00:00Z',
        to: '2026-08-31T00:00:00Z',
        users: [],
        models: [],
        days: [],
      },
    });
    renderPanel();
    expect(screen.getAllByText('com_ui_admin_usage_empty').length).toBeGreaterThan(0);
  });

  it('refuses to render data for a non-admin and never issues the query', () => {
    mockUseAuthContext.mockReturnValue({ user: { role: SystemRoles.USER } });
    mockUseAdminUsageQuery.mockReturnValue({ isLoading: false, data: undefined, error: null });
    renderPanel();
    expect(screen.getByText('com_ui_admin_usage_forbidden')).toBeInTheDocument();
    /** The real guard is server-side, but the query must not fire either. */
    expect(mockUseAdminUsageQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );
  });
});
