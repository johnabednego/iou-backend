// controllers/uploadController.js
const IOUAttachment = require('../models/IOUAttachment');
const IOURequest = require('../models/IOURequest');
const DirectExpenseAttachment = require('../models/DirectExpenseAttachment');
const DirectExpenseRequest = require('../models/DirectExpenseRequest');
const { uploadBuffer, deleteBlob, generateBlobSAS } = require('../services/azureBlobService');
const sequelize = require('../config/database');
const auditService = require('../services/auditService');

/**
 * Helper to find an attachment across both IOUAttachment and DirectExpenseAttachment models
 */
async function findAnyAttachment(id, options = {}) {
  let attachment = await IOUAttachment.findByPk(id, options);
  if (attachment) {
    let parent = null;
    if (attachment.iou_id) {
      parent = await IOURequest.findByPk(attachment.iou_id, options);
    }
    return { attachment, type: 'IOU', parent };
  }

  if (DirectExpenseAttachment) {
    attachment = await DirectExpenseAttachment.findByPk(id, options);
    if (attachment) {
      let parent = null;
      if (attachment.direct_expense_id) {
        parent = await DirectExpenseRequest.findByPk(attachment.direct_expense_id, options);
      }
      return { attachment, type: 'DIRECT_EXPENSE', parent };
    }
  }

  return { attachment: null, type: null, parent: null };
}

/**
 * POST /api/uploads
 * Upload a file to Azure and return its metadata.
 * If iou_id or direct_expense_id is supplied, the DB record is created immediately.
 */
exports.uploadFile = [
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor) {
        return res.status(401).json({ message: 'Not authenticated' });
      }

      if (!req.file) {
        return res.status(400).json({ message: 'No file uploaded' });
      }

      const { originalname, buffer, mimetype, size } = req.file;

      // Upload to Azure
      const uploaded = await uploadBuffer(buffer, originalname, mimetype);

      // If iou_id is provided, persist the attachment to DB immediately
      const iouId = req.body.iou_id || null;
      if (iouId) {
        try {
          const iou = await IOURequest.findByPk(iouId);
          if (iou) {
            const attachment = await IOUAttachment.create({
              iou_id: iouId,
              file_name: originalname,
              blob_name: uploaded.blobName,
              file_path: uploaded.url,
              content_type: mimetype,
              size,
              uploaded_by: actor.id
            });
            return res.status(201).json(attachment.toJSON());
          }
        } catch (attachErr) {
          console.warn('Could not link attachment to IOU in DB:', attachErr.message);
        }
      }

      // If direct_expense_id is provided, persist to DB immediately
      const deId = req.body.direct_expense_id || req.body.de_id || null;
      if (deId && DirectExpenseAttachment) {
        try {
          const de = await DirectExpenseRequest.findByPk(deId);
          if (de) {
            const attachment = await DirectExpenseAttachment.create({
              direct_expense_id: deId,
              file_name: originalname,
              blob_name: uploaded.blobName,
              file_path: uploaded.url,
              content_type: mimetype,
              size,
              uploaded_by: actor.id
            });
            return res.status(201).json(attachment.toJSON());
          }
        } catch (attachErr) {
          console.warn('Could not link attachment to Direct Expense in DB:', attachErr.message);
        }
      }

      // No parent ID or DB linking failed - return Azure metadata only
      return res.status(201).json({
        file_name: originalname,
        blob_name: uploaded.blobName,
        file_path: uploaded.url,
        content_type: mimetype,
        size
      });
    } catch (err) {
      console.error('uploadFile error', err);
      return res.status(500).json({
        message: 'Error uploading file',
        detail: err.message || String(err)
      });
    }
  }
];

/**
 * GET /api/uploads/:id/download
 * Pre-signed download URL generation supporting both IOUs and Direct Expenses
 */
