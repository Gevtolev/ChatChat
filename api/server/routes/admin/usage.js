const express = require('express');
const { createAdminUsageHandlers } = require('@librechat/api');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

const router = express.Router();

const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);
const requireReadUsage = requireCapability(SystemCapabilities.READ_USAGE);

const handlers = createAdminUsageHandlers({
  aggregateUsage: db.aggregateUsage,
  findActiveSubscriptions: db.findActiveSubscriptions,
  /** Cost rows are keyed by user id; only the email is needed to label them. */
  findUserEmails: async (userIds) => {
    const users = await db.findUsers({ _id: { $in: userIds } }, '_id email');
    return users.map((user) => ({ _id: String(user._id), email: user.email ?? null }));
  },
});

router.use(requireJwtAuth, requireAdminAccess);

router.get('/', requireReadUsage, handlers.getUsage);

module.exports = router;
