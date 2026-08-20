import { creditsToUsd } from './format';

describe('creditsToUsd', () => {
  it('renders whole dollars with two decimals', () => {
    expect(creditsToUsd(12_340_000)).toBe('12.34');
  });

  it('keeps sub-cent amounts visible instead of rounding them to zero', () => {
    /** Beta traffic is small; 0.00 for every row would make the table useless. */
    expect(creditsToUsd(800)).toBe('0.0008');
  });

  it('renders exact zero plainly', () => {
    expect(creditsToUsd(0)).toBe('0.00');
  });

  it('keeps the sign on a negative margin', () => {
    expect(creditsToUsd(-2_500_000)).toBe('-2.50');
  });
});
