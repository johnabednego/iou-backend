// routes/notificationRoutes.js
const express = require('express');
const router = express.Router();
const { listNotifications, markRead } = require('../controllers/notificationController');
const { isAuthenticated } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   - name: Notifications
 *     description: In-app notifications and read/unread marking
 *
 * components:
 *   schemas:
 *     NotificationItem:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *         target_user_id:
 *           type: string
 *         title:
 *           type: string
 *         body:
 *           type: string
 *         link:
 *           type: string
 *         entity:
 *           type: string
 *         entity_id:
 *           type: string
 *         is_read:
 *           type: boolean
 *         created_at:
 *           type: string
 *           format: date-time
 *       example:
 *         id: "d6f9a1b2-..."
 *         target_user_id: "11111111-2222-3333-4444"
 *         title: "Approval required: IOU-20251102-1234"
 *         body: "You have been requested to approve IOU IOU-20251102-1234."
 *         link: "/ious/6b3f9b3a-..."
 *         entity: "IOU"
 *         entity_id: "6b3f9b3a-..."
 *         is_read: false
 *         created_at: "2025-11-02T09:00:00Z"
 */

/**
 * @swagger
 * /notifications:
 *   get:
 *     summary: List notifications for current user
 *     tags: [Notifications]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: unread
 *         schema:
 *           type: boolean
 *         description: If true, return only unread notifications
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Limit number of results
 *     responses:
 *       '200':
 *         description: Notifications list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/NotificationItem'
 *       '401':
 *         description: Not authenticated
 */
router.get('/', isAuthenticated, listNotifications);

/**
 * @swagger
 * /notifications/{id}/read:
 *   put:
 *     summary: Mark a notification as read
 *     tags: [Notifications]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Notification UUID
 *     responses:
 *       '200':
 *         description: Notification marked read
 *       '401':
 *         description: Not authenticated
 *       '403':
 *         description: Forbidden
 *       '404':
 *         description: Not found
 */
router.put('/:id/read', isAuthenticated, markRead);

module.exports = router;
