// controllers/iouController.js
const IOURequest = require('../models/IOURequest');
const IOUAttachment = require('../models/IOUAttachment');
const Approval = require('../models/Approval');
const User = require('../models/User');
const Department = require('../models/Department');
const ReconciliationRecord = require('../models/ReconciliationRecord');
const ExpenseSubmission = require('../models/ExpenseSubmission');
const sequelize = require('../config/database');
const auditService = require('../services/auditService');
const notificationService = require('../services/notificationService');
const emailService = require('../services/emailService');
const FundBalance = require('../models/FundBalance');
const { Op } = require('sequelize');


/**
 * Helper: generate request number
 * Format: IOU-YYYYMMDD-HHMMSS-<random4>
 */
function generateRequestNumber() {
  const d = new Date();
  const ts = d.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  const rand = Math.floor(Math.random() * 9000) + 1000;
  return `IOU-${ts}-${rand}`;
}

/**
 * POST /api/ious
 * Create IOU (DRAFT) - now transactional and notifies cashiers/admins
 */
exports.createIOU = [
  async (req, res) => {
    const t = await sequelize.transaction();
    const emailsToSend = [];
    try {
      const actor = req.currentUser;
      if (!actor) { await t.rollback(); return res.status(401).json({ message: 'Not authenticated' }); }

      const { purpose, estimated_amount, currency, attachments } = req.body;

      // Fund sufficiency check
      const iouCurrency = (currency || 'GHS').toUpperCase().trim();
      if (estimated_amount && Number(estimated_amount) > 0) {
        const fundBalance = await FundBalance.findOne({ where: { currency: iouCurrency }, transaction: t });
        const available = fundBalance ? Number(fundBalance.available_amount) : 0;
        if (available < Number(estimated_amount)) {
          await t.rollback();
          return res.status(400).json({
            message: 'Insufficient funds available for this currency. Please contact the Finance Department.'
          });
        }
      }

      const iou = await IOURequest.create({
        request_number: generateRequestNumber(),
        requester_id: actor.id,
        department: actor.department || null,
        purpose: purpose || null,
        estimated_amount: estimated_amount || null,
        currency: iouCurrency,
        status: 'DRAFT'
      }, { transaction: t });

      if (Array.isArray(attachments) && attachments.length) {
        // attachments should be { file_name, blob_name, file_path, content_type, size }
        const rows = attachments.map(a => ({
          iou_id: iou.id,
          file_name: a.file_name,
          blob_name: a.blob_name,
          file_path: a.file_path,
          content_type: a.content_type || null,
          size: a.size || null,
          uploaded_by: actor.id
        }));
        await IOUAttachment.bulkCreate(rows, { transaction: t });
      }

      // Audit
      await auditService.log({
        actorId: actor.id,
        actorName: actor.display_name || actor.username,
        action: 'CREATE_IOU',
        entity: 'IOU',
        entityId: iou.id,
        details: { request_number: iou.request_number, department: iou.department }
      }, { transaction: t });

      // Notify cashiers (or admins if none)
      // let targets = await User.findAll({ where: { role: 'cashier', is_active: true }, transaction: t });
      // if (!targets || targets.length === 0) {
      //   targets = await User.findAll({ where: { is_admin: true, is_active: true }, transaction: t });
      // }

      // for (const u of targets) {
      //   const emailTitle = `New IOU Request: ${iou.request_number}`;
      //   const emailBody = `${actor.display_name || actor.username} has created a new IOU request (${iou.request_number}).\nPurpose: ${iou.purpose || 'N/A'}\nAmount: ${iou.currency} ${iou.estimated_amount || 'N/A'}\n\nPlease review and assign approvers.`;
      //   const emailLink = `/ious/${iou.id}`;

      //   // Create in-app notification (inside transaction)
      //   await notificationService.createNotification({
      //     target_user_id: u.id,
      //     title: emailTitle,
      //     body: emailBody,
      //     link: emailLink,
      //     entity: 'IOU',
      //     entity_id: iou.id
      //   }, { transaction: t });

      //   // Queue email to send after commit (flat values - no reference to Sequelize instance)
      //   emailsToSend.push({ target_user_id: u.id, title: emailTitle, body: emailBody, link: emailLink });
      // }

      await t.commit();

      // // Send emails async after commit (log errors, do not block response)
      // (async () => {
      //   for (const it of emailsToSend) {
      //     try {
      //       await emailService.sendNotificationEmailForUser(it.target_user_id, it.title, it.body, it.link);
      //     } catch (err) {
      //       console.error('Email send error for createIOU notification', err);
      //     }
      //   }
      // })();

      return res.status(201).json({ message: 'IOU created', iou });
    } catch (err) {
      try { await t.rollback(); } catch (_) { }
      console.error('createIOU error', err);
      return res.status(500).json({ message: 'Error creating IOU' });
    }
  }
];

