/**
 * Whether credits should be drawn down for this deployment.
 *
 * Upstream ties deduction to `balance.enabled`, its own balance feature. This
 * fork never enables it — upstream's refill *increments* where ours overwrites,
 * and running both would roll over credits sold as expiring — but the same flag
 * also guards deduction, so credits went unspent entirely: production
 * accumulated 1,032 transactions against eight balances still at their full
 * grant, with the quota gate reading a number nothing decremented.
 *
 * Keyed to `DISABLE_BILLING_GATING`, the switch `checkBillingAccess` reads, so
 * enforcement and metering cannot disagree about whether billing is on. Not
 * config-driven: config living outside git is what produced that defect, and a
 * flag nobody set looks exactly like a flag nobody needed.
 *
 * Exported from here rather than kept private to a factory because three write
 * paths need it — `createTransaction`, `createStructuredTransaction`, and the
 * bulk path the agents endpoint actually uses. The first version of this fix
 * converted two of them and left the third, which meant identical usage was
 * charged or not depending on whether the caller happened to pass `pricing`
 * deps. One definition removes that possibility.
 *
 * Parsing matches `isEnabled` in `@librechat/api` exactly — lowercase, trimmed,
 * strict `'true'`. An earlier version also accepted `'1'` and skipped the trim,
 * which meant `DISABLE_BILLING_GATING=1` enforced without metering and
 * `'true '` metered without enforcing.
 */
export function isMeteringEnabled(
  balance?: { enabled?: boolean } | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (balance?.enabled === true) {
    return true;
  }
  return env.DISABLE_BILLING_GATING?.toLowerCase().trim() !== 'true';
}
