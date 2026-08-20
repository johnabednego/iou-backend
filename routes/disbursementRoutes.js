// routes/disbursementRoutes.js
const express = require('express');
const router = express.Router();
const { disburse, getDisbursements, confirmDisbursement } = require('../controllers/disbursementController');
const { isAuthenticated } = require('../middleware/auth');
const { requireCashierOrAdmin } = require('../middleware/roles');

router.post('/:id/disburse', isAuthenticated, requireCashierOrAdmin, disburse);
router.post('/:id/confirm-disbursement', isAuthenticated, confirmDisbursement);
router.get('/:id/disbursements', isAuthenticated, getDisbursements);

module.exports = router;
