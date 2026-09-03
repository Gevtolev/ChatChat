const { getModelTier, getEntitlements, buildEntitlementsDeps } = require('@librechat/api');
const { getTenantId } = require('@librechat/data-schemas');
const { getAppConfig } = require('~/server/services/Config/app');
const db = require('~/models');

/**
 * Spec names the caller's plan cannot reach, so the picker can grey them out
 * instead of letting the send fail.
 *
 * Keyed by spec `name` because that is what the picker selects on, but resolved
 * through `preset.model`, which is the id the gate actually tiers. Those differ
 * — "Grok 4.3" against `x-ai/grok-4.3` — and matching on the wrong one silently
 * locks nothing.
 *
 * Computed on the server rather than shipped as a tier map because
 * `MODEL_REGISTRY` is the gate's own table. A copy in the client is a copy that
 * drifts, and it would drift into offering models the gate refuses — which is
 * the bug this is here to fix.
 */
function lockedSpecNames(appConfig, allowedCostTiers) {
  const specs = appConfig?.modelSpecs?.list ?? [];
  const allowed = new Set(allowedCostTiers);
  return specs
    .filter((spec) => spec?.preset?.model && !allowed.has(getModelTier(spec.preset.model)))
    .map((spec) => spec.name)
    .filter(Boolean);
}

/**
 * What the caller's plan allows and how much allowance is left.
 *
 * Separate from `GET /balance` on purpose. That route 404s when the account has
 * no Balance row, which is exactly the account most in need of being told what
 * its plan is — a user whose grant never landed would get an error instead of
 * an answer. It is also gated client-side on upstream's `balance.enabled`,
 * which we deliberately leave off.
 *
 * Always 200: every account resolves to a plan, falling back to `free` the same
 * way the gate does.
 */
async function billingEntitlementsController(req, res) {
  const entitlements = await getEntitlements(req.user.id, buildEntitlementsDeps(db));

  const appConfig = await getAppConfig({
    role: req.user.role,
    userId: req.user.id,
    tenantId: req.user.tenantId || getTenantId(),
  });
  entitlements.lockedModelSpecs = lockedSpecNames(appConfig, entitlements.plan.allowedCostTiers);

  res.status(200).json(entitlements);
}

module.exports = { billingEntitlementsController };
