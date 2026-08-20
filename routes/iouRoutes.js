// routes/iouRoutes.js
const express = require('express');
const router = express.Router();
const {
  createIOU,
  listIOUs,
  getIOU,
  updateIOU,
  submitIOU,
  assignApprovers,
  confirmApproval,
  cashierRejectIOU,
  cashierReturnIOU
} = require('../controllers/iouController');
const { isAuthenticated } = require('../middleware/auth');
const { requireCashierOrAdmin } = require('../middleware/roles');

/**
 * @swagger
 * tags:
 *   - name: IOUs
 *     description: IOU requests management
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     IOUAttachmentInput:
 *       type: object
 *       properties:
 *         file_name:
 *           type: string
 *         file_path:
 *           type: string
 *         blob_name:
 *           type: string
 *       example:
 *         - file_name: receipt.pdf
 *           file_path: https://account.blob.core.windows.net/ious-attachments/abc.pdf
 *           blob_name: "uuid-1234.pdf"
 *
 *     IOURequestInput:
 *       type: object
 *       properties:
 *         purpose:
 *           type: string
 *         estimated_amount:
 *           type: number
 *           format: double
 *         currency:
 *           type: string
 *         attachments:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/IOUAttachmentInput'
 *       example:
 *         purpose: "Office supplies for procurement"
 *         estimated_amount: 1200.00
 *         currency: "GHS"
 *         attachments:
 *           - file_name: receipt.pdf
 *             file_path: https://account.blob.core.windows.net/ious-attachments/abc.pdf
 *             blob_name: "uuid-1234.pdf"
 *
 *     IOURequestResponse:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *         request_number:
 *           type: string
 *         requester_id:
 *           type: string
 *         department:
 *           type: string
 *         purpose:
 *           type: string
 *         estimated_amount:
 *           type: number
 *         currency:
 *           type: string
 *         status:
 *           type: string
 *         submitted_at:
 *           type: string
 *           format: date-time
 *         created_at:
 *           type: string
 *           format: date-time
 *       example:
 *         id: "6b3f9b3a-...."
 *         request_number: "IOU-20251030-120000-1234"
 *         requester_id: "11111111-2222-3333-4444"
 *         department: "IT"
 *         purpose: "Office supplies"
 *         estimated_amount: 1200.00
 *         currency: "GHS"
 *         status: "DRAFT"
 *         submitted_at: null
 *         created_at: "2025-10-30T09:00:00Z"
 */

/**
 * @swagger
 * /ious:
 *   post:
 *     summary: Create IOU (draft)
 *     tags: [IOUs]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/IOURequestInput'
 *     responses:
 *       '201':
 *         description: IOU created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 iou:
 *                   $ref: '#/components/schemas/IOURequestResponse'
 *       '400':
 *         description: Bad request
 *       '401':
 *         description: Not authenticated
 *       '500':
 *         description: Server error
 */
router.post('/', isAuthenticated, createIOU);

/**
 * @swagger
 * /ious:
 *   get:
 *     summary: List IOUs (paging & filters)
 *     tags: [IOUs]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Max number of records to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Pagination offset
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *         description: Filter by IOU status (DRAFT, PENDING, APPROVED, REJECTED, RETURNED)
 *       - in: query
 *         name: department
 *         schema:
 *           type: string
 *         description: Filter by department
 *     responses:
 *       '200':
 *         description: List of IOUs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/IOURequestResponse'
 *       '401':
 *         description: Not authenticated
 *       '500':
 *         description: Server error
 */
router.get('/', isAuthenticated, listIOUs);

/**
 * @swagger
 * /ious/{id}:
 *   get:
 *     summary: Get IOU by id
 *     tags: [IOUs]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: string
 *         required: true
 *         description: IOU UUID
 *     responses:
 *       '200':
 *         description: IOU object with attachments and approvals
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 iou:
 *                   $ref: '#/components/schemas/IOURequestResponse'
 *                 attachments:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       file_name: { type: string }
 *                       file_path: { type: string }
 *                       blob_name: { type: string }
 *                       content_type: { type: string }
 *                       size: { type: integer }
 *                 approvals:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       approver_id: { type: string }
 *                       step_order: { type: integer }
 *                       decision: { type: string }
 *                       comments: { type: string }
 *                       decision_at: { type: string, format: date-time }
 *       '401':
 *         description: Not authenticated
 *       '403':
 *         description: Forbidden (no access)
 *       '404':
 *         description: Not found
 */
