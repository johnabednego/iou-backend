// controllers/uploadController.js
const IOUAttachment = require('../models/IOUAttachment');
const IOURequest = require('../models/IOURequest');
const { uploadBuffer, deleteBlob, generateBlobSAS } = require('../services/azureBlobService');
const sequelize = require('../config/database');
const auditService = require('../services/auditService');

/**
 * POST /api/uploads
 * Upload a file to Azure and return its metadata.
 * Attachment DB row is created later when the IOU itself is created.
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
      // uploaded = { blobName, url }

      // If iou_id is provided, persist the attachment to DB immediately
      // so it survives page reloads and appears in the attachments list
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
            // Return the full DB record (includes id, created_at, etc.)
            return res.status(201).json(attachment.toJSON());
          }
        } catch (attachErr) {
          // If DB linking fails, fall through and return just the Azure metadata
          console.warn('Could not link attachment to IOU in DB:', attachErr.message);
        }
      }

      // No iou_id or DB linking failed - return Azure metadata only
      // (caller is expected to pass this in the IOU create/update body)
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
 */
exports.getDownloadUrl = [
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor) return res.status(401).json({ message: 'Not authenticated' });

      const { id } = req.params;
      const attachment = await IOUAttachment.findByPk(id);
      if (!attachment) return res.status(404).json({ message: 'Attachment not found' });

      // access control: allow owner, iou requester, admin
      const iou = attachment.iou_id ? await IOURequest.findByPk(attachment.iou_id) : null;
      const isOwnerOrAdmin = actor.is_admin || String(attachment.uploaded_by) === String(actor.id) || (iou && String(iou.requester_id) === String(actor.id));
      if (!isOwnerOrAdmin) return res.status(403).json({ message: 'Forbidden' });

      const expiresMinutes = parseInt(process.env.AZURE_SAS_EXPIRES_MINUTES || '60', 10);

      // Try to generate SAS. If we don't have account key, generateBlobSAS will throw.
      try {
        const sasUrl = generateBlobSAS(attachment.blob_name, expiresMinutes);
        return res.json({ url: sasUrl, expires_in_minutes: expiresMinutes });
      } catch (err) {
        // If SAS generation is not available, attempt fallback to stored file_path
        console.warn('generateBlobSAS failed, falling back to stored file_path. Reason:', err.message || err);
        if (attachment.file_path) {
          // file_path may already contain a SAS token if you used a connection string with SAS during upload
          return res.json({ url: attachment.file_path, fallback: true });
        }
        // otherwise return informative error
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
 */
exports.deleteAttachment = [
  async (req, res) => {
    const t = await sequelize.transaction();
    try {
      const actor = req.currentUser;
      if (!actor) { await t.rollback(); return res.status(401).json({ message: 'Not authenticated' }); }

      const { id } = req.params;
      const attachment = await IOUAttachment.findByPk(id, { transaction: t });
      if (!attachment) { await t.rollback(); return res.status(404).json({ message: 'Attachment not found' }); }

      const iou = attachment.iou_id ? await IOURequest.findByPk(attachment.iou_id, { transaction: t }) : null;
      const allowed = actor.is_admin || String(attachment.uploaded_by) === String(actor.id) || (iou && String(iou.requester_id) === String(actor.id));
      if (!allowed) { await t.rollback(); return res.status(403).json({ message: 'Forbidden' }); }

      // Attempt to delete blob if possible; if deleteBlob throws because not configured, bubble up error
      try {
        const deleted = await deleteBlob(attachment.blob_name);
        await attachment.destroy({ transaction: t });

        await auditService.log({
          actorId: actor.id,
          actorName: actor.display_name || actor.username,
          action: 'DELETE_ATTACHMENT',
          entity: 'IOU_ATTACHMENT',
          entityId: id,
          details: { blob_name: attachment.blob_name, blob_deleted: deleted }
        });

        await t.commit();
        return res.json({ message: 'Attachment deleted', blob_deleted: deleted });
      } catch (err) {
        // if deleting blob not possible due to config, return informative error
        await t.rollback();
        console.error('deleteAttachment -> deleteBlob error', err);
        return res.status(500).json({
          message: 'Failed to delete blob from storage. Check Azure storage configuration (AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_ACCOUNT_KEY).',
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
