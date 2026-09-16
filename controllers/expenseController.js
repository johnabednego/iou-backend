// controllers/expenseController.js
const IOURequest = require('../models/IOURequest');
const ExpenseSubmission = require('../models/ExpenseSubmission');
const ReconciliationRecord = require('../models/ReconciliationRecord');
const Approval = require('../models/Approval');
const User = require('../models/User');
const Department = require('../models/Department');
const sequelize = require('../config/database');
const auditService = require('../services/auditService');
const notificationService = require('../services/notificationService');
const emailService = require('../services/emailService');
const FundBalance = require('../models/FundBalance');
const FundTransaction = require('../models/FundTransaction');
const { Op } = require('sequelize');

/**
 * POST /api/ious/:id/expense
 * Employee submits expense form
 * Req 8: Gated behind DISBURSEMENT_CONFIRMED status
 * Req 9: Attachments are required
 * Req 12: Goes to EXPENSE_PENDING_APPROVAL for finance approval
 */
exports.submitExpense = [
  async (req, res) => {
    const t = await sequelize.transaction();
    try {
      const actor = req.currentUser;
      if (!actor) { await t.rollback(); return res.status(401).json({ message: 'Not authenticated' }); }

      const { id } = req.params;
      const iou = await IOURequest.findByPk(id, { transaction: t });
      if (!iou) { await t.rollback(); return res.status(404).json({ message: 'IOU not found' }); }

      // Only requester or admin
      if (iou.requester_id !== actor.id && !actor.is_admin) {
        await t.rollback();
        return res.status(403).json({ message: 'Only the requester can submit expenses' });
      }

      // Req 8: Must be DISBURSEMENT_CONFIRMED (not just DISBURSED)
      if (!['DISBURSEMENT_CONFIRMED'].includes(iou.status) && !actor.is_admin) {
        await t.rollback();
        return res.status(400).json({ message: `Cannot submit expense for IOU in status ${iou.status}. You must confirm disbursement receipt first.` });
      }

      const { actual_amount, notes, attachments } = req.body;
      if (!actual_amount) { await t.rollback(); return res.status(400).json({ message: 'actual_amount is required' }); }

      // Req 9: Attachments are required
      if (!Array.isArray(attachments) || attachments.length === 0) {
        await t.rollback();
        return res.status(400).json({ message: 'At least one attachment (receipt/supporting document) is required for expense submission.' });
      }

      const deadline = new Date();
      deadline.setHours(deadline.getHours() + 48);

      const expense = await ExpenseSubmission.create({
        iou_id: iou.id,
        submitter_id: actor.id,
        actual_amount,
        status: 'SUBMITTED',
        submitted_at: new Date(),
        deadline,
        notes: notes || null,
        attachments: attachments || null
      }, { transaction: t });

      // Req 12: Status goes to EXPENSE_PENDING_APPROVAL for finance approval circle
      await iou.update({ status: 'EXPENSE_PENDING_APPROVAL' }, { transaction: t });

      await auditService.log({
        actorId: actor.id,
        actorName: actor.display_name || actor.username,
        action: 'SUBMIT_EXPENSE',
        entity: 'IOU',
        entityId: iou.id,
        details: { expense_id: expense.id, actual_amount, attachment_count: attachments.length }
      }, { transaction: t });

      // Notify cashiers to assign finance approvers
      const cashiers = await User.findAll({ where: { role: 'cashier', is_active: true }, transaction: t });
      const emailsToSend = [];
      for (const c of cashiers) {
        const note = await notificationService.createNotification({
          target_user_id: c.id,
          title: `Expense submitted: ${iou.request_number}`,
          body: `${actor.display_name || actor.username} submitted an expense for IOU ${iou.request_number}. Please assign finance approvers or review.`,
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
          } catch (err) { console.error('sendMail error:', err.message || err); }
        }
      })();

      return res.json({ message: 'Expense submitted successfully. Awaiting finance approval.', expense });
    } catch (err) {
      try { await t.rollback(); } catch (_) {}
      console.error('submitExpense error:', err.message);
      const msg = err.name === 'SequelizeDatabaseError'
        ? 'Database error while submitting expense. Please check your data and try again.'
        : 'Error submitting expense. Please try again.';
      return res.status(500).json({ message: msg });
    }
  }
];

/**
 * PUT /api/ious/:id/expense
 * Req 13: User edits a returned expense (update amount, notes, add/remove attachments)
 */
