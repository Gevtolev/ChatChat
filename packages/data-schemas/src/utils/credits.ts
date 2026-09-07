/**
 * What a balance row can actually pay for: the monthly grant plus anything
 * bought outright.
 *
 * Split across two fields because the grant is *overwritten* at renewal rather
 * than added to, and purchased credits must survive that. Every read that means
 * "how much is left" has to sum them, and every one that forgets under-reports:
 * the gate would refuse a user who had just topped up, and the allowance meter
 * would show them empty while `spendTokens` drew on the credits they paid for.
 *
 * Both read through `?? 0` — `purchasedCredits` is absent on every row written
 * before it existed, and `tokenCredits` can be missing on rows not created
 * through the schema.
 */
export function spendableCredits(
  balance?: {
    tokenCredits?: number;
    purchasedCredits?: number;
  } | null,
): number {
  return (balance?.tokenCredits ?? 0) + (balance?.purchasedCredits ?? 0);
}