/**
 * GET /api/ious
 * list IOUs (optional filters)
 */

exports.listIOUs = [
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor) return res.status(401).json({ message: 'Not authenticated' });

      const limit = Math.min(parseInt(req.query.limit || '100', 10), 2000);
      const offset = parseInt(req.query.offset || '0', 10);

      const where = {};
      // status filter
      if (req.query.status) where.status = req.query.status;
      if (req.query.department) where.department = req.query.department;
      // currency filter
      if (req.query.currency) where.currency = req.query.currency.toUpperCase().trim();

      // date range
      if (req.query.start_date || req.query.end_date) {
        where.created_at = {};
        if (req.query.start_date) where.created_at[Op.gte] = new Date(req.query.start_date);
        if (req.query.end_date) {
          // include whole end day
          const end = new Date(req.query.end_date);
          end.setHours(23, 59, 59, 999);
          where.created_at[Op.lte] = end;
        }
      }

      // search: request_number, purpose, ifs_voucher_number, requester name, or estimated_amount (numeric)
      const search = (req.query.search || '').trim();
      if (search) {
        const numSearch = parseFloat(search);
        const searchOr = [
          { request_number: { [Op.like]: `%${search}%` } },
          { purpose: { [Op.like]: `%${search}%` } },
          { ifs_voucher_number: { [Op.like]: `%${search}%` } },
          { '$requester.display_name$': { [Op.like]: `%${search}%` } }
        ];
        // Also match exact numeric amounts if the search looks like a number
        if (!isNaN(numSearch) && numSearch > 0) {
          searchOr.push({ estimated_amount: numSearch });
        }
        where[Op.or] = searchOr;
      }

      // Access control for IOU list:
      // Cashiers, Admins, and Approvers can view all company IOUs (with optional requester_id filter)
      // All other users (HODs, Authorizers, Employees) only see IOUs they created OR are assigned to approve.
      const isCashierOrAdmin = actor.is_admin || actor.role === 'cashier' || actor.is_approver === true;

      if (!isCashierOrAdmin) {
        const userApprovalRecords = await Approval.findAll({
          where: { approver_id: actor.id },
          attributes: ['iou_id'],
          raw: true
        });
        const approvedIouIds = userApprovalRecords.map(a => a.iou_id).filter(Boolean);

        const userVisibilityCond = [{ requester_id: actor.id }];
        if (approvedIouIds.length > 0) {
          userVisibilityCond.push({ id: { [Op.in]: approvedIouIds } });
        }

        if (where[Op.or]) {
          const searchCond = where[Op.or];
          delete where[Op.or];
          where[Op.and] = [
            { [Op.or]: searchCond },
            { [Op.or]: userVisibilityCond }
          ];
        } else {
          where[Op.or] = userVisibilityCond;
        }
      } else {
        const requesterIdQ = req.query.requester_id || null;
        const allFlag = req.query.all === 'true' || req.query.all === true || false;
        if (requesterIdQ && !allFlag) where.requester_id = requesterIdQ;
      }

      // Build include array: include requester user (LEFT JOIN so IOUs without a matched requester still appear)
      const include = [
        { model: User, as: 'requester', attributes: ['id', 'display_name', 'username', 'email'], required: false }
      ];

      const approvedBy = req.query.approved_by || null;
      if (approvedBy) {
        // join approvals table and require at least one approval record by that user
        include.push({
          model: Approval,
          as: 'approvals',
          required: true,
          where: { approver_id: approvedBy },
          attributes: ['id', 'iou_id', 'approver_id', 'decision', 'step_order']
        });
      }

      // Spending filter: overspent / underspent / exact
      // diff_amount = actual - estimated
      // > 0: Overspent (spent more than estimated)
      // < 0: Underspent (spent less than estimated)
      // = 0: Exact
      const spending = (req.query.spending || '').trim().toLowerCase();
      if (spending && ['overspent', 'underspent', 'exact'].includes(spending)) {
        let reconWhere = {};
        if (spending === 'overspent') {
          reconWhere.diff_amount = { [Op.gt]: 0 }; // actual > estimated, diff is positive
        } else if (spending === 'underspent') {
          reconWhere.diff_amount = { [Op.lt]: 0 }; // actual < estimated, diff is negative
        } else if (spending === 'exact') {
          reconWhere.diff_amount = 0;
        }
        include.push({
          model: ReconciliationRecord,
          as: 'reconciliation',
          required: true,
          where: reconWhere,
          attributes: ['id', 'estimated_amount', 'actual_amount', 'diff_amount', 'action_required']
        });
      } else {
        // Always include reconciliation data (optional) so frontend can show spending outcome
        include.push({
          model: ReconciliationRecord,
          as: 'reconciliation',
          required: false,
          attributes: ['id', 'estimated_amount', 'actual_amount', 'diff_amount', 'action_required']
        });
      }

      // Also include ExpenseSubmission (optional) to show actual amount if available
      include.push({
        model: ExpenseSubmission,
        as: 'expenses',
        required: false,
        attributes: ['id', 'actual_amount', 'status', 'submitted_at']
      });

      // No second search block needed - requester display_name is already in the flat Op.or above

      const rows = await IOURequest.findAll({
        where,
        include,
        limit,
        offset,
        order: [['created_at', 'DESC']]
      });

      return res.json({ data: rows });
    } catch (err) {
      console.error('listIOUs error', err);
      return res.status(500).json({ message: 'Error fetching IOUs' });
    }
  }
];


