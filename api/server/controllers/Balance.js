const { getEntitlements, buildEntitlementsDeps } = require('@librechat/api');
const db = require('~/models');

/**
 * Returns the caller's balance alongside the plan that governs it.
 *
 * The two used to be separate concerns and the client only ever saw the first,
 * which made the number unreadable: `tokenCredits` is a raw cost figure, so
 * without the plan's grant to divide against there is no way to render "how
 * much is left". The plan also carries `allowedCostTiers`, which is what lets
 * the model picker stop offering models the gate will refuse.
 *
 * `entitlements` is always present; `balance` still 404s when absent, since
 * existing callers treat that as "no balance system for this account".
 */
async function balanceController(req, res) {
  const entitlements = await getEntitlements(req.user.id, buildEntitlementsDeps(db));
  const balanceData = await db.findBalanceByUser(req.user.id);

  if (!balanceData) {
    return res.status(404).json({ error: 'Balance not found', entitlements });
  }

  const { _id: _, ...result } = balanceData;

  if (!result.autoRefillEnabled) {
    delete result.refillIntervalValue;
    delete result.refillIntervalUnit;
    delete result.lastRefill;
    delete result.refillAmount;
  }

  res.status(200).json({ ...result, entitlements });
}

module.exports = balanceController;
