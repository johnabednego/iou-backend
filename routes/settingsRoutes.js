// routes/settingsRoutes.js
const express = require('express');
const router = express.Router();
const { getDateLimit, setDateLimit } = require('../controllers/settingsController');
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

module.exports = router;
