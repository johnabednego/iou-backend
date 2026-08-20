// controllers/approvalController.js
const { Op } = require('sequelize');
const Approval = require('../models/Approval');
const IOURequest = require('../models/IOURequest');
const sequelize = require('../config/database');
const auditService = require('../services/auditService');
const notificationService = require('../services/notificationService');
const emailService = require('../services/emailService');
const User = require('../models/User');
const ExpenseSubmission = require('../models/ExpenseSubmission');

/**
 * PUT /api/approvals/:id
 * Approver makes decision on a given approval record
 * body: { decision: 'APPROVED'|'REJECTED'|'RETURNED', comments: string }
 *
 * Workflow:
 * - APPROVED: Notify next pending approver (if any) + always notify Cashiers.
 *   If no more pending, notify Cashiers that all approvals are complete.
 *   Status remains PENDING until Cashier confirms.
 * - RETURNED: Notify requester + all previous approvers. IOU -> RETURNED (editable).
 * - REJECTED: Notify requester + all previous approvers. IOU -> REJECTED (final).
 */
exports.decideApproval = [
  async (req, res) => {
    const t = await sequelize.transaction();
    const emailsToSend = [];
    try {
      const actor = req.currentUser;
      if (!actor) { await t.rollback(); return res.status(401).json({ message: 'Not authenticated' }); }

      const { id } = req.params;
      const { decision, comments } = req.body;
      if (!['APPROVED','REJECTED','RETURNED'].includes(decision)) { await t.rollback(); return res.status(400).json({ message: 'Invalid decision' }); }

      const approval = await Approval.findByPk(id, { transaction: t });
      if (!approval) { await t.rollback(); return res.status(404).json({ message: 'Approval not found' }); }

      // ensure only assigned approver (or admin) can act
      if (String(approval.approver_id) !== String(actor.id) && !actor.is_admin) {
        await t.rollback();
        return res.status(403).json({ message: 'Forbidden: only assigned approver or admin can decide' });
      }

      // Prevent approving out of sequence: there must be no earlier pending approvals of the same type
      const earlierPending = await Approval.findOne({
        where: {
          iou_id: approval.iou_id,
          approval_type: approval.approval_type || 'iou',
          decision: 'PENDING',
          step_order: { [Op.lt]: approval.step_order }
        },
        transaction: t
      });
      if (earlierPending) {
        await t.rollback();
        return res.status(403).json({ message: 'Not your turn to approve yet. Previous approval steps are still pending.' });
      }

      if (approval.decision !== 'PENDING') { await t.rollback(); return res.status(400).json({ message: 'Approval already decided' }); }

      // Record decision
      approval.decision = decision;
      approval.comments = comments || null;
      approval.decision_at = new Date();
      await approval.save({ transaction: t });

      // When RETURNED or REJECTED: immediately cancel all downstream PENDING approvals.
      // This prevents any subsequent approver from seeing or acting on this IOU
      // while it is returned/rejected. Fresh records are created on re-submission.
      if (decision === 'REJECTED' || decision === 'RETURNED') {
        await Approval.destroy({
          where: {
            iou_id: approval.iou_id,
            approval_type: approval.approval_type || 'iou',
            decision: 'PENDING',
            step_order: { [Op.gt]: approval.step_order }
          },
          transaction: t
        });
      }

      // Load IOU
      const iou = await IOURequest.findByPk(approval.iou_id, { transaction: t });
      if (!iou) { await t.rollback(); return res.status(500).json({ message: 'Linked IOU not found' }); }

      // Helper: get all previous approvers who already approved (for return/reject notifications)
      async function getPreviousApprovedUsers() {
        const previousApprovals = await Approval.findAll({
          where: {
            iou_id: iou.id,
            approval_type: approval.approval_type || 'iou',
            decision: 'APPROVED',
            id: { [Op.ne]: approval.id }
          },
          transaction: t
        });
        return previousApprovals.map(a => a.approver_id).filter(Boolean);
      }

      // Helper: notify cashiers/admins
      async function notifyCashiers(title, body) {
        let targets = await User.findAll({ where: { role: 'cashier', is_active: true }, transaction: t });
        if (!targets || targets.length === 0) {
          targets = await User.findAll({ where: { is_admin: true, is_active: true }, transaction: t });
        }
        for (const u of targets) {
          const note = await notificationService.createNotification({
            target_user_id: u.id,
            title,
            body,
            link: `/ious/${iou.id}`,
            entity: 'IOU',
            entity_id: iou.id
          }, { transaction: t });
          emailsToSend.push({ note, target_user_id: u.id });
        }
      }

      // Decision outcomes & notification creation
      if (decision === 'REJECTED') {
        if (approval.approval_type === 'expense') {
          const expense = await ExpenseSubmission.findOne({ where: { iou_id: iou.id }, transaction: t });
          if (expense) await expense.update({ status: 'RETURNED' }, { transaction: t });
          await iou.update({ status: 'EXPENSE_RETURNED' }, { transaction: t });

          // Notify requester
          const note = await notificationService.createNotification({
            target_user_id: iou.requester_id,
            title: `Expense Rejected: ${iou.request_number}`,
            body: `Your expense for IOU ${iou.request_number} was rejected by ${actor.display_name || actor.username}.${comments ? ' Reason: ' + comments : ''} Please edit and re-submit.`,
            link: `/ious/${iou.id}`,
            entity: 'IOU',
            entity_id: iou.id
          }, { transaction: t });
          emailsToSend.push({ note, target_user_id: iou.requester_id });

          // Also notify cashiers
          await notifyCashiers(
            `Expense Rejected: ${iou.request_number}`,
            `Expense for IOU ${iou.request_number} was rejected by ${actor.display_name || actor.username}.`
          );
        } else {
          await iou.update({ status: 'REJECTED' }, { transaction: t });

          // Notify requester
          const note = await notificationService.createNotification({
            target_user_id: iou.requester_id,
            title: `IOU Rejected: ${iou.request_number}`,
            body: `Your IOU ${iou.request_number} was rejected by ${actor.display_name || actor.username}.${comments ? ' Reason: ' + comments : ''}`,
            link: `/ious/${iou.id}`,
            entity: 'IOU',
            entity_id: iou.id
          }, { transaction: t });
          emailsToSend.push({ note, target_user_id: iou.requester_id });

          // Notify all previous approvers who already approved
          const prevApproverIds = await getPreviousApprovedUsers();
          for (const uid of prevApproverIds) {
            const pNote = await notificationService.createNotification({
              target_user_id: uid,
              title: `IOU Rejected: ${iou.request_number}`,
              body: `IOU ${iou.request_number} which you approved has been rejected by ${actor.display_name || actor.username}.${comments ? ' Reason: ' + comments : ''}`,
              link: `/ious/${iou.id}`,
              entity: 'IOU',
              entity_id: iou.id
            }, { transaction: t });
            emailsToSend.push({ note: pNote, target_user_id: uid });
          }

          // Also notify cashiers
          await notifyCashiers(
            `IOU Rejected: ${iou.request_number}`,
            `IOU ${iou.request_number} was rejected by ${actor.display_name || actor.username}.`
          );
        }

      } else if (decision === 'RETURNED') {
        if (approval.approval_type === 'expense') {
          const expense = await ExpenseSubmission.findOne({ where: { iou_id: iou.id }, transaction: t });
          if (expense) await expense.update({ status: 'RETURNED' }, { transaction: t });
          await iou.update({ status: 'EXPENSE_RETURNED' }, { transaction: t });

          // Notify requester
          const note = await notificationService.createNotification({
            target_user_id: iou.requester_id,
            title: `Expense Returned: ${iou.request_number}`,
            body: `Your expense for IOU ${iou.request_number} was returned by ${actor.display_name || actor.username}.${comments ? ' Reason: ' + comments : ''} Please edit and re-submit.`,
            link: `/ious/${iou.id}`,
            entity: 'IOU',
            entity_id: iou.id
          }, { transaction: t });
          emailsToSend.push({ note, target_user_id: iou.requester_id });

          // Also notify cashiers
          await notifyCashiers(
            `Expense Returned: ${iou.request_number}`,
            `Expense for IOU ${iou.request_number} was returned by ${actor.display_name || actor.username}.`
          );
        } else {
          await iou.update({ status: 'RETURNED' }, { transaction: t });

          // Notify requester
          const note = await notificationService.createNotification({
            target_user_id: iou.requester_id,
            title: `IOU Returned for Edits: ${iou.request_number}`,
            body: `Your IOU ${iou.request_number} was returned for changes by ${actor.display_name || actor.username}.${comments ? ' Reason: ' + comments : ''} Please edit and re-submit.`,
            link: `/ious/${iou.id}`,
            entity: 'IOU',
            entity_id: iou.id
          }, { transaction: t });
          emailsToSend.push({ note, target_user_id: iou.requester_id });

          // Notify all previous approvers who already approved
          const prevApproverIds = await getPreviousApprovedUsers();
          for (const uid of prevApproverIds) {
            const pNote = await notificationService.createNotification({
              target_user_id: uid,
              title: `IOU Returned: ${iou.request_number}`,
              body: `IOU ${iou.request_number} which you approved has been returned for edits by ${actor.display_name || actor.username}.${comments ? ' Reason: ' + comments : ''}`,
              link: `/ious/${iou.id}`,
              entity: 'IOU',
              entity_id: iou.id
            }, { transaction: t });
            emailsToSend.push({ note: pNote, target_user_id: uid });
          }

          // Also notify cashiers
          await notifyCashiers(
            `IOU Returned: ${iou.request_number}`,
            `IOU ${iou.request_number} was returned for edits by ${actor.display_name || actor.username}.`
          );
        }

      } else if (decision === 'APPROVED') {
        // Find if there are ANY remaining pending approvals of this type (excluding the current one we just saved as APPROVED)
        const remainingPending = await Approval.findOne({
          where: {
            iou_id: iou.id,
            approval_type: approval.approval_type || 'iou',
            decision: 'PENDING'
          },
          transaction: t
        });

        if (remainingPending) {
          // Find next pending approver in sequence
          const nextApproval = await Approval.findOne({
            where: {
              iou_id: iou.id,
              approval_type: approval.approval_type || 'iou',
              decision: 'PENDING',
              step_order: { [Op.gt]: approval.step_order }
            },
            order: [['step_order', 'ASC']],
            transaction: t
          });

          if (nextApproval) {
            // Email the NEXT approver in sequence
            const note = await notificationService.createNotification({
              target_user_id: nextApproval.approver_id,
              title: `${approval.approval_type === 'expense' ? 'Expense approval' : 'Approval'} required: ${iou.request_number}`,
              body: `Step ${approval.step_order} has been approved by ${actor.display_name || actor.username}. It is now your turn to review IOU ${iou.request_number}.`,
              link: `/ious/${iou.id}`,
              entity: 'IOU',
              entity_id: iou.id
            }, { transaction: t });
            emailsToSend.push({ note, target_user_id: nextApproval.approver_id });
          }

          // Also notify cashiers that this step was approved
          await notifyCashiers(
            `Step ${approval.step_order} approved by ${actor.display_name || actor.username}: ${iou.request_number}`,
            `${actor.display_name || actor.username} approved Step ${approval.step_order} for IOU ${iou.request_number}.`
          );

          // Also notify requester that this step was approved
          const requesterNote = await notificationService.createNotification({
            target_user_id: iou.requester_id,
            title: `Step ${approval.step_order} approved: ${iou.request_number}`,
            body: `Step ${approval.step_order} has been approved by ${actor.display_name || actor.username} for your IOU ${iou.request_number}.`,
            link: `/ious/${iou.id}`,
            entity: 'IOU',
            entity_id: iou.id
          }, { transaction: t });
          emailsToSend.push({ note: requesterNote, target_user_id: iou.requester_id });

        } else {
          // No more pending approvals
          if (approval.approval_type === 'expense') {
            const expense = await ExpenseSubmission.findOne({ where: { iou_id: iou.id }, transaction: t });
            if (expense) await expense.update({ status: 'APPROVED' }, { transaction: t });
            await iou.update({ status: 'EXPENSE_SUBMITTED' }, { transaction: t });

            // Notify requester
            const note1 = await notificationService.createNotification({
              target_user_id: iou.requester_id,
              title: `Expense approved: ${iou.request_number}`,
              body: `Your expense for IOU ${iou.request_number} has been approved by finance. Cashier will reconcile.`,
              link: `/ious/${iou.id}`,
              entity: 'IOU',
              entity_id: iou.id
            }, { transaction: t });
            emailsToSend.push({ note: note1, target_user_id: iou.requester_id });

            // Notify cashiers
            await notifyCashiers(
              `Expense approved: ${iou.request_number}`,
              `Expense for IOU ${iou.request_number} has been approved by finance. Please reconcile.`
            );
          } else {
            // No more pending approvals - notify cashiers to Confirm Approval
            // Status stays PENDING until Cashier explicitly confirms
            await notifyCashiers(
              `All approvals complete - confirm: ${iou.request_number}`,
              `All assigned approvers have approved IOU ${iou.request_number}. Please review and click "Confirm Approval" to proceed to disbursement.`
            );

            // Also notify requester that all approvals passed (but not yet final)
            const note = await notificationService.createNotification({
              target_user_id: iou.requester_id,
              title: `IOU Approvals Complete: ${iou.request_number}`,
              body: `All assigned approvers have approved your IOU ${iou.request_number}. Awaiting final confirmation from the Cashier.`,
              link: `/ious/${iou.id}`,
              entity: 'IOU',
              entity_id: iou.id
            }, { transaction: t });
            emailsToSend.push({ note, target_user_id: iou.requester_id });
          }
        }
      }

      // Audit the approval decision
      await auditService.log({
        actorId: actor.id,
        actorName: actor.display_name || actor.username,
        action: `APPROVAL_${decision}`,
        entity: 'APPROVAL',
        entityId: approval.id,
        details: { iou_id: iou.id, comments }
      });

      // commit transaction first
      await t.commit();

      // After commit: send emails (async, do not block response)
      (async () => {
        for (const item of emailsToSend) {
          try {
            // Use flat values from the item directly to avoid stale Sequelize instance refs
            const title = item.title || item.note?.title;
            const body  = item.body  || item.note?.body;
            const link  = item.link  || item.note?.link;
            await emailService.sendNotificationEmailForUser(item.target_user_id, title, body, link);
          } catch (err) {
            console.error('Error sending notification email for approval decision', err);
          }
        }
      })();

      return res.json({ message: 'Decision recorded', approval, iou_status: iou.status });
    } catch (err) {
      try { await t.rollback(); } catch (_) {}
      console.error('decideApproval error', err);
      return res.status(500).json({ message: 'Error recording decision' });
    }
  }
];


/**
 * GET /api/approvals/mine
 * List pending approvals assigned to the current user
 */

exports.listMine = [
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor) return res.status(401).json({ message: 'Not authenticated' });

      const approvals = await Approval.findAll({
        where: { approver_id: actor.id, decision: 'PENDING' },
        order: [['created_at','DESC']],
        include: [
          { model: IOURequest, as: 'iou', include: [{ model: User, as: 'requester', attributes: ['id','display_name','username'] }] }
        ]
      });

      // Filter out approvals that are not yet active (an earlier step is still pending)
      const activeApprovals = [];
      for (const app of approvals) {
        const earlierPending = await Approval.findOne({
          where: {
            iou_id: app.iou_id,
            approval_type: app.approval_type || 'iou',
            decision: 'PENDING',
            step_order: { [Op.lt]: app.step_order }
          }
        });
        if (!earlierPending) {
          activeApprovals.push(app);
        }
      }

      return res.json({ data: activeApprovals });
    } catch (err) {
      console.error('listMine', err);
      return res.status(500).json({ message: 'Error fetching approvals' });
    }
  }
];