exports.getDownloadUrl = [
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor) return res.status(401).json({ message: 'Not authenticated' });

      const { id } = req.params;
      const { attachment, type, parent } = await findAnyAttachment(id);

      if (!attachment) {
        return res.status(404).json({ message: 'Attachment not found' });
      }

      // Access control:
      // Allow admin, cashier, approver, HOD, uploader, or request owner
      const isPrivileged = actor.is_admin || actor.role === 'cashier' || actor.is_approver === true || actor.role === 'hod';
      const isUploader = String(attachment.uploaded_by) === String(actor.id);
      const isOwner = parent && String(parent.requester_id) === String(actor.id);

      if (!isPrivileged && !isUploader && !isOwner) {
        return res.status(403).json({ message: 'Forbidden' });
      }

      const expiresMinutes = parseInt(process.env.AZURE_SAS_EXPIRES_MINUTES || '60', 10);

      // Try to generate SAS with fallback to stored file_path
      try {
        const sasUrl = generateBlobSAS(attachment.blob_name, expiresMinutes);
        return res.json({ url: sasUrl, expires_in_minutes: expiresMinutes });
      } catch (err) {
        console.warn('generateBlobSAS failed, falling back to stored file_path. Reason:', err.message || err);
        if (attachment.file_path) {
          return res.json({ url: attachment.file_path, fallback: true });
        }
        console.error('getDownloadUrl error (no SAS and no stored file_path)', err);
        return res.status(500).json({
          message: 'SAS generation not available and no fallback file_path present. Configure AZURE_STORAGE_ACCOUNT_NAME & AZURE_STORAGE_ACCOUNT_KEY to enable SAS generation, or upload with a SAS-enabled connection string.',
          detail: err.message || String(err)
        });
      }
    } catch (err) {
      console.error('getDownloadUrl error', err);
      return res.status(500).json({ message: 'Error generating download url', detail: err.message || String(err) });
    }
  }
];

/**
 * DELETE /api/uploads/:id
 * Delete an attachment from storage and DB (supporting both IOUs and Direct Expenses)
 */
exports.deleteAttachment = [
  async (req, res) => {
    const t = await sequelize.transaction();
    try {
      const actor = req.currentUser;
      if (!actor) { await t.rollback(); return res.status(401).json({ message: 'Not authenticated' }); }

      const { id } = req.params;
      const { attachment, type, parent } = await findAnyAttachment(id, { transaction: t });

      if (!attachment) {
        await t.rollback();
        return res.status(404).json({ message: 'Attachment not found' });
      }

      const isUploader = String(attachment.uploaded_by) === String(actor.id);
      const isOwner = parent && String(parent.requester_id) === String(actor.id);
      const allowed = actor.is_admin || isUploader || isOwner;

      if (!allowed) {
        await t.rollback();
        return res.status(403).json({ message: 'Forbidden' });
      }

      try {
        const deleted = await deleteBlob(attachment.blob_name);
        await attachment.destroy({ transaction: t });

        await auditService.log({
          actorId: actor.id,
          actorName: actor.display_name || actor.username,
          action: 'DELETE_ATTACHMENT',
          entity: type === 'DIRECT_EXPENSE' ? 'DIRECT_EXPENSE_ATTACHMENT' : 'IOU_ATTACHMENT',
          entityId: id,
          details: { blob_name: attachment.blob_name, blob_deleted: deleted }
        }, { transaction: t });

        await t.commit();
        return res.json({ message: 'Attachment deleted', blob_deleted: deleted });
      } catch (err) {
        await t.rollback();
        console.error('deleteAttachment -> deleteBlob error', err);
        return res.status(500).json({
          message: 'Failed to delete blob from storage. Check Azure storage configuration.',
          detail: err.message || String(err)
        });
      }
    } catch (err) {
      await t.rollback();
      console.error('deleteAttachment error', err);
      return res.status(500).json({ message: 'Error deleting attachment', detail: err.message || String(err) });
    }
  }
];
