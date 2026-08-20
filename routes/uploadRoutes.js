const express = require('express');
const router = express.Router();
const upload = require('../middleware/uploadMulter'); // multer instance
const uploadController = require('../controllers/uploadController');
const { isAuthenticated } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   - name: Uploads
 *     description: File upload and management (Azure Blob)
 *
 * components:
 *   schemas:
 *     Attachment:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *         iou_id:
 *           type: string
 *           nullable: true
 *         file_name:
 *           type: string
 *         blob_name:
 *           type: string
 *         file_path:
 *           type: string
 *         content_type:
 *           type: string
 *         size:
 *           type: integer
 *         uploaded_by:
 *           type: string
 *         created_at:
 *           type: string
 *           format: date-time
 *       example:
 *         id: "d6f9a1b2-...-abcd"
 *         iou_id: "6b3f9b3a-...-1111"
 *         file_name: "receipt.pdf"
 *         blob_name: "6f8b9c2a-... .pdf"
 *         file_path: "https://youraccount.blob.core.windows.net/ious-attachments/6f8b9c2a-....pdf"
 *         content_type: "application/pdf"
 *         size: 123456
 *         uploaded_by: "11111111-2222-3333-4444"
 *         created_at: "2025-10-30T09:12:00Z"
 *
 *     UploadResponse:
 *       type: object
 *       properties:
 *         message:
 *           type: string
 *         attachment:
 *           $ref: '#/components/schemas/Attachment'
 *       example:
 *         message: "File uploaded"
 *         attachment:
 *           $ref: '#/components/schemas/Attachment'
 *
 *     DownloadUrlResponse:
 *       type: object
 *       properties:
 *         url:
 *           type: string
 *         expires_in_minutes:
 *           type: integer
 *       example:
 *         url: "https://youraccount.blob.core.windows.net/ious-attachments/6f8b9c2a-... .pdf?sv=..."
 *         expires_in_minutes: 60
 *
 *     DeleteResponse:
 *       type: object
 *       properties:
 *         message:
 *           type: string
 *         blob_deleted:
 *           type: boolean
 *       example:
 *         message: "Attachment deleted"
 *         blob_deleted: true
 */

/**
 * @swagger
 * /uploads:
 *   post:
 *     summary: Upload an attachment (multipart/form-data)
 *     tags: [Uploads]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: File to upload
 *               iou_id:
 *                 type: string
 *                 description: Optional IOU ID to attach this file to
 *     responses:
 *       '201':
 *         description: File uploaded
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UploadResponse'
 *       '400':
 *         description: Bad request (missing file or invalid IOU)
 *       '401':
 *         description: Not authenticated
 *       '403':
 *         description: Forbidden (no access to attach to IOU)
 *       '500':
 *         description: Server error
 */
router.post('/', isAuthenticated, upload.single('file'), uploadController.uploadFile);

/**
 * @swagger
 * /uploads/{id}/download:
 *   get:
 *     summary: Get pre-signed download URL for an attachment
 *     tags: [Uploads]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         description: Attachment UUID
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Pre-signed URL for download
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DownloadUrlResponse'
 *       '401':
 *         description: Not authenticated
 *       '403':
 *         description: Forbidden
 *       '404':
 *         description: Attachment not found
 *       '500':
 *         description: Server error
 */
router.get('/:id/download', isAuthenticated, uploadController.getDownloadUrl);

/**
 * @swagger
 * /uploads/{id}:
 *   delete:
 *     summary: Delete an attachment (blob + DB row)
 *     tags: [Uploads]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         description: Attachment UUID
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Deleted
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DeleteResponse'
 *       '401':
 *         description: Not authenticated
 *       '403':
 *         description: Forbidden
 *       '404':
 *         description: Not found
 *       '500':
 *         description: Server error
 */
router.delete('/:id', isAuthenticated, uploadController.deleteAttachment);

module.exports = router;
