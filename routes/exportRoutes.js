// routes/exportRoutes.js
const express = require('express');
const router = express.Router();
const { exportRedeemed } = require('../controllers/exportController');
const { isAuthenticated } = require('../middleware/auth');

/**
 * @swagger
 * /ious/export:
 *   get:
 *     summary: Export REDEEMED IOUs to Excel (cashier, admin, or approver only)
 *     tags: [IOUs]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search by request #, IFS voucher #, requester, or purpose
 *       - in: query
 *         name: start_date
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter from date
 *       - in: query
 *         name: end_date
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter to date
 *     responses:
 *       '200':
 *         description: Excel file download
 *         content:
 *           application/vnd.openxmlformats-officedocument.spreadsheetml.sheet:
 *             schema:
 *               type: string
 *               format: binary
 *       '403':
 *         description: Forbidden (not cashier/admin/approver)
 *       '401':
 *         description: Not authenticated
 */
router.get('/export', isAuthenticated, exportRedeemed);

module.exports = router;