/**
 * GET /api/ious/:id
 */
exports.getIOU = [
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor) return res.status(401).json({ message: 'Not authenticated' });

      const { id } = req.params;
      const iou = await IOURequest.findByPk(id);
      if (!iou) return res.status(404).json({ message: 'IOU not found' });

      // Access control: owner, admin, cashier, HOD, or assigned approver
      const isOwner = iou.requester_id === actor.id;
      const isCashierOrHod = ['cashier', 'hod'].includes(actor.role);
      let isAssignedApprover = false;
      if (!isOwner && !actor.is_admin && !isCashierOrHod) {
        const approverRecord = await Approval.findOne({ where: { iou_id: iou.id, approver_id: actor.id } });
        isAssignedApprover = !!approverRecord;
      }
      if (!actor.is_admin && !isOwner && !isCashierOrHod && !isAssignedApprover) {
        return res.status(403).json({ message: 'Forbidden' });
      }

      // include attachments and approvals
      const attachments = await IOUAttachment.findAll({ where: { iou_id: iou.id } });
      const approvals = await Approval.findAll({ where: { iou_id: iou.id }, order: [['step_order', 'ASC']] });

      return res.json({ iou, attachments, approvals });
    } catch (err) {
      console.error('getIOU error', err);
      return res.status(500).json({ message: 'Error fetching IOU' });
    }
  }
];

/**
 * PUT /api/ious/:id
 * Update a draft IOU (only owner or admin, only when DRAFT or RETURNED)
 */