exports.updateExpense = [
  async (req, res) => {
    const t = await sequelize.transaction();
    try {
      const actor = req.currentUser;
      if (!actor) { await t.rollback(); return res.status(401).json({ message: 'Not authenticated' }); }

      const { id } = req.params;
      const iou = await IOURequest.findByPk(id, { transaction: t });
      if (!iou) { await t.rollback(); return res.status(404).json({ message: 'IOU not found' }); }

      // Only requester or admin
      if (iou.requester_id !== actor.id && !actor.is_admin) {
        await t.rollback();
        return res.status(403).json({ message: 'Only the requester can edit expenses' });
      }

      const expense = await ExpenseSubmission.findOne({ where: { iou_id: iou.id }, transaction: t });
      if (!expense) { await t.rollback(); return res.status(404).json({ message: 'No expense found for this IOU' }); }

      // Only allow editing when expense is RETURNED
      if (expense.status !== 'RETURNED' && !actor.is_admin) {
        await t.rollback();
        return res.status(400).json({ message: `Can only edit expenses in RETURNED status. Current status: ${expense.status}` });
      }

      const { actual_amount, notes, attachments } = req.body;

      const payload = {};
      if (actual_amount !== undefined) payload.actual_amount = actual_amount;
      if (notes !== undefined) payload.notes = notes;
      if (attachments !== undefined) {
        // Req 9: Attachments are still required on re-submit
        if (!Array.isArray(attachments) || attachments.length === 0) {
          await t.rollback();
          return res.status(400).json({ message: 'At least one attachment is required.' });
        }
        payload.attachments = attachments;
      }

      payload.status = 'SUBMITTED';
      payload.submitted_at = new Date();

      await expense.update(payload, { transaction: t });

      // Reset expense approvals
      await Approval.destroy({ where: { iou_id: iou.id, approval_type: 'expense' }, transaction: t });

      // Set IOU back to pending expense approval
      await iou.update({ status: 'EXPENSE_PENDING_APPROVAL' }, { transaction: t });

      await auditService.log({
        actorId: actor.id,
        actorName: actor.display_name || actor.username,
        action: 'UPDATE_EXPENSE',
        entity: 'IOU',
        entityId: iou.id,
        details: { expense_id: expense.id }
      }, { transaction: t });

      // Notify cashiers
      const cashiers = await User.findAll({ where: { role: 'cashier', is_active: true }, transaction: t });
      const emailsToSend = [];
      for (const c of cashiers) {
        const note = await notificationService.createNotification({
          target_user_id: c.id,
          title: `Expense re-submitted: ${iou.request_number}`,
          body: `${actor.display_name || actor.username} re-submitted the expense for IOU ${iou.request_number} after edits. Please review.`,
          link: `/ious/${iou.id}`,
          entity: 'IOU',
          entity_id: iou.id
        }, { transaction: t });
        emailsToSend.push({ note, target_user_id: c.id });
      }

      await t.commit();

      (async () => {
        for (const it of emailsToSend) {
          try {
            await emailService.sendNotificationEmailForUser(it.target_user_id, it.note.title, it.note.body, it.note.link);
          } catch (err) { console.error('sendMail error:', err.message || err); }
        }
      })();

      return res.json({ message: 'Expense updated and re-submitted', expense });
    } catch (err) {
      try { await t.rollback(); } catch (_) {}
      console.error('updateExpense error:', err.message);
      return res.status(500).json({ message: 'Error updating expense' });
    }
  }
];

/**
 * GET /api/ious/:id/expense
 * Get expense submission for an IOU
 * Req 10: Returns attachments data
 */
exports.getExpense = [
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor) return res.status(401).json({ message: 'Not authenticated' });

      const { id } = req.params;
      const expense = await ExpenseSubmission.findOne({
        where: { iou_id: id },
        include: [
          { model: User, as: 'submitter', attributes: ['id', 'display_name', 'username'] },
          { model: ReconciliationRecord, as: 'reconciliation' }
        ]
      });

      // Also fetch expense approvals
      let expenseApprovals = [];
      if (expense) {
        expenseApprovals = await Approval.findAll({
          where: { iou_id: id, approval_type: 'expense' },
          order: [['step_order', 'ASC']]
        });
      }

      // Fetch reconciliation record directly if not on expense
      let reconciliation = expense?.reconciliation || null;
      if (!reconciliation) {
        reconciliation = await ReconciliationRecord.findOne({ where: { iou_id: id } });
      }

      return res.json({ data: expense, expenseApprovals, reconciliation });
    } catch (err) {
      console.error('getExpense error:', err.message);
      return res.status(500).json({ message: 'Error fetching expense details.' });
    }
  }
];

