// routes/approvalRoutes.js
const express = require('express');
const router = express.Router();
const { decideApproval, listMine } = require('../controllers/approvalController');
const { isAuthenticated } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   - name: Approvals
 *     description: Approval decisions
 *
 * components:
 *   schemas:
 *     ApprovalDecisionInput:
 *       type: object
 *       properties:
 *         decision:
 *           type: string
 *           enum: [APPROVED, REJECTED, RETURNED]
 *         comments:
 *           type: string
 *       required:
 *         - decision
 *       example:
 *         decision: "APPROVED"
 *         comments: "Looks good to me."
 *
 *     ApprovalResponse:
 *       type: object
 *       properties:
 *         message:
 *           type: string
 *         approval:
 *           type: object
 *           properties:
 *             id: { type: string }
 *             iou_id: { type: string }
 *             approver_id: { type: string }
 *             step_order: { type: integer }
 *             decision: { type: string }
 *             comments: { type: string }
 *             decision_at: { type: string, format: date-time }
 *       example:
 *         message: "Decision recorded"
 *         approval:
 *           id: "a1b2c3d4-..."
 *           iou_id: "6b3f9b3a-..."
 *           approver_id: "11111111-2222-3333-4444"
 *           step_order: 1
 *           decision: "APPROVED"
 *           comments: "Approved"
 *           decision_at: "2025-10-30T10:00:00Z"
 */

/**
 * @swagger
 * /approvals/mine:
 *   get:
 *     summary: List pending approvals assigned to current user
 *     tags: [Approvals]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       '200':
 *         description: List of approvals
 */
router.get('/mine', isAuthenticated, listMine);

/**
 * @swagger
 * /approvals/{id}:
 *   put:
 *     summary: Make decision on an approval (approve/reject/return)
 *     tags: [Approvals]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         description: Approval UUID
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ApprovalDecisionInput'
 *     responses:
 *       '200':
 *         description: Decision recorded
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApprovalResponse'
 *       '400':
 *         description: Invalid decision or bad request
 *       '401':
 *         description: Not authenticated
 *       '403':
 *         description: Forbidden (not the approver or not their turn)
 *       '404':
 *         description: Approval not found
 *       '500':
 *         description: Server error
 */
router.put('/:id', isAuthenticated, decideApproval);

module.exports = router;