exports.updateIOU = [
  async (req, res) => {
    const t = await sequelize.transaction();
    try {
      const actor = req.currentUser;
      if (!actor) { await t.rollback(); return res.status(401).json({ message: 'Not authenticated' }); }

      const { id } = req.params;
      const iou = await IOURequest.findByPk(id, { transaction: t });
      if (!iou) { await t.rollback(); return res.status(404).json({ message: 'IOU not found' }); }

      const isOwner = iou.requester_id === actor.id;
      if (!isOwner && !actor.is_admin) { await t.rollback(); return res.status(403).json({ message: 'Forbidden' }); }

      if (!['DRAFT', 'RETURNED'].includes(iou.status) && !actor.is_admin) {
        await t.rollback();
        return res.status(400).json({ message: 'Only draft or returned IOUs can be edited' });
      }

      const allowed = ['purpose', 'estimated_amount', 'currency'];
      const payload = {};
      allowed.forEach(k => { if (req.body[k] !== undefined) payload[k] = req.body[k]; });

      await iou.update(payload, { transaction: t });

      const { attachments } = req.body;
      const { deleteBlob } = require('../services/azureBlobService');

      if (attachments !== undefined && Array.isArray(attachments)) {
        const existing = await IOUAttachment.findAll({ where: { iou_id: iou.id }, transaction: t });

        // Find attachments to delete: existing ones whose ID is not in the incoming attachments
        const incomingIds = attachments.map(a => a.id).filter(Boolean);
        const toDelete = existing.filter(e => !incomingIds.includes(e.id));

        for (const att of toDelete) {
          try {
            await deleteBlob(att.blob_name);
          } catch (err) {
            console.warn(`Failed to delete blob ${att.blob_name} from Azure:`, err.message);
          }
          await att.destroy({ transaction: t });
        }

        // Find attachments to add: incoming ones that don't have an id or whose id is not in the existing list
        const existingIds = existing.map(e => e.id);
        const toAdd = attachments.filter(a => !a.id || !existingIds.includes(a.id));

        if (toAdd.length > 0) {
          const rows = toAdd.map(a => ({
            iou_id: iou.id,
            file_name: a.file_name,
            blob_name: a.blob_name,
            file_path: a.file_path,
            content_type: a.content_type || null,
            size: a.size || null,
            uploaded_by: actor.id
          }));
          await IOUAttachment.bulkCreate(rows, { transaction: t });
        }
      }

      await t.commit();

      const updatedIou = await IOURequest.findByPk(id);
      const updatedAttachments = await IOUAttachment.findAll({ where: { iou_id: id } });

      return res.json({ message: 'IOU updated', iou: updatedIou, attachments: updatedAttachments });
    } catch (err) {
      try { await t.rollback(); } catch (_) { }
      console.error('updateIOU error', err);
      return res.status(500).json({ message: 'Error updating IOU' });
    }
  }
];

/**
 * POST /api/ious/:id/submit
 * Submit IOU for approval: goes to Cashier for HOD assignment.
 * Status: DRAFT/RETURNED -> PENDING_HOD_ASSIGNMENT
 * Notifies cashiers/admins that an IOU needs approver assignment.
 */
exports.submitIOU = [
  async (req, res) => {
    const t = await sequelize.transaction();
    const emailsToSend = [];
    try {
      const actor = req.currentUser;
      if (!actor) { await t.rollback(); return res.status(401).json({ message: 'Not authenticated' }); }

      const { id } = req.params;
      const iou = await IOURequest.findByPk(id, { transaction: t });
      if (!iou) { await t.rollback(); return res.status(404).json({ message: 'IOU not found' }); }

      if (iou.requester_id !== actor.id && !actor.is_admin) { await t.rollback(); return res.status(403).json({ message: 'Forbidden' }); }

      if (!['DRAFT', 'RETURNED'].includes(iou.status) && !actor.is_admin) { await t.rollback(); return res.status(400).json({ message: `Cannot submit IOU in status ${iou.status}` }); }

      // Remove any stale approval rows from a previous submission (e.g. RETURNED then resubmitted)
      await Approval.destroy({ where: { iou_id: iou.id, approval_type: 'iou' }, transaction: t });

      // Set status to PENDING_HOD_ASSIGNMENT - Cashier must assign approvers
      await iou.update({ status: 'PENDING_HOD_ASSIGNMENT', submitted_at: new Date() }, { transaction: t });

      await auditService.log({
        actorId: actor.id,
        actorName: actor.display_name || actor.username,
        action: 'SUBMIT_IOU',
        entity: 'IOU',
        entityId: iou.id,
        details: { request_number: iou.request_number }
      }, { transaction: t });

      // Notify cashiers (and admins as fallback) that this IOU needs approver assignment
      let targets = await User.findAll({ where: { role: 'cashier', is_active: true }, transaction: t });
      if (!targets || targets.length === 0) {
        targets = await User.findAll({ where: { is_admin: true, is_active: true }, transaction: t });
      }

      for (const u of targets) {
        const emailTitle = `Action Required: IOU Submitted - ${iou.request_number}`;
        const emailBody = `${actor.display_name || actor.username} has submitted IOU ${iou.request_number} for approval.\nPurpose: ${iou.purpose || 'N/A'}\nAmount: ${iou.currency} ${iou.estimated_amount || 'N/A'}\n\nPlease assign a Head of Department and the full approval chain.`;
        const emailLink = `/ious/${iou.id}`;

        // Create in-app notification (inside transaction)
        await notificationService.createNotification({
          target_user_id: u.id,
          title: emailTitle,
          body: emailBody,
          link: emailLink,
          entity: 'IOU',
          entity_id: iou.id
        }, { transaction: t });

        // Queue email to send after commit (flat values - no reference to Sequelize instance)
        emailsToSend.push({ target_user_id: u.id, title: emailTitle, body: emailBody, link: emailLink });
      }

      await t.commit();

      // Send email notifications async after commit
      (async () => {
        for (const it of emailsToSend) {
          try {
            await emailService.sendNotificationEmailForUser(it.target_user_id, it.title, it.body, it.link);
          } catch (err) {
            console.error('Email send error for submitIOU', err);
          }
        }
      })();

      return res.json({ message: 'IOU submitted. Cashier will assign approvers.' });
    } catch (err) {
      try { await t.rollback(); } catch (_) { }
      console.error('submitIOU error', err);
      return res.status(500).json({ message: 'Error submitting IOU' });
    }
  }
];