/**
 * POST /api/ious/:id/expense/reject
 * Req 11: Reject an expense submission
 */
exports.rejectExpense = [
  async (req, res) => {
    const t = await sequelize.transaction();
    try {
      const actor = req.currentUser;
      if (!actor) { await t.rollback(); return res.status(401).json({ message: 'Not authenticated' }); }
      if (!actor.is_admin && actor.role !== 'cashier') {
        await t.rollback();
        return res.status(403).json({ message: 'Only cashier or admin can reject expenses' });
      }

      const { id } = req.params;
      const iou = await IOURequest.findByPk(id, { transaction: t });
      if (!iou) { await t.rollback(); return res.status(404).json({ message: 'IOU not found' }); }

      const expense = await ExpenseSubmission.findOne({ where: { iou_id: iou.id }, transaction: t });
      if (!expense) { await t.rollback(); return res.status(400).json({ message: 'No expense submission found' }); }

      if (expense.status === 'APPROVED') {
        await t.rollback();
        return res.status(400).json({ message: 'Cannot reject an expense that has already been approved.' });
      }

      if (!['SUBMITTED', 'PENDING_REVIEW'].includes(expense.status) && !actor.is_admin) {
        await t.rollback();
        return res.status(400).json({ message: `Cannot reject expense in status ${expense.status}` });
      }

      const { reason, comments } = req.body;

      await expense.update({ status: 'RETURNED', notes: comments || reason || expense.notes }, { transaction: t });
      await iou.update({ status: 'EXPENSE_RETURNED' }, { transaction: t });

      await auditService.log({
        actorId: actor.id,
        actorName: actor.display_name || actor.username,
        action: 'REJECT_EXPENSE',
        entity: 'IOU',
        entityId: iou.id,
        details: { expense_id: expense.id, reason: reason || comments }
      }, { transaction: t });

      // Notify requester
      const note = await notificationService.createNotification({
        target_user_id: iou.requester_id,
        title: `Expense Returned: ${iou.request_number}`,
        body: `Your expense for IOU ${iou.request_number} was returned by ${actor.display_name || actor.username}. Reason: ${reason || comments || 'No reason given'}. Please edit and re-submit.`,
        link: `/ious/${iou.id}`,
        entity: 'IOU',
        entity_id: iou.id
      }, { transaction: t });

      await t.commit();

      // Send email
      (async () => {
        try {
          await emailService.sendNotificationEmailForUser(iou.requester_id, note.title, note.body, note.link);
        } catch (err) { console.error('sendMail error:', err.message || err); }
      })();

      return res.json({ message: 'Expense rejected and returned to requester', expense });
    } catch (err) {
      try { await t.rollback(); } catch (_) {}
      console.error('rejectExpense error:', err.message);
      return res.status(500).json({ message: 'Error rejecting expense' });
    }
  }
];

/**
 * POST /api/ious/:id/expense/assign-approvers
 * Req 12: Cashier assigns finance approvers for expense approval circle
 */
