// controllers/disbursementController.js
const IOURequest = require('../models/IOURequest');
const Disbursement = require('../models/Disbursement');
const User = require('../models/User');
const sequelize = require('../config/database');
const auditService = require('../services/auditService');
const notificationService = require('../services/notificationService');
const emailService = require('../services/emailService');

/**
 * POST /api/ious/:id/disburse
 * Cashier records disbursement, updates IOU status to DISBURSED
 */
exports.disburse = [
  async (req, res) => {
    const t = await sequelize.transaction();
    try {
      const actor = req.currentUser;
      if (!actor) { await t.rollback(); return res.status(401).json({ message: 'Not authenticated' }); }
      if (!actor.is_admin && actor.role !== 'cashier') { await t.rollback(); return res.status(403).json({ message: 'Only cashier or admin can disburse' }); }

      const { id } = req.params;
      const iou = await IOURequest.findByPk(id, { transaction: t });
      if (!iou) { await t.rollback(); return res.status(404).json({ message: 'IOU not found' }); }

      if (iou.status !== 'APPROVED_FOR_DISBURSEMENT' && !actor.is_admin) {
        await t.rollback();
        return res.status(400).json({ message: `Cannot disburse IOU in status ${iou.status}` });
      }

      const { amount, payment_method, payment_reference, notes } = req.body;
      if (!amount) { await t.rollback(); return res.status(400).json({ message: 'amount is required' }); }

      const disbursement = await Disbursement.create({
        iou_id: iou.id,
        cashier_id: actor.id,
        amount,
        payment_method: payment_method || null,
        payment_reference: payment_reference || null,
        disbursed_at: new Date(),
        notes: notes || null
      }, { transaction: t });

      await iou.update({ status: 'DISBURSED' }, { transaction: t });

      await auditService.log({
        actorId: actor.id,
        actorName: actor.display_name || actor.username,
        action: 'DISBURSE_IOU',
        entity: 'IOU',
        entityId: iou.id,
        details: { disbursement_id: disbursement.id, amount, payment_method }
      }, { transaction: t });

      // Notify requester
      const note = await notificationService.createNotification({
        target_user_id: iou.requester_id,
        title: `IOU Disbursed: ${iou.request_number}`,
        body: `Your IOU ${iou.request_number} has been disbursed. Please confirm receipt of funds.`,
        link: `/ious/${iou.id}`,
        entity: 'IOU',
        entity_id: iou.id
      }, { transaction: t });

      await t.commit();

      // Send email async
      (async () => {
        try {
          await emailService.sendNotificationEmailForUser(iou.requester_id, note.title, note.body, note.link);
        } catch (err) {
          console.error('Email send error for disburse', err);
        }
      })();

      return res.json({ message: 'IOU disbursed', disbursement, iou_status: 'DISBURSED' });
    } catch (err) {
      try { await t.rollback(); } catch (_) {}
      console.error('disburse error', err);
      return res.status(500).json({ message: 'Error disbursing IOU' });
    }
  }
];

/**
 * POST /api/ious/:id/confirm-disbursement
 * Req 7: User confirms receipt of disbursed funds.
 * Changes IOU status from DISBURSED -> DISBURSEMENT_CONFIRMED.
 */
exports.confirmDisbursement = [
  async (req, res) => {
    const t = await sequelize.transaction();
    try {
      const actor = req.currentUser;
      if (!actor) { await t.rollback(); return res.status(401).json({ message: 'Not authenticated' }); }

      const { id } = req.params;
      const iou = await IOURequest.findByPk(id, { transaction: t });
      if (!iou) { await t.rollback(); return res.status(404).json({ message: 'IOU not found' }); }

      // Only the requester can confirm
      if (iou.requester_id !== actor.id && !actor.is_admin) {
        await t.rollback();
        return res.status(403).json({ message: 'Only the IOU requester can confirm disbursement receipt' });
      }

      if (iou.status !== 'DISBURSED') {
        await t.rollback();
        return res.status(400).json({ message: `Cannot confirm disbursement for IOU in status ${iou.status}. Must be DISBURSED.` });
      }

      // Update the disbursement record
      const disbursement = await Disbursement.findOne({
        where: { iou_id: iou.id },
        order: [['disbursed_at', 'DESC']],
        transaction: t
      });

      if (disbursement) {
        await disbursement.update({
          confirmed_by_user: true,
          confirmed_at: new Date()
        }, { transaction: t });
      }

      // Update IOU status
      await iou.update({ status: 'DISBURSEMENT_CONFIRMED' }, { transaction: t });

      await auditService.log({
        actorId: actor.id,
        actorName: actor.display_name || actor.username,
        action: 'CONFIRM_DISBURSEMENT',
        entity: 'IOU',
        entityId: iou.id,
        details: { disbursement_id: disbursement?.id }
      }, { transaction: t });

      // Notify cashiers
      const cashiers = await User.findAll({ where: { role: 'cashier', is_active: true }, transaction: t });
      const emailsToSend = [];
      for (const c of cashiers) {
        const note = await notificationService.createNotification({
          target_user_id: c.id,
          title: `Disbursement confirmed: ${iou.request_number}`,
          body: `${actor.display_name || actor.username} confirmed receipt of funds for IOU ${iou.request_number}.`,
          link: `/ious/${iou.id}`,
          entity: 'IOU',
          entity_id: iou.id
        }, { transaction: t });
        emailsToSend.push({ note, target_user_id: c.id });
      }

      await t.commit();

      // Send emails async
      (async () => {
        for (const it of emailsToSend) {
          try {
            await emailService.sendNotificationEmailForUser(it.target_user_id, it.note.title, it.note.body, it.note.link);
          } catch (err) {
            console.error('Email send error for confirmDisbursement', err);
          }
        }
      })();

      return res.json({ message: 'Disbursement receipt confirmed', iou_status: 'DISBURSEMENT_CONFIRMED' });
    } catch (err) {
      try { await t.rollback(); } catch (_) {}
      console.error('confirmDisbursement error', err);
      return res.status(500).json({ message: 'Error confirming disbursement' });
    }
  }
];

/**
 * GET /api/ious/:id/disbursements
 * List disbursements for an IOU
 */
exports.getDisbursements = [
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor) return res.status(401).json({ message: 'Not authenticated' });

      const { id } = req.params;
      const disbursements = await Disbursement.findAll({
        where: { iou_id: id },
        include: [{ model: User, as: 'cashier', attributes: ['id', 'display_name', 'username'] }],
        order: [['disbursed_at', 'DESC']]
      });

      return res.json({ data: disbursements });
    } catch (err) {
      console.error('getDisbursements error', err);
      return res.status(500).json({ message: 'Error fetching disbursements' });
    }
  }
];
