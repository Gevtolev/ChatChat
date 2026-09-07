/**
 * Converts the internal cost unit into the number shown to the user.
 *
 * `tokenCredits` is micro-dollars of model cost; the displayed "credit" is that
 * divided by `CREDIT_DISPLAY_DIVISOR`, which is anchored so the entry tier reads
 * as a round 1,000,000. The divisor arrives from the server rather than being
 * imported here, so a future repricing cannot leave the client rendering against
 * a stale constant.
 *
 * Rounds **down**, always. The divisor is 14.95 and divides evenly only for the
 * paid tiers, whose grants were derived from round display credits in the first
 * place — every other plan produces a fraction (`beta` lands on
 * 3,344,481.605). Rounding up would promise an allowance the gate will not
 * honour, and being refused at a number the UI said you still had is worse than
 * seeing one credit fewer than you have.
 */
export function toDisplayCredits(tokenCredits: number, divisor: number): number {
  if (!Number.isFinite(tokenCredits) || !Number.isFinite(divisor) || divisor <= 0) {
    return 0;
  }
  return Math.max(0, Math.floor(tokenCredits / divisor));
}

/**
 * Formats a display-credit count for reading at a glance.
 *
 * Grouped by locale rather than abbreviated: an allowance is a number people
 * compare against a plan they are paying for, and "1.2M" hides whether that is
 * 1,200,000 or 1,249,999 exactly when the difference starts to matter.
 */
export function formatDisplayCredits(credits: number, locale?: string): string {
  return credits.toLocaleString(locale);
}

/**
 * Fraction of the granted allowance still unspent, clamped to 0–1.
 *
 * Returns null when there is nothing to be a fraction of — a plan that grants no
 * credits has no bar to draw, which is different from an empty one.
 */
export function allowanceFraction(remaining: number, granted: number): number | null {
  if (!Number.isFinite(granted) || granted <= 0) {
    return null;
  }
  return Math.min(1, Math.max(0, remaining / granted));
}
