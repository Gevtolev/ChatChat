import { memo } from 'react';
import { useGetEntitlements } from '~/data-provider';
import { useLocalize } from '~/hooks';
import { toDisplayCredits, formatDisplayCredits, allowanceFraction } from '~/utils/credits';

/**
 * Plan and remaining allowance, parked above the account button.
 *
 * The Settings tab alone was not enough: running out of credits is the one
 * billing event a user needs to see coming, and nobody opens Settings to check
 * for something they do not yet know is happening. Here it is passively in
 * view during the sessions that spend it.
 *
 * Renders nothing rather than a placeholder in three cases — entitlements still
 * loading, the query failed, or the plan is not metered by credits (anonymous,
 * capped by message count instead). A meter that reads zero because the data
 * has not arrived is worse than no meter, since it is indistinguishable from a
 * spent allowance.
 */
function AllowanceMeter() {
  const localize = useLocalize();
  const { data: entitlements } = useGetEntitlements();

  const credits = entitlements?.credits;
  if (!credits) {
    return null;
  }

  const remaining = toDisplayCredits(credits.remaining, credits.displayDivisor);
  const granted = toDisplayCredits(credits.granted, credits.displayDivisor);
  const fraction = allowanceFraction(credits.remaining, credits.granted);
  if (fraction === null) {
    return null;
  }

  /** Under a tenth left is where the number stops being ambient information and
   *  starts being something to act on. */
  const isLow = fraction < 0.1;

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate text-text-secondary">{entitlements?.plan.name}</span>
        <span className={isLow ? 'font-medium text-text-primary' : 'text-text-tertiary'}>
          {formatDisplayCredits(remaining)}
        </span>
      </div>
      <div
        className="h-1 w-full overflow-hidden rounded-full bg-surface-tertiary"
        role="progressbar"
        aria-valuemin={0}
        /** A top-up puts the remaining balance above the monthly grant, and a
         *  `valuenow` past `valuemax` is an invalid range for a screen reader.
         *  The bar itself stays clamped at full. */
        aria-valuemax={Math.max(granted, remaining)}
        aria-valuenow={remaining}
        /** The bar alone conveys nothing to a screen reader, and the visible
         *  digits are only the numerator. */
        aria-label={localize('com_ui_credits_remaining_of', {
          0: formatDisplayCredits(remaining),
          1: formatDisplayCredits(granted),
        })}
      >
        <div
          className={`h-full rounded-full transition-[width] ${
            isLow ? 'bg-text-primary' : 'bg-text-tertiary'
          }`}
          style={{ width: `${fraction * 100}%` }}
        />
      </div>
    </div>
  );
}

export default memo(AllowanceMeter);
