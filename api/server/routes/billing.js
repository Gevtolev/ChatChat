const express = require('express');
const { billingEntitlementsController } = require('../controllers/Billing');
const { requireJwtAuth } = require('../middleware/');

const router = express.Router();

/** No `denyGuestRole` here, unlike `/balance`: anonymous accounts have a plan
 *  (`anonymous`, capped by message count) and the picker needs to know which
 *  models it allows just as much as a signed-up account does. */
router.get('/entitlements', requireJwtAuth, billingEntitlementsController);

module.exports = router;
