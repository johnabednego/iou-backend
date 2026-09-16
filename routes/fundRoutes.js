// routes/fundRoutes.js
const express = require('express');
const router = express.Router();
const { isAuthenticated } = require('../middleware/auth');
const fundController = require('../controllers/fundController');

router.get('/', isAuthenticated, ...fundController.listFundBalances);
router.get('/transactions', isAuthenticated, ...fundController.listFundTransactions);
router.get('/check/:currency/:amount', isAuthenticated, ...fundController.checkFunds);
router.put('/:currency', isAuthenticated, ...fundController.updateFundBalance);

module.exports = router;
