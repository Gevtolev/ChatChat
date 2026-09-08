import { useLocalize } from '~/hooks';
import { TStartupConfig } from 'librechat-data-provider';

function Footer({ startupConfig }: { startupConfig: TStartupConfig | null | undefined }) {
  const localize = useLocalize();
  if (!startupConfig) {
    return null;
  }
  /**
   * Falls back to the pages this fork ships rather than rendering nothing.
   * Upstream shows these links only when `interface.privacyPolicy.externalUrl`
   * is configured, and that config lives in a `librechat.yaml` outside git — so
   * whether a visitor can find the terms before signing up depended on a file
   * nobody was checking. `/terms` and `/privacy` are routes that always exist
   * here, so there is no reason for the link not to.
   */
  const privacyHref = startupConfig.interface?.privacyPolicy?.externalUrl ?? '/privacy';
  const termsHref = startupConfig.interface?.termsOfService?.externalUrl ?? '/terms';

  const privacyPolicyRender = (
    <a
      className="text-sm text-green-600 underline decoration-transparent transition-all duration-200 hover:text-green-700 hover:decoration-green-700 focus:text-green-700 focus:decoration-green-700 dark:text-green-500 dark:hover:text-green-400 dark:hover:decoration-green-400 dark:focus:text-green-400 dark:focus:decoration-green-400"
      href={privacyHref}
      rel="noreferrer"
    >
      {localize('com_ui_privacy_policy')}
    </a>
  );

  const termsOfServiceRender = (
    <a
      className="text-sm text-green-600 underline decoration-transparent transition-all duration-200 hover:text-green-700 hover:decoration-green-700 focus:text-green-700 focus:decoration-green-700 dark:text-green-500 dark:hover:text-green-400 dark:hover:decoration-green-400 dark:focus:text-green-400 dark:focus:decoration-green-400"
      href={termsHref}
      rel="noreferrer"
    >
      {localize('com_ui_terms_of_service')}
    </a>
  );

  return (
    <div className="align-end m-4 flex justify-center gap-2" role="contentinfo">
      {privacyPolicyRender}
      <div className="border-r-[1px] border-gray-300 dark:border-gray-600" />
      {termsOfServiceRender}
    </div>
  );
}

export default Footer;
