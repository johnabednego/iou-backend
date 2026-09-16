// routes/analyticsRoutes.js
const express = require('express');
const router = express.Router();
const { isAuthenticated } = require('../middleware/auth');
const analyticsController = require('../controllers/analyticsController');

router.get('/dashboard', isAuthenticated, ...analyticsController.getDashboardAnalytics);

module.exports = router;