exports.assignExpenseApprovers = [
  async (req, res) => {
    const t = await sequelize.transaction();
    const emailsToSend = [];
    try {
      const actor = req.currentUser;
      if (!actor) { await t.rollback(); return res.status(401).json({ message: 'Not authenticated' }); }
      if (!actor.is_admin && actor.role !== 'cashier') {
        await t.rollback();
        return res.status(403).json({ message: 'Only cashier or admin can assign expense approvers' });
      }

      const { id } = req.params;
      const { approvers } = req.body;
      const iou = await IOURequest.findByPk(id, { transaction: t });
      if (!iou) { await t.rollback(); return res.status(404).json({ message: 'IOU not found' }); }

      if (!Array.isArray(approvers) || approvers.length === 0) {
        await t.rollback();
        return res.status(400).json({ message: 'At least one approver is required' });
      }

      // Validation: no duplicate approver_id
      const ids = approvers.map(a => a.approver_id);
      if (new Set(ids).size !== ids.length) {
        await t.rollback();
        return res.status(400).json({ message: 'Duplicate approvers are not allowed' });
      }

      // Validation: Enforce that assigned approvers must be from Finance department, an Admin, or a Head of Department (HOD)
      for (const app of approvers) {
        const user = await User.findByPk(app.approver_id, { transaction: t });
        if (!user) {
          await t.rollback();
          return res.status(400).json({ message: `User not found` });
        }
        const isManagedApprover = user.is_approver === true;
        const isFinance = user.department && user.department.toLowerCase().includes('finance');
        const isAdmin = user.is_admin === true;
        const isHod = await Department.findOne({ where: { hod_user_id: user.id }, transaction: t }) || user.role === 'hod';

        if (!isManagedApprover && !isFinance && !isAdmin && !isHod) {
          await t.rollback();
          return res.status(400).json({
            message: `User ${user.display_name || user.username} cannot be assigned as an approver. Approvers must be added to the Approvers list, belong to the Finance department, be an Admin, or be a Head of Department.`
          });
        }
      }

      // Validation: no duplicate step_order
      const steps = approvers.map(a => a.step_order).filter(s => typeof s === 'number');
      if (new Set(steps).size !== steps.length && steps.length > 0) {
        await t.rollback();
        return res.status(400).json({ message: 'Duplicate step orders are not allowed' });
      }

      // Find existing approvals to keep decided ones
      const existingApprovals = await Approval.findAll({
        where: { iou_id: iou.id, approval_type: 'expense' },
        transaction: t
      });

      const decidedApprovals = existingApprovals.filter(a => a.decision !== 'PENDING');
      const maxDecidedStep = decidedApprovals.reduce((max, a) => Math.max(max, a.step_order), 0);

      // Keep decided approvals, delete pending approvals
      const keepIds = decidedApprovals.map(a => a.id);
      if (keepIds.length > 0) {
        await Approval.destroy({
          where: { iou_id: iou.id, approval_type: 'expense', id: { [Op.notIn]: keepIds } },
          transaction: t
        });
      } else {
        await Approval.destroy({
          where: { iou_id: iou.id, approval_type: 'expense' },
          transaction: t
        });
      }

      // Start step numbering after decided ones
      const startStep = maxDecidedStep + 1;

      // Filter out users already in decided approvals
      const alreadyDecidedIds = new Set(decidedApprovals.map(a => a.approver_id));
      const filteredApprovers = approvers.filter(a => !alreadyDecidedIds.has(a.approver_id));

      // Insert new pending approvals
      const rows = filteredApprovers.map((a, idx) => ({
        iou_id: iou.id,
        approver_id: a.approver_id,
        step_order: startStep + idx,
        decision: 'PENDING',
        approval_type: 'expense'
      }));
      const created = await Approval.bulkCreate(rows, { transaction: t });

      // Notify first approver
      if (created.length > 0) {
        const first = created.reduce((acc, cur) => (!acc || cur.step_order < acc.step_order) ? cur : acc, null);
        if (first) {
          const note = await notificationService.createNotification({
            target_user_id: first.approver_id,
            title: `Expense approval required: ${iou.request_number}`,
            body: `You have been requested to review the expense for IOU ${iou.request_number}.`,
            link: `/ious/${iou.id}`,
            entity: 'IOU',
            entity_id: iou.id
          }, { transaction: t });
          emailsToSend.push({ note, target_user_id: first.approver_id });
        }
      }

      await auditService.log({
        actorId: actor.id,
        actorName: actor.display_name || actor.username,
        action: 'ASSIGN_EXPENSE_APPROVERS',
        entity: 'IOU',
        entityId: iou.id,
        details: { approvers: rows }
      }, { transaction: t });

      await t.commit();

      (async () => {
        for (const it of emailsToSend) {
          try {
            await emailService.sendNotificationEmailForUser(it.target_user_id, it.note.title, it.note.body, it.note.link);
          } catch (err) { console.error('Email send error:', err); }
        }
      })();

      return res.json({ message: 'Expense approvers assigned', approvers: created });
    } catch (err) {
      try { await t.rollback(); } catch (_) {}
      console.error('assignExpenseApprovers error:', err);
      return res.status(500).json({ message: 'Error assigning expense approvers' });
    }
  }
];

/**
 * PUT /api/ious/:id/expense/approve/:approvalId
 * Req 12: Finance approver makes decision on expense approval
 */