/**
 * POST /api/ious/:id/assign-approvers
 * Cashier/admin assigns the full approval chain upfront.
 * Emails fire sequentially - only the first pending approver gets notified.
 * Cashier can re-assign (replace/add/remove unapproved) at any time.
 * Status changes from PENDING_HOD_ASSIGNMENT → PENDING when first assigned.
 */
exports.assignApprovers = [
  async (req, res) => {
    const t = await sequelize.transaction();
    const emailsToSend = [];
    try {
      const actor = req.currentUser;
      const { id } = req.params;
      const { approvers } = req.body; // array of { approver_id, step_order }

      if (!actor) { await t.rollback(); return res.status(401).json({ message: 'Not authenticated' }); }
      if (!actor.is_admin && actor.role !== 'cashier') { await t.rollback(); return res.status(403).json({ message: 'Only cashier or admin can assign approvers' }); }

      const iou = await IOURequest.findByPk(id, { transaction: t });
      if (!iou) { await t.rollback(); return res.status(404).json({ message: 'IOU not found' }); }

      if (!Array.isArray(approvers) || approvers.length === 0) {
        await t.rollback();
        return res.status(400).json({ message: 'At least one approver is required' });
      }

      // ── Validation ──

      // 1. No approver can be the IOU requester
      const requesterApprover = approvers.find(a => a.approver_id === iou.requester_id);
      if (requesterApprover) {
        await t.rollback();
        return res.status(400).json({ message: 'The IOU requester cannot be assigned as an approver' });
      }

      // 2. No duplicate approver_id
      const approverIds = approvers.map(a => a.approver_id);
      const uniqueApproverIds = new Set(approverIds);
      if (uniqueApproverIds.size !== approverIds.length) {
        await t.rollback();
        return res.status(400).json({ message: 'Duplicate approvers are not allowed. Each person can only be assigned once.' });
      }

      // 3. Validate all approver users exist
      for (const app of approvers) {
        const user = await User.findByPk(app.approver_id, { transaction: t });
        if (!user) {
          await t.rollback();
          return res.status(400).json({ message: 'User not found' });
        }
      }

      // Find all existing approvals for this IOU first
      const existingApprovals = await Approval.findAll({
        where: { iou_id: iou.id, approval_type: 'iou' },
        transaction: t
      });

      // Keep decided (APPROVED/REJECTED/RETURNED) approvals - never touch them
      const decidedApprovals = existingApprovals.filter(a => a.decision !== 'PENDING');
      const maxDecidedStep = decidedApprovals.reduce((max, a) => Math.max(max, a.step_order), 0);

      // 4. Validate approvers:
      //    - Step 1 (lowest step_order when no decided approvals exist) MUST be an HOD.
      //    - Step 2+ MUST belong to Finance department, be an Admin, or be an HOD.
      const sortedApprovers = [...approvers].sort((a, b) => (a.step_order ?? 0) - (b.step_order ?? 0));

      for (let idx = 0; idx < sortedApprovers.length; idx++) {
        const app = sortedApprovers[idx];
        const user = await User.findByPk(app.approver_id, { transaction: t });
        if (!user) {
          await t.rollback();
          return res.status(400).json({ message: 'User not found' });
        }

        const name = user.display_name || user.username;

        // Step 1 check (when no approvals decided yet)
        if (idx === 0 && decidedApprovals.length === 0) {
          if (user.role !== 'hod') {
            await t.rollback();
            const currentRole = user.role || 'no role assigned';
            return res.status(400).json({
              message: `The first approver must be a Head of Department (HOD). "${name}" currently has the role "${currentRole}". Please update their role to HOD first before assigning them as an approver.`,
              code: 'FIRST_APPROVER_NOT_HOD',
              user: { id: user.id, display_name: user.display_name, username: user.username, role: user.role }
            });
          }
        }

        // Step 2+ check (or subsequent steps): must be in managed Approvers list, Finance, Admin, or HOD
        if (idx > 0 || decidedApprovals.length > 0) {
          const isManagedApprover = user.is_approver === true;
          const isFinance = user.department && user.department.toLowerCase().includes('finance');
          const isAdmin = user.is_admin === true;
          const isHodRole = user.role === 'hod';
          const isHodDept = await Department.findOne({ where: { hod_user_id: user.id }, transaction: t });

          if (!isManagedApprover && !isFinance && !isAdmin && !isHodRole && !isHodDept) {
            await t.rollback();
            return res.status(400).json({
              message: `User "${name}" cannot be assigned as an approver. Approvers must be added to the Approvers list, belong to the Finance department, be an Admin, or be a Head of Department.`
            });
          }
        }
      }

      // Remove ALL pending approvals (they'll be replaced by the new list)
      const keepIds = decidedApprovals.map(a => a.id);
      if (keepIds.length > 0) {
        await Approval.destroy({
          where: { iou_id: iou.id, approval_type: 'iou', id: { [Op.notIn]: keepIds } },
          transaction: t
        });
      } else {
        await Approval.destroy({
          where: { iou_id: iou.id, approval_type: 'iou' },
          transaction: t
        });
      }

      // Start step numbering after any decided approvals
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
        approval_type: 'iou'
      }));
      await Approval.bulkCreate(rows, { transaction: t });

      // Update IOU status: PENDING_HOD_ASSIGNMENT → PENDING
      if (['PENDING_HOD_ASSIGNMENT'].includes(iou.status)) {
        await iou.update({ status: 'PENDING' }, { transaction: t });
      }

      // Find the first pending approval (the one who should be actively notified)
      const allPendingApprovals = await Approval.findAll({
        where: { iou_id: iou.id, decision: 'PENDING', approval_type: 'iou' },
        order: [['step_order', 'ASC']],
        transaction: t
      });

      const firstPending = allPendingApprovals.length > 0 ? allPendingApprovals[0] : null;

      // Only email the FIRST pending approver (sequential notification)
      if (firstPending) {
        const note = await notificationService.createNotification({
          target_user_id: firstPending.approver_id,
          title: `Approval required: ${iou.request_number}`,
          body: `You have been requested to approve IOU ${iou.request_number}. Please review and take action.`,
          link: `/ious/${iou.id}`,
          entity: 'IOU',
          entity_id: iou.id
        }, { transaction: t });

        emailsToSend.push({ note, target_user_id: firstPending.approver_id });
      }

      await auditService.log({
        actorId: actor.id, actorName: actor.display_name || actor.username,
        action: 'ASSIGN_APPROVERS',
        entity: 'IOU',
        entityId: iou.id,
        details: { approvers: rows }
      }, { transaction: t });

      await t.commit();

      // send email notifications async
      (async () => {
        for (const it of emailsToSend) {
          try {
            await emailService.sendNotificationEmailForUser(it.target_user_id, it.note.title, it.note.body, it.note.link);
          } catch (err) {
            console.error('Email send error for assignApprovers', err);
          }
        }
      })();

      // Return all approvals for this IOU
      const finalApprovals = await Approval.findAll({
        where: { iou_id: iou.id, approval_type: 'iou' },
        order: [['step_order', 'ASC']]
      });

      return res.json({ message: 'Approvers assigned', approvers: finalApprovals });
    } catch (err) {
      try { await t.rollback(); } catch (_) { }
      console.error('assignApprovers', err);
      return res.status(500).json({ message: 'Error assigning approvers' });
    }
  }
];

