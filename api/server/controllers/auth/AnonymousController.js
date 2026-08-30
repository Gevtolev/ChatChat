const { randomUUID } = require('node:crypto');
const { logger, getTenantId } = require('@librechat/data-schemas');
const { SystemRoles } = require('librechat-data-provider');
const { applyPlanChange, buildPlanChangeDeps } = require('@librechat/api');
const db = require('~/models');
const { createUser } = require('~/models');
const { setAuthTokens } = require('~/server/services/AuthService');
const { getAppConfig } = require('~/server/services/Config');

/**
 * Silently creates a real, anonymous `User` (provider: 'anonymous', role: GUEST) and issues a
 * real JWT for it, so unauthenticated visitors flow through the same authenticated pipeline
 * (chat, file uploads, etc.) as everyone else instead of a bespoke parallel implementation.
 * The account expires in 7 days (same TTL mechanism used for unverified email registrations)
 * unless the visitor registers/logs in first, at which point it's converted or migrated.
 */
const anonymousController = async (req, res) => {
  try {
    if (req.user) {
      return res.status(400).json({ message: 'Already authenticated' });
    }

    const tenantId = getTenantId();
    const appConfig = await getAppConfig(tenantId ? { tenantId } : { baseOnly: true });
    if (appConfig?.anonymousAccess !== true) {
      return res.status(404).json({ message: 'Anonymous access is not enabled' });
    }

    const email = `anon-${randomUUID()}@chatchat.anonymous`;
    const newUser = await createUser(
      { email, provider: 'anonymous', role: SystemRoles.GUEST },
      appConfig.balance,
      false /* disableTTL */,
      true /* returnUser */,
    );

    await applyPlanChange(
      { user_id: newUser._id, plan_code: 'anonymous', source: 'system_default' },
      buildPlanChangeDeps(db),
    );

    const token = await setAuthTokens(newUser._id, res, null, req);
    const { password: _p, totpSecret: _t, __v, ...user } = newUser;
    user.id = user._id.toString();

    return res.status(200).send({ token, user });
  } catch (err) {
    logger.error('[anonymousController] Failed to create anonymous session', err);
    return res.status(500).json({ message: 'Something went wrong' });
  }
};

module.exports = {
  anonymousController,
};