exports.decideExpenseApproval = [
  async (req, res) => {
    const t = await sequelize.transaction();
    const emailsToSend = [];
    try {
      const actor = req.currentUser;
      if (!actor) { await t.rollback(); return res.status(401).json({ message: 'Not authenticated' }); }

      const { id, approvalId } = req.params;
      const { decision, comments } = req.body;

      if (!['APPROVED', 'REJECTED', 'RETURNED'].includes(decision)) {
        await t.rollback();
        return res.status(400).json({ message: 'Invalid decision. Must be APPROVED, REJECTED, or RETURNED.' });
      }

      const approval = await Approval.findByPk(approvalId, { transaction: t });
      if (!approval || approval.approval_type !== 'expense') {
        await t.rollback();
        return res.status(404).json({ message: 'Expense approval not found' });
      }

      // Ensure only assigned approver or admin
      if (String(approval.approver_id) !== String(actor.id) && !actor.is_admin) {
        await t.rollback();
        return res.status(403).json({ message: 'Only the assigned approver can decide' });
      }

      // Check sequence
      if (!actor.is_admin) {
        const earlierPending = await Approval.findOne({
          where: {
            iou_id: approval.iou_id,
            approval_type: 'expense',
            decision: 'PENDING',
            step_order: { [Op.lt]: approval.step_order }
          },
          transaction: t
        });
        if (earlierPending) {
          await t.rollback();
          return res.status(403).json({ message: 'Not your turn yet' });
        }
      }

      if (approval.decision !== 'PENDING') {
        await t.rollback();
        return res.status(400).json({ message: 'Approval already decided' });
      }

      approval.decision = decision;
      approval.comments = comments || null;
      approval.decision_at = new Date();
      await approval.save({ transaction: t });

      const iou = await IOURequest.findByPk(approval.iou_id, { transaction: t });
      if (!iou) { await t.rollback(); return res.status(500).json({ message: 'IOU not found' }); }

      const expense = await ExpenseSubmission.findOne({ where: { iou_id: iou.id }, transaction: t });

      if (decision === 'REJECTED' || decision === 'RETURNED') {
        // Return expense to user for editing
        if (expense) await expense.update({ status: 'RETURNED' }, { transaction: t });
        await iou.update({ status: 'EXPENSE_RETURNED' }, { transaction: t });

        const note = await notificationService.createNotification({
          target_user_id: iou.requester_id,
          title: `Expense ${decision}: ${iou.request_number}`,
          body: `Your expense for IOU ${iou.request_number} was ${decision.toLowerCase()} by ${actor.display_name || actor.username}. ${comments ? 'Comments: ' + comments : ''}`,
          link: `/ious/${iou.id}`,
          entity: 'IOU',
          entity_id: iou.id
        }, { transaction: t });
        emailsToSend.push({ note, target_user_id: iou.requester_id });

      } else if (decision === 'APPROVED') {
        // Check if there are more pending expense approvals
        const nextApproval = await Approval.findOne({
          where: {
            iou_id: iou.id,
            approval_type: 'expense',
            decision: 'PENDING',
            step_order: { [Op.gt]: approval.step_order }
          },
          order: [['step_order', 'ASC']],
          transaction: t
        });

        if (nextApproval) {
          // Notify next approver
          const note = await notificationService.createNotification({
            target_user_id: nextApproval.approver_id,
            title: `Expense approval required: ${iou.request_number}`,
            body: `You have been requested to review the expense for IOU ${iou.request_number}.`,
            link: `/ious/${iou.id}`,
            entity: 'IOU',
            entity_id: iou.id
          }, { transaction: t });
          emailsToSend.push({ note, target_user_id: nextApproval.approver_id });
        } else {
          // All expense approvals done - mark as EXPENSE_APPROVED
          if (expense) await expense.update({ status: 'APPROVED' }, { transaction: t });
          await iou.update({ status: 'EXPENSE_SUBMITTED' }, { transaction: t });

          // Notify requester and cashiers
          const note1 = await notificationService.createNotification({
            target_user_id: iou.requester_id,
            title: `Expense approved: ${iou.request_number}`,
            body: `Your expense for IOU ${iou.request_number} has been approved by finance. Cashier will reconcile.`,
            link: `/ious/${iou.id}`,
            entity: 'IOU',
            entity_id: iou.id
          }, { transaction: t });
          emailsToSend.push({ note: note1, target_user_id: iou.requester_id });

          const cashiers = await User.findAll({ where: { role: 'cashier', is_active: true }, transaction: t });
          for (const c of cashiers) {
            const note2 = await notificationService.createNotification({
              target_user_id: c.id,
              title: `Expense approved: ${iou.request_number}`,
              body: `Expense for IOU ${iou.request_number} has been approved by finance. Please reconcile.`,
              link: `/ious/${iou.id}`,
              entity: 'IOU',
              entity_id: iou.id
            }, { transaction: t });
            emailsToSend.push({ note: note2, target_user_id: c.id });
          }
        }
      }

      await auditService.log({
        actorId: actor.id,
        actorName: actor.display_name || actor.username,
        action: `EXPENSE_APPROVAL_${decision}`,
        entity: 'IOU',
        entityId: iou.id,
        details: { approval_id: approval.id, comments }
      }, { transaction: t });

      await t.commit();

      (async () => {
        for (const it of emailsToSend) {
          try {
            await emailService.sendNotificationEmailForUser(it.target_user_id, it.note.title, it.note.body, it.note.link);
          } catch (err) { console.error('Email send error:', err); }
        }
      })();

      return res.json({ message: 'Expense approval decision recorded', approval, iou_status: iou.status });
    } catch (err) {
      try { await t.rollback(); } catch (_) {}
      console.error('decideExpenseApproval error:', err);
      return res.status(500).json({ message: 'Error processing expense approval' });
    }
  }
];

