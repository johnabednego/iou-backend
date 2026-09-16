// routes/currencyRoutes.js
const express = require('express');
const router = express.Router();
const { isAuthenticated } = require('../middleware/auth');
const currencyController = require('../controllers/currencyController');

router.get('/', isAuthenticated, ...currencyController.listCurrencies);
router.post('/', isAuthenticated, ...currencyController.createCurrency);
router.put('/:id', isAuthenticated, ...currencyController.updateCurrency);
router.delete('/:id', isAuthenticated, ...currencyController.deleteCurrency);

module.exports = router;
