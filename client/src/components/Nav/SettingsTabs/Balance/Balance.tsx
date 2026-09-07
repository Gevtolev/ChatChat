import React from 'react';
import { useGetEntitlements, useGetUserBalance } from '~/data-provider';
import { useAuthContext, useLocalize } from '~/hooks';
import { toDisplayCredits, formatDisplayCredits, allowanceFraction } from '~/utils/credits';
import AutoRefillSettings from './AutoRefillSettings';

/**
 * The plan and what is left of its allowance.
 *
 * Reads entitlements rather than the raw balance. The balance alone is a cost
 * figure in micro-dollars — `14950000` — which means nothing without the plan's
 * grant to scale it against, and the previous version rendered exactly that
 * with `toFixed(2)`.
 *
 * Upstream's auto-refill block is kept, but only when upstream's balance system
 * is actually running. We leave it off: renewal here rides on
 * `refreshMonthlyGrant`, called by the gate on the user's next request, so the
 * refill fields are absent and the block would render an empty promise.
 */
function Balance() {
  const localize = useLocalize();
  const { isAuthenticated } = useAuthContext();

  const { data: entitlements } = useGetEntitlements({ enabled: isAuthenticated });
  const balanceQuery = useGetUserBalance({ enabled: isAuthenticated });

  const {
    autoRefillEnabled = false,
    lastRefill,
    refillAmount,
    refillIntervalUnit,
    refillIntervalValue,
  } = balanceQuery.data ?? {};

  const hasValidRefillSettings =
    lastRefill !== undefined &&
    refillAmount !== undefined &&
    refillIntervalUnit !== undefined &&
    refillIntervalValue !== undefined;

  /**
   * Not cosmetic, whatever the upstream wording suggests: `refreshMonthlyGrant`
   * only renews balances it finds with `autoRefillEnabled: true`, so an account
   * without that flag never gets its allowance back — and would otherwise learn
   * that a month later with nothing on screen having warned it.
   *
   * Built ahead of the JSX rather than nested inline: three outcomes off two
   * booleans reads as a nested ternary, which CI rejects outright (it runs
   * ESLint with `--max-warnings=0`).
   */
  let renewal: React.ReactNode = (
    <div className="text-sm text-text-secondary">
      {localize('com_nav_balance_auto_refill_disabled')}
    </div>
  );
  if (autoRefillEnabled && hasValidRefillSettings) {
    renewal = (
      <AutoRefillSettings
        lastRefill={lastRefill}
        refillAmount={refillAmount}
        refillIntervalUnit={refillIntervalUnit}
        refillIntervalValue={refillIntervalValue}
      />
    );
  } else if (autoRefillEnabled) {
    renewal = (
      <div className="text-sm text-red-600">{localize('com_nav_balance_auto_refill_error')}</div>
    );
  }

  const credits = entitlements?.credits ?? null;
  const remaining = credits ? toDisplayCredits(credits.remaining, credits.displayDivisor) : 0;
  const granted = credits ? toDisplayCredits(credits.granted, credits.displayDivisor) : 0;
  const fraction = credits ? allowanceFraction(credits.remaining, credits.granted) : null;

  return (
    <div className="flex flex-col gap-4 p-4 text-sm text-text-primary">
      <div className="flex items-center justify-between">
        <span className="font-light">{localize('com_nav_setting_plan')}</span>
        <span className="font-medium" role="note">
          {entitlements?.plan.name ?? '—'}
        </span>
      </div>

      {credits ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="font-light">{localize('com_nav_balance')}</span>
            <span className="font-medium" role="note">
              {localize('com_ui_credits_remaining_of', {
                0: formatDisplayCredits(remaining),
                1: formatDisplayCredits(granted),
              })}
            </span>
          </div>
          {fraction !== null && (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-surface-tertiary"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={granted}
              aria-valuenow={remaining}
              aria-label={localize('com_nav_balance')}
            >
              <div
                className="h-full rounded-full bg-text-primary transition-[width]"
                style={{ width: `${fraction * 100}%` }}
              />
            </div>
          )}
        </div>
      ) : (
        /** Plans that grant no credits are capped another way — anonymous by
         *  message count — so an allowance row would be a zero that means
         *  nothing rather than an empty one. */
        <div className="flex items-center justify-between">
          <span className="font-light">{localize('com_nav_balance')}</span>
          <span className="text-text-secondary" role="note">
            {localize('com_ui_credits_not_metered')}
          </span>
        </div>
      )}

      {entitlements?.periodEnd != null && credits && (
        <div className="flex items-center justify-between">
          <span className="font-light">{localize('com_ui_credits_resets_on')}</span>
          <span className="text-text-secondary" role="note">
            {new Date(entitlements.periodEnd).toLocaleDateString()}
          </span>
        </div>
      )}

      {renewal}
    </div>
  );
}

export default React.memo(Balance);