/**
 * POST /api/ious/:id/reconcile
 * Cashier triggers reconciliation
 */
exports.reconcile = [
  async (req, res) => {
    const t = await sequelize.transaction();
    try {
      const actor = req.currentUser;
      if (!actor) { await t.rollback(); return res.status(401).json({ message: 'Not authenticated' }); }
      if (!actor.is_admin && actor.role !== 'cashier') {
        await t.rollback();
        return res.status(403).json({ message: 'Only cashier or admin can reconcile' });
      }

      const { id } = req.params;
      const iou = await IOURequest.findByPk(id, { transaction: t });
      if (!iou) { await t.rollback(); return res.status(404).json({ message: 'IOU not found' }); }

      if (iou.status !== 'EXPENSE_SUBMITTED' && !actor.is_admin) {
        await t.rollback();
        return res.status(400).json({ message: `Cannot reconcile IOU in status ${iou.status}. Must be EXPENSE_SUBMITTED.` });
      }

      const expense = await ExpenseSubmission.findOne({ where: { iou_id: iou.id }, transaction: t });
      if (!expense) { await t.rollback(); return res.status(400).json({ message: 'No expense submission found for this IOU.' }); }

      const estimated = parseFloat(iou.estimated_amount) || 0;
      const actual = parseFloat(expense.actual_amount) || 0;
      const diff = actual - estimated;

      let actionRequired = 'NONE';
      if (diff > 0) actionRequired = 'ADDITIONAL_APPROVAL';
      else if (diff < 0) actionRequired = 'REFUND';

      const { notes, ifs_voucher_number } = req.body;
      if (!ifs_voucher_number || !ifs_voucher_number.trim()) {
        await t.rollback();
        return res.status(400).json({ message: 'IFS Voucher Number is required for reconciliation.' });
      }

      const record = await ReconciliationRecord.create({
        expense_id: expense.id,
        iou_id: iou.id,
        estimated_amount: estimated,
        actual_amount: actual,
        diff_amount: diff,
        action_required: actionRequired,
        notes: notes || null,
        ifs_voucher_number: ifs_voucher_number.trim(),
        created_by: actor.id
      }, { transaction: t });

      // ─── Fund Balance Adjustment on Reconciliation ───
      const iouCurrency = (iou.currency || 'GHS').toUpperCase();
      if (diff !== 0) {
        const fundBalance = await FundBalance.findOne({ where: { currency: iouCurrency }, transaction: t });
        const currentAvailable = fundBalance ? Number(fundBalance.available_amount) : 0;
        let newBalance = currentAvailable;
        let txType = 'RECONCILIATION_ADJUSTMENT';
        let txNotes = '';

        if (diff > 0) {
          // Overspent: actual > estimated — deduct the overspent difference
          newBalance = currentAvailable - diff;
          txNotes = `Overspent reconciliation for IOU ${iou.request_number}: additional ${diff.toFixed(2)} ${iouCurrency} deducted`;
          // Allow negative balance (cashier will need to top up) — don't block reconciliation
        } else {
          // Underspent: actual < estimated — credit the underspent difference back
          const creditAmount = Math.abs(diff);
          newBalance = currentAvailable + creditAmount;
          txNotes = `Underspent reconciliation for IOU ${iou.request_number}: ${creditAmount.toFixed(2)} ${iouCurrency} credited back`;
        }

        if (fundBalance) {
          await fundBalance.update({
            available_amount: newBalance,
            last_updated_by: actor.id
          }, { transaction: t });
        }

        await FundTransaction.create({
          currency: iouCurrency,
          type: txType,
          amount: Math.abs(diff),
          balance_after: newBalance,
          reference_id: iou.id,
          performed_by: actor.id,
          notes: txNotes
        }, { transaction: t });
      }

      await expense.update({ status: 'RECONCILED' }, { transaction: t });
      await iou.update({ status: 'RECONCILED', ifs_voucher_number: ifs_voucher_number.trim() }, { transaction: t });

      await auditService.log({
        actorId: actor.id,
        actorName: actor.display_name || actor.username,
        action: 'RECONCILE_IOU',
        entity: 'IOU',
        entityId: iou.id,
        details: { record_id: record.id, diff_amount: diff, action_required: actionRequired }
      }, { transaction: t });

      // Notify requester
      const note = await notificationService.createNotification({
        target_user_id: iou.requester_id,
        title: `IOU Reconciled: ${iou.request_number}`,
        body: `Your IOU ${iou.request_number} has been reconciled. Difference: ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}. ${actionRequired === 'REFUND' ? 'You need to return excess funds.' : actionRequired === 'ADDITIONAL_APPROVAL' ? 'Additional amount needs approval.' : 'No further action needed.'} Please confirm redemption.`,
        link: `/ious/${iou.id}`,
        entity: 'IOU',
        entity_id: iou.id
      }, { transaction: t });

      await t.commit();

      // Send email async
      (async () => {
        try {
          await emailService.sendNotificationEmailForUser(iou.requester_id, note.title, note.body, note.link);
        } catch (err) { console.error('sendMail error:', err.message || err); }
      })();

      return res.json({ message: 'IOU reconciled successfully', record });
    } catch (err) {
      try { await t.rollback(); } catch (_) {}
      console.error('reconcile error:', err.name, err.message);
      const msg = err.name === 'SequelizeDatabaseError'
        ? 'Database error during reconciliation. The reconciliation table may need updating. Please contact admin.'
        : 'Error reconciling IOU. Please try again.';
      return res.status(500).json({ message: msg });
    }
  }
];