router.get('/:id', isAuthenticated, getIOU);

/**
 * @swagger
 * /ious/{id}:
 *   put:
 *     summary: Update IOU (owner or admin). Only DRAFT or RETURNED IOUs can be edited.
 *     tags: [IOUs]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: string
 *         required: true
 *         description: IOU UUID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               purpose:
 *                 type: string
 *               estimated_amount:
 *                 type: number
 *               currency:
 *                 type: string
 *     responses:
 *       '200':
 *         description: Updated IOU
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 iou: { $ref: '#/components/schemas/IOURequestResponse' }
 *       '400':
 *         description: Bad request
 *       '401':
 *         description: Not authenticated
 *       '403':
 *         description: Forbidden
 *       '404':
 *         description: Not found
 */
router.put('/:id', isAuthenticated, updateIOU);

/**
 * @swagger
 * /ious/{id}/submit:
 *   post:
 *     summary: Submit IOU for approval (creates approval rows)
 *     tags: [IOUs]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: string
 *         required: true
 *         description: IOU UUID
 *     responses:
 *       '200':
 *         description: IOU submitted for approval - returns list of created approvers
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 approvers:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       iou_id: { type: string }
 *                       approver_id: { type: string }
 *                       step_order: { type: integer }
 *       '400':
 *         description: Bad request / invalid state
 *       '401':
 *         description: Not authenticated
 *       '403':
 *         description: Forbidden
 *       '404':
 *         description: Not found
 */
router.post('/:id/submit', isAuthenticated, submitIOU);

 /**
 * @swagger
 * /ious/{id}/assign-approvers:
 *   post:
 *     summary: Assign an ordered list of approvers to an IOU (cashier or admin only)
 *     tags: [IOUs]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: IOU UUID
 *         schema:
 *           type: string
 *     requestBody:
 *       description: Array of approver entries with order
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               approvers:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     approver_id:
 *                       type: string
 *                     step_order:
 *                       type: integer
 *                 example:
 *                   - approver_id: "11111111-2222-3333-4444"
 *                     step_order: 1
 *                   - approver_id: "22222222-3333-4444-5555"
 *                     step_order: 2
 *     responses:
 *       '200':
 *         description: Approvers assigned and first approver notified
 *       '400':
 *         description: Bad request
 *       '401':
 *         description: Not authenticated
 *       '403':
 *         description: Forbidden (not cashier or admin)
 *       '404':
 *         description: IOU not found
 */
router.post('/:id/assign-approvers', isAuthenticated, requireCashierOrAdmin, assignApprovers);

/**
 * @swagger
 * /ious/{id}/confirm-approval:
 *   post:
 *     summary: Cashier/admin confirms all approvals are complete (moves to APPROVED_FOR_DISBURSEMENT)
 *     tags: [IOUs]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: IOU UUID
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Approval confirmed
 *       '400':
 *         description: Bad request (pending approvals remain)
 *       '401':
 *         description: Not authenticated
 *       '403':
 *         description: Forbidden (not cashier or admin)
 *       '404':
 *         description: IOU not found
 */
router.post('/:id/confirm-approval', isAuthenticated, requireCashierOrAdmin, confirmApproval);

/**
 * @swagger
 * /ious/{id}/cashier-reject:
 *   post:
 *     summary: Cashier/admin rejects an IOU at the PENDING_HOD_ASSIGNMENT stage
 *     tags: [IOUs]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [comments]
 *             properties:
 *               comments:
 *                 type: string
 *     responses:
 *       '200':
 *         description: IOU rejected
 *       '400':
 *         description: Bad request (wrong status or missing comment)
 *       '403':
 *         description: Forbidden
 */
router.post('/:id/cashier-reject', isAuthenticated, requireCashierOrAdmin, cashierRejectIOU);

/**
 * @swagger
 * /ious/{id}/cashier-return:
 *   post:
 *     summary: Cashier/admin returns an IOU for edits at the PENDING_HOD_ASSIGNMENT stage
 *     tags: [IOUs]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [comments]
 *             properties:
 *               comments:
 *                 type: string
 *     responses:
 *       '200':
 *         description: IOU returned for edits
 *       '400':
 *         description: Bad request (wrong status or missing comment)
 *       '403':
 *         description: Forbidden
 */
router.post('/:id/cashier-return', isAuthenticated, requireCashierOrAdmin, cashierReturnIOU);

module.exports = router;
