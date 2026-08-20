// routes/auditRoutes.js
const express = require('express');
const router = express.Router();
const { listAuditLogs } = require('../controllers/auditController');
const { isAuthenticated } = require('../middleware/auth');

router.get('/', isAuthenticated, listAuditLogs);

module.exports = router;
