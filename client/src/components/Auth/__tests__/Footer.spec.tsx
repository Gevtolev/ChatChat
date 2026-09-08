import React from 'react';
import { render, screen } from '@testing-library/react';
import type { TStartupConfig } from 'librechat-data-provider';
import Footer from '../Footer';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const config = (iface?: TStartupConfig['interface']) =>
  ({ interface: iface }) as unknown as TStartupConfig;

describe('Auth Footer legal links', () => {
  /**
   * Upstream renders these only when `interface.privacyPolicy.externalUrl` is
   * set, and that config lives in a `librechat.yaml` outside git. Production had
   * no `interface.privacyPolicy` block at all, so the sign-in page showed no
   * link to either document — on a product about to open public signups.
   */
  it('links to the bundled pages when no external URL is configured', () => {
    render(<Footer startupConfig={config(undefined)} />);

    expect(screen.getByText('com_ui_privacy_policy')).toHaveAttribute('href', '/privacy');
    expect(screen.getByText('com_ui_terms_of_service')).toHaveAttribute('href', '/terms');
  });

  /** A deployment that hosts its own documents elsewhere still wins. */
  it('prefers a configured external URL', () => {
    render(
      <Footer
        startupConfig={config({
          privacyPolicy: { externalUrl: 'https://example.com/p' },
          termsOfService: { externalUrl: 'https://example.com/t' },
        } as TStartupConfig['interface'])}
      />,
    );

    expect(screen.getByText('com_ui_privacy_policy')).toHaveAttribute(
      'href',
      'https://example.com/p',
    );
    expect(screen.getByText('com_ui_terms_of_service')).toHaveAttribute(
      'href',
      'https://example.com/t',
    );
  });

  /** Falls back per link, not all-or-nothing. */
  it('mixes a configured privacy URL with the bundled terms', () => {
    render(
      <Footer
        startupConfig={config({
          privacyPolicy: { externalUrl: 'https://example.com/p' },
        } as TStartupConfig['interface'])}
      />,
    );

    expect(screen.getByText('com_ui_privacy_policy')).toHaveAttribute(
      'href',
      'https://example.com/p',
    );
    expect(screen.getByText('com_ui_terms_of_service')).toHaveAttribute('href', '/terms');
  });

  it('renders nothing before the startup config arrives', () => {
    const { container } = render(<Footer startupConfig={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});
