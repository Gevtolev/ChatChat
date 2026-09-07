import React from 'react';
import { render, screen } from '@testing-library/react';
import AllowanceMeter from '../AllowanceMeter';

let mockEntitlements: unknown;

jest.mock('~/data-provider', () => ({
  useGetEntitlements: () => ({ data: mockEntitlements }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, options?: Record<string, unknown>) =>
    options ? `${key}:${Object.values(options).join('/')}` : key,
}));

const entitlements = (remaining: number, granted: number) => ({
  plan: { code: 'plus', name: 'Plus', allowedCostTiers: [], features: {} },
  credits: { remaining, granted, displayDivisor: 14.95 },
  periodEnd: null,
});

describe('AllowanceMeter', () => {
  beforeEach(() => {
    mockEntitlements = undefined;
  });

  it('shows the plan name and remaining credits in display units', () => {
    mockEntitlements = entitlements(7_475_000, 14_950_000);
    render(<AllowanceMeter />);

    expect(screen.getByText('Plus')).toBeInTheDocument();
    /** 7,475,000 / 14.95 = 500,000 — the number the user was sold, not the
     *  micro-dollar cost figure underneath it. */
    expect(screen.getByText('500,000')).toBeInTheDocument();
  });

  it('reports both numbers to assistive technology, not just the numerator', () => {
    mockEntitlements = entitlements(7_475_000, 14_950_000);
    render(<AllowanceMeter />);

    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '500000');
    expect(bar).toHaveAttribute('aria-valuemax', '1000000');
    expect(bar.getAttribute('aria-label')).toContain('500,000/1,000,000');
  });

  /** Each of these would otherwise render a zeroed meter, which reads as a
   *  spent allowance — the opposite of the truth in the first two cases. */
  it('renders nothing while entitlements are still loading', () => {
    mockEntitlements = undefined;
    const { container } = render(<AllowanceMeter />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a plan not metered by credits', () => {
    mockEntitlements = { plan: { code: 'anonymous', name: 'Anonymous' }, credits: null };
    const { container } = render(<AllowanceMeter />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the plan granted no credits', () => {
    mockEntitlements = entitlements(0, 0);
    const { container } = render(<AllowanceMeter />);
    expect(container).toBeEmptyDOMElement();
  });

  it('clamps an overspent balance to an empty bar rather than a negative one', () => {
    mockEntitlements = entitlements(-1_000, 14_950_000);
    render(<AllowanceMeter />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });
});
