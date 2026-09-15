const express = require('express');
const { billingEntitlementsController } = require('../controllers/Billing');
const { requireJwtAuth } = require('../middleware/');

const router = express.Router();

router.get('/entitlements', requireJwtAuth, billingEntitlementsController);

module.exports = router;
