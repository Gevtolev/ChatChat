import { toDisplayCredits, formatDisplayCredits, allowanceFraction } from '../credits';

describe('toDisplayCredits', () => {
  /** The three paid grants were derived from round display credits, so they are
   *  the only ones that divide evenly. If one of these drifts, the number on the
   *  pricing page stops matching the number in the app. */
  it.each([
    [14_950_000, 1_000_000],
    [29_900_000, 2_000_000],
    [52_325_000, 3_500_000],
  ])('renders %i as %i', (tokenCredits, expected) => {
    expect(toDisplayCredits(tokenCredits, 14.95)).toBe(expected);
  });

  /** `beta` divides to 3,344,481.605. Rounding up would promise an allowance the
   *  gate will not honour. */
  it('rounds down rather than up', () => {
    expect(toDisplayCredits(50_000_000, 14.95)).toBe(3_344_481);
  });

  it('never returns a negative count', () => {
    expect(toDisplayCredits(-5_000, 14.95)).toBe(0);
  });

  /** A divisor arriving as 0 or undefined from a partial response must not turn
   *  the allowance into Infinity on screen. */
  it.each([0, -1, NaN])('returns 0 for a divisor of %s', (divisor) => {
    expect(toDisplayCredits(14_950_000, divisor)).toBe(0);
  });
});

describe('formatDisplayCredits', () => {
  it('groups digits rather than abbreviating', () => {
    expect(formatDisplayCredits(1_000_000, 'en-US')).toBe('1,000,000');
  });
});

describe('allowanceFraction', () => {
  it('reports the unspent share', () => {
    expect(allowanceFraction(500, 1000)).toBe(0.5);
  });

  it('clamps an overspent balance to zero rather than going negative', () => {
    expect(allowanceFraction(-100, 1000)).toBe(0);
  });

  /** A plan that grants nothing has no bar to draw, which is not the same as an
   *  empty one — anonymous is capped by message count. */
  it('returns null when nothing was granted', () => {
    expect(allowanceFraction(0, 0)).toBeNull();
  });
});