/**
 * POST /api/ious/:id/confirm-approval
 * Cashier/admin confirms that all approvals are complete.
 * Status: PENDING → APPROVED_FOR_DISBURSEMENT
 * Validates all iou-type approvals are APPROVED.
 */
exports.confirmApproval = [
  async (req, res) => {
    const t = await sequelize.transaction();
    const emailsToSend = [];
    try {
      const actor = req.currentUser;
      if (!actor) { await t.rollback(); return res.status(401).json({ message: 'Not authenticated' }); }
      if (!actor.is_admin && actor.role !== 'cashier') { await t.rollback(); return res.status(403).json({ message: 'Only cashier or admin can confirm approval' }); }

      const { id } = req.params;
      const iou = await IOURequest.findByPk(id, { transaction: t });
      if (!iou) { await t.rollback(); return res.status(404).json({ message: 'IOU not found' }); }

      if (iou.status !== 'PENDING') {
        await t.rollback();
        return res.status(400).json({ message: `Cannot confirm approval for IOU in status ${iou.status}` });
      }

      // Check that there are approval records and ALL are APPROVED
      const allApprovals = await Approval.findAll({
        where: { iou_id: iou.id, approval_type: 'iou' },
        transaction: t
      });

      if (allApprovals.length === 0) {
        await t.rollback();
        return res.status(400).json({ message: 'No approvals found. Please assign approvers first.' });
      }

      const pendingApprovals = allApprovals.filter(a => a.decision === 'PENDING');
      if (pendingApprovals.length > 0) {
        await t.rollback();
        return res.status(400).json({ message: `${pendingApprovals.length} approval(s) are still pending. All approvers must approve before confirming.` });
      }

      const rejectedApprovals = allApprovals.filter(a => a.decision === 'REJECTED');
      if (rejectedApprovals.length > 0) {
        await t.rollback();
        return res.status(400).json({ message: 'One or more approvals were rejected. Cannot confirm.' });
      }

      // All approved - move to APPROVED_FOR_DISBURSEMENT
      await iou.update({ status: 'APPROVED_FOR_DISBURSEMENT' }, { transaction: t });

      // Notify requester
      const note = await notificationService.createNotification({
        target_user_id: iou.requester_id,
        title: `IOU Approved: ${iou.request_number}`,
        body: `Your IOU ${iou.request_number} has been fully approved and is ready for disbursement.`,
        link: `/ious/${iou.id}`,
        entity: 'IOU',
        entity_id: iou.id
      }, { transaction: t });
      emailsToSend.push({ note, target_user_id: iou.requester_id });

      await auditService.log({
        actorId: actor.id,
        actorName: actor.display_name || actor.username,
        action: 'CONFIRM_APPROVAL',
        entity: 'IOU',
        entityId: iou.id,
        details: { request_number: iou.request_number, total_approvals: allApprovals.length }
      }, { transaction: t });

      await t.commit();

      (async () => {
        for (const it of emailsToSend) {
          try {
            await emailService.sendNotificationEmailForUser(it.target_user_id, it.note.title, it.note.body, it.note.link);
          } catch (err) {
            console.error('Email send error for confirmApproval', err);
          }
        }
      })();

      return res.json({ message: 'Approval confirmed. IOU is now approved for disbursement.' });
    } catch (err) {
      try { await t.rollback(); } catch (_) { }
      console.error('confirmApproval error', err);
      return res.status(500).json({ message: 'Error confirming approval' });
    }
  }
];

