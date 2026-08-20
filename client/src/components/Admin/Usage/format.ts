/** 1 tokenCredit = one micro-dollar. */
const CREDITS_PER_USD = 1_000_000;

/**
 * Formats an amount held in tokenCredits as a dollar string.
 *
 * Amounts under a cent keep four decimals rather than rounding to `0.00`.
 * Beta traffic is small enough that a whole table of `0.00` would carry no
 * information at all.
 */
export function creditsToUsd(credits: number): string {
  const usd = credits / CREDITS_PER_USD;
  if (usd !== 0 && Math.abs(usd) < 0.01) {
    return usd.toFixed(4);
  }
  return usd.toFixed(2);
}
