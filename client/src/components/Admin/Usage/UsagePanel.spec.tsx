import React from 'react';
import { render, screen } from '@testing-library/react';
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