/**
 * POST /api/ious/:id/cashier-reject
 * Cashier/admin outright rejects an IOU before any approvers are assigned.
 * Status: PENDING_HOD_ASSIGNMENT → REJECTED
 * Requires a non-empty comments field.
 */
exports.cashierRejectIOU = [
  async (req, res) => {
    const t = await sequelize.transaction();
    const emailsToSend = [];
    try {
      const actor = req.currentUser;
      if (!actor) { await t.rollback(); return res.status(401).json({ message: 'Not authenticated' }); }
      if (!actor.is_admin && actor.role !== 'cashier') {
        await t.rollback();
        return res.status(403).json({ message: 'Only cashier or admin can reject at this stage' });
      }

      const { id } = req.params;
      const { comments } = req.body;
      if (!comments || !String(comments).trim()) {
        await t.rollback();
        return res.status(400).json({ message: 'A reason/comment is required to reject an IOU' });
      }

      const iou = await IOURequest.findByPk(id, { transaction: t });
      if (!iou) { await t.rollback(); return res.status(404).json({ message: 'IOU not found' }); }

      if (iou.status !== 'PENDING_HOD_ASSIGNMENT') {
        await t.rollback();
        return res.status(400).json({
          message: `Cannot reject IOU in status "${iou.status}". Only IOUs awaiting approver assignment can be rejected here.`
        });
      }

      await iou.update({ status: 'REJECTED' }, { transaction: t });

      // Notify requester
      const note = await notificationService.createNotification({
        target_user_id: iou.requester_id,
        title: `IOU Rejected: ${iou.request_number}`,
        body: `Your IOU ${iou.request_number} was rejected by ${actor.display_name || actor.username}. Reason: ${comments}`,
        link: `/ious/${iou.id}`,
        entity: 'IOU',
        entity_id: iou.id
      }, { transaction: t });
      emailsToSend.push({ note, target_user_id: iou.requester_id });

      await auditService.log({
        actorId: actor.id,
        actorName: actor.display_name || actor.username,
        action: 'CASHIER_REJECT_IOU',
        entity: 'IOU',
        entityId: iou.id,
        details: { request_number: iou.request_number, comments }
      }, { transaction: t });

      await t.commit();

      (async () => {
        for (const it of emailsToSend) {
          try {
            await emailService.sendNotificationEmailForUser(it.target_user_id, it.note.title, it.note.body, it.note.link);
          } catch (err) {
            console.error('Email send error for cashierRejectIOU', err);
          }
        }
      })();

      return res.json({ message: 'IOU rejected successfully.' });
    } catch (err) {
      try { await t.rollback(); } catch (_) { }
      console.error('cashierRejectIOU error', err);
      return res.status(500).json({ message: 'Error rejecting IOU' });
    }
  }
];