/**
/**
 * POST /api/ious/:id/redeem
 * Confirm reconciliation / redemption.
 * User (requester) must confirm first.
 * Cashier can only confirm after user has confirmed.
 */
exports.redeemIOU = [
  async (req, res) => {
    const t = await sequelize.transaction();
    const emailsToSend = [];
    try {
      const actor = req.currentUser;
      if (!actor) { await t.rollback(); return res.status(401).json({ message: 'Not authenticated' }); }

      const { id } = req.params;
      const iou = await IOURequest.findByPk(id, { transaction: t });
      if (!iou) { await t.rollback(); return res.status(404).json({ message: 'IOU not found' }); }

      const isOwner = String(iou.requester_id) === String(actor.id);
      const isCashier = actor.is_admin || actor.role === 'cashier';
      if (!isOwner && !isCashier) {
        await t.rollback();
        return res.status(403).json({ message: 'Only the IOU owner or cashier can confirm reconciliation' });
      }

      if (iou.status !== 'RECONCILED') {
        await t.rollback();
        return res.status(400).json({ message: `Cannot confirm reconciliation for IOU in status ${iou.status}. Must be RECONCILED first.` });
      }

      const reconciliation = await ReconciliationRecord.findOne({
        where: { iou_id: iou.id },
        order: [['created_at', 'DESC']],
        transaction: t
      });
      if (!reconciliation) {
        await t.rollback();
        return res.status(404).json({ message: 'Reconciliation record not found for this IOU.' });
      }

      const { targetRole, notes } = req.body;

      // Determine which role is confirming:
      // If targetRole is explicitly 'user' or if actor is owner and user hasn't confirmed yet (and not explicitly asking to act as cashier)
      const userConfirming = (targetRole === 'user') || (isOwner && !reconciliation.confirmed_by_user && targetRole !== 'cashier');

      if (userConfirming) {
        if (!isOwner && !actor.is_admin) {
          await t.rollback();
          return res.status(403).json({ message: 'Only the requester can confirm on behalf of the user.' });
        }
        if (reconciliation.confirmed_by_user) {
          await t.rollback();
          return res.status(400).json({ message: 'Reconciliation has already been confirmed by the user.' });
        }

        await reconciliation.update({
          confirmed_by_user: true,
          user_confirmed_at: new Date(),
          notes: notes ? (reconciliation.notes ? `${reconciliation.notes}\nUser note: ${notes}` : notes) : reconciliation.notes
        }, { transaction: t });

        await auditService.log({
          actorId: actor.id,
          actorName: actor.display_name || actor.username,
          action: 'CONFIRM_RECONCILIATION_USER',
          entity: 'IOU',
          entityId: iou.id,
          details: { notes: notes || null }
        }, { transaction: t });

        // Notify cashiers that user has confirmed
        const cashiers = await User.findAll({ where: { role: 'cashier', is_active: true }, transaction: t });
        for (const c of cashiers) {
          const note = await notificationService.createNotification({
            target_user_id: c.id,
            title: `Reconciliation Confirmed by User: ${iou.request_number}`,
            body: `${actor.display_name || actor.username} confirmed the reconciliation for IOU ${iou.request_number}. Cashier confirmation is now required.`,
            link: `/ious/${iou.id}`,
            entity: 'IOU',
            entity_id: iou.id
          }, { transaction: t });
          emailsToSend.push({ note, target_user_id: c.id });
        }

        await t.commit();

        (async () => {
          for (const it of emailsToSend) {
            try {
              await emailService.sendNotificationEmailForUser(it.target_user_id, it.note.title, it.note.body, it.note.link);
            } catch (err) { console.error('sendMail error:', err.message || err); }
          }
        })();

        return res.json({ message: 'Reconciliation confirmed by requester. Awaiting cashier confirmation.', reconciliation });

      } else {
        // Cashier confirming
        if (!isCashier) {
          await t.rollback();
          return res.status(403).json({ message: 'Only a cashier or admin can perform cashier confirmation.' });
        }

        // CRITICAL RULE: Cashier CANNOT confirm if user has not confirmed yet!
        if (!reconciliation.confirmed_by_user) {
          await t.rollback();
          return res.status(400).json({ message: 'The user has to confirm the reconciliation first before the cashier can confirm.' });
        }

        if (reconciliation.confirmed_by_cashier) {
          await t.rollback();
          return res.status(400).json({ message: 'Reconciliation has already been confirmed by the cashier.' });
        }

        await reconciliation.update({
          confirmed_by_cashier: true,
          cashier_confirmed_at: new Date(),
          notes: notes ? (reconciliation.notes ? `${reconciliation.notes}\nCashier note: ${notes}` : notes) : reconciliation.notes
        }, { transaction: t });

        // Update IOU status to REDEEMED
        await iou.update({ status: 'REDEEMED' }, { transaction: t });

        await auditService.log({
          actorId: actor.id,
          actorName: actor.display_name || actor.username,
          action: 'REDEEM_IOU',
          entity: 'IOU',
          entityId: iou.id,
          details: { notes: notes || null, redeemed_by: 'cashier' }
        }, { transaction: t });

        // Notify requester that cashier confirmed and IOU is fully redeemed
        const note = await notificationService.createNotification({
          target_user_id: iou.requester_id,
          title: `IOU Fully Redeemed: ${iou.request_number}`,
          body: `IOU ${iou.request_number} reconciliation has been confirmed by cashier ${actor.display_name || actor.username} and marked as fully redeemed.`,
          link: `/ious/${iou.id}`,
          entity: 'IOU',
          entity_id: iou.id
        }, { transaction: t });
        emailsToSend.push({ note, target_user_id: iou.requester_id });

        await t.commit();

        (async () => {
          for (const it of emailsToSend) {
            try {
              await emailService.sendNotificationEmailForUser(it.target_user_id, it.note.title, it.note.body, it.note.link);
            } catch (err) { console.error('sendMail error:', err.message || err); }
          }
        })();

        return res.json({ message: 'Reconciliation confirmed by cashier. IOU marked as redeemed.', reconciliation });
      }
    } catch (err) {
      try { await t.rollback(); } catch (_) {}
      console.error('redeemIOU error details:', err);
      const userMsg = err.message || 'Error confirming reconciliation. Please try again.';
      return res.status(500).json({ message: userMsg });
    }
  }
];
