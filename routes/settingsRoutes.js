// routes/settingsRoutes.js
const express = require('express');
const router = express.Router();
const { getDateLimit, setDateLimit, getIfsVoucherEditing, setIfsVoucherEditing } = require('../controllers/settingsController');
const { isAuthenticated } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   - name: Settings
 *     description: Application settings management
 */

/**
 * @swagger
 * /settings/date-limit:
 *   get:
 *     summary: Get the minimum allowed filter date
 *     tags: [Settings]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       '200':
 *         description: Minimum date setting
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 min_date:
 *                   type: string
 *                   format: date
 *                 is_default:
 *                   type: boolean
 *       '401':
 *         description: Not authenticated
 */
router.get('/date-limit', isAuthenticated, getDateLimit);

/**
 * @swagger
 * /settings/date-limit:
 *   put:
 *     summary: Set the minimum allowed filter date (admin only)
 *     tags: [Settings]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [min_date]
 *             properties:
 *               min_date:
 *                 type: string
 *                 format: date
 *     responses:
 *       '200':
 *         description: Date limit updated
 *       '400':
 *         description: Invalid date
 *       '403':
 *         description: Admin required
 */
router.put('/date-limit', isAuthenticated, setDateLimit);

/**
 * @swagger
 * /settings/ifs-voucher-editing:
 *   get:
 *     summary: Check if IFS Voucher Number editing is enabled
 *     tags: [Settings]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       '200':
 *         description: IFS voucher editing status
 */
router.get('/ifs-voucher-editing', isAuthenticated, getIfsVoucherEditing);

/**
 * @swagger
 * /settings/ifs-voucher-editing:
 *   put:
 *     summary: Enable or disable IFS Voucher Number editing (admin only)
 *     tags: [Settings]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [enabled]
 *             properties:
 *               enabled:
 *                 type: boolean
 *     responses:
 *       '200':
 *         description: Setting updated
 *       '403':
 *         description: Admin required
 */
router.put('/ifs-voucher-editing', isAuthenticated, setIfsVoucherEditing);

module.exports = router;