/**
 * POST /api/ious/:id/cashier-return
 * Cashier/admin returns an IOU for edits before any approvers are assigned.
 * Status: PENDING_HOD_ASSIGNMENT → RETURNED  (requester can edit and re-submit)
 * Requires a non-empty comments field.
 */
exports.cashierReturnIOU = [
  async (req, res) => {
    const t = await sequelize.transaction();
    const emailsToSend = [];
    try {
      const actor = req.currentUser;
      if (!actor) { await t.rollback(); return res.status(401).json({ message: 'Not authenticated' }); }
      if (!actor.is_admin && actor.role !== 'cashier') {
        await t.rollback();
        return res.status(403).json({ message: 'Only cashier or admin can return at this stage' });
      }

      const { id } = req.params;
      const { comments } = req.body;
      if (!comments || !String(comments).trim()) {
        await t.rollback();
        return res.status(400).json({ message: 'A reason/comment is required to return an IOU' });
      }

      const iou = await IOURequest.findByPk(id, { transaction: t });
      if (!iou) { await t.rollback(); return res.status(404).json({ message: 'IOU not found' }); }

      if (iou.status !== 'PENDING_HOD_ASSIGNMENT') {
        await t.rollback();
        return res.status(400).json({
          message: `Cannot return IOU in status "${iou.status}". Only IOUs awaiting approver assignment can be returned here.`
        });
      }

      // Clear any stale pending approval rows from previous submissions
      await Approval.destroy({ where: { iou_id: iou.id, approval_type: 'iou', decision: 'PENDING' }, transaction: t });

      await iou.update({ status: 'RETURNED' }, { transaction: t });

      // Notify requester
      const note = await notificationService.createNotification({
        target_user_id: iou.requester_id,
        title: `IOU Returned for Edits: ${iou.request_number}`,
        body: `Your IOU ${iou.request_number} was returned for changes by ${actor.display_name || actor.username}. Reason: ${comments} - Please edit and re-submit.`,
        link: `/ious/${iou.id}`,
        entity: 'IOU',
        entity_id: iou.id
      }, { transaction: t });
      emailsToSend.push({ note, target_user_id: iou.requester_id });

      await auditService.log({
        actorId: actor.id,
        actorName: actor.display_name || actor.username,
        action: 'CASHIER_RETURN_IOU',
        entity: 'IOU',
        entityId: iou.id,
        details: { request_number: iou.request_number, comments }
      }, { transaction: t });

      await t.commit();

      (async () => {
        for (const it of emailsToSend) {
          try {
            await emailService.sendNotificationEmailForUser(it.target_user_id, it.note.title, it.note.body, it.note.link);
          } catch (err) {
            console.error('Email send error for cashierReturnIOU', err);
          }
        }
      })();

      return res.json({ message: 'IOU returned for edits successfully.' });
    } catch (err) {
      try { await t.rollback(); } catch (_) { }
      console.error('cashierReturnIOU error', err);
      return res.status(500).json({ message: 'Error returning IOU' });
    }
  }
];

