// controllers/directExpenseController.js
const DirectExpenseRequest = require('../models/DirectExpenseRequest');
const DirectExpenseAttachment = require('../models/DirectExpenseAttachment');
const Approval = require('../models/Approval');
const User = require('../models/User');
const Department = require('../models/Department');
const Disbursement = require('../models/Disbursement');
const sequelize = require('../config/database');
const auditService = require('../services/auditService');
const notificationService = require('../services/notificationService');
const emailService = require('../services/emailService');
const FundBalance = require('../models/FundBalance');
const FundTransaction = require('../models/FundTransaction');
const { Op } = require('sequelize');


/**
 * Helper: generate request number for Direct Expense
 * Format: DE-YYYYMMDDHHMMSS-<random4>
 */
function generateRequestNumber() {
  const d = new Date();
  const ts = d.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  const rand = Math.floor(Math.random() * 9000) + 1000;
  return `DE-${ts}-${rand}`;
}

/**
 * POST /api/direct-expenses
 * Create Direct Expense (DRAFT) - attachments are REQUIRED
 */
exports.createDirectExpense = [
  async (req, res) => {
    const t = await sequelize.transaction();
    const emailsToSend = [];
    try {
      const actor = req.currentUser;
      if (!actor) { await t.rollback(); return res.status(401).json({ message: 'Not authenticated' }); }

      const { purpose, amount, currency, attachments } = req.body;

      // Attachments are REQUIRED for Direct Expense
      if (!Array.isArray(attachments) || attachments.length === 0) {
        await t.rollback();
        return res.status(400).json({ message: 'At least one attachment (receipt/evidence) is required for a Direct Expense request.' });
      }

      // Fund sufficiency check
      const deCurrency = (currency || 'GHS').toUpperCase().trim();
      if (amount && Number(amount) > 0) {
        const fundBalance = await FundBalance.findOne({ where: { currency: deCurrency }, transaction: t });
        const available = fundBalance ? Number(fundBalance.available_amount) : 0;
        if (available < Number(amount)) {
          await t.rollback();
          return res.status(400).json({
            message: 'Insufficient funds available for this currency. Please contact the Finance Department.'
          });
        }
      }

      const de = await DirectExpenseRequest.create({
        request_number: generateRequestNumber(),
        requester_id: actor.id,
        department: actor.department || null,
        purpose: purpose || null,
        amount: amount || null,
        currency: deCurrency,
        status: 'DRAFT'
      }, { transaction: t });

      // Create attachment records
      const rows = attachments.map(a => ({
        direct_expense_id: de.id,
        file_name: a.file_name,
        blob_name: a.blob_name,
        file_path: a.file_path,
        content_type: a.content_type || null,
        size: a.size || null,
        uploaded_by: actor.id
      }));
      await DirectExpenseAttachment.bulkCreate(rows, { transaction: t });

      // Audit
      await auditService.log({
        actorId: actor.id,
        actorName: actor.display_name || actor.username,
        action: 'CREATE_DIRECT_EXPENSE',
        entity: 'DIRECT_EXPENSE',
        entityId: de.id,
        details: { request_number: de.request_number, department: de.department }
      }, { transaction: t });

      await t.commit();

      return res.status(201).json({ message: 'Direct Expense created', directExpense: de });
    } catch (err) {
      try { await t.rollback(); } catch (_) { }
      console.error('createDirectExpense error', err);
      return res.status(500).json({ message: 'Error creating Direct Expense' });
    }
  }
];

/**
 * GET /api/direct-expenses
 * List Direct Expenses (optional filters)
 */
exports.listDirectExpenses = [
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor) return res.status(401).json({ message: 'Not authenticated' });

      const limit = Math.min(parseInt(req.query.limit || '100', 10), 2000);
      const offset = parseInt(req.query.offset || '0', 10);

      const where = {};
      if (req.query.status) where.status = req.query.status;
      if (req.query.department) where.department = req.query.department;
      if (req.query.currency) where.currency = req.query.currency.toUpperCase().trim();

      // date range
      if (req.query.start_date || req.query.end_date) {
        where.created_at = {};
        if (req.query.start_date) where.created_at[Op.gte] = new Date(req.query.start_date);
        if (req.query.end_date) {
          const end = new Date(req.query.end_date);
          end.setHours(23, 59, 59, 999);
          where.created_at[Op.lte] = end;
        }
      }

      // search
      const search = (req.query.search || '').trim();
      if (search) {
        const numSearch = parseFloat(search);
        const searchOr = [
          { request_number: { [Op.like]: `%${search}%` } },
          { purpose: { [Op.like]: `%${search}%` } },
          { ifs_voucher_number: { [Op.like]: `%${search}%` } },
          { '$requester.display_name$': { [Op.like]: `%${search}%` } }
        ];
        if (!isNaN(numSearch) && numSearch > 0) {
          searchOr.push({ amount: numSearch });
        }
        where[Op.or] = searchOr;
      }

      // Access control (mirrors IOU logic)
      const isCashierOrAdmin = actor.is_admin || actor.role === 'cashier' || actor.is_approver === true;

      if (!isCashierOrAdmin) {
        const userApprovalRecords = await Approval.findAll({
          where: { approver_id: actor.id, approval_type: 'direct_expense' },
          attributes: ['direct_expense_id'],
          raw: true
        });
        const approvedDeIds = userApprovalRecords.map(a => a.direct_expense_id).filter(Boolean);

        const userVisibilityCond = [{ requester_id: actor.id }];
        if (approvedDeIds.length > 0) {
          userVisibilityCond.push({ id: { [Op.in]: approvedDeIds } });
        }

        // HOD department visibility
        try {
          const DepartmentHOD = require('../models/DepartmentHOD');
          const hodLinks = await DepartmentHOD.findAll({
            where: { user_id: actor.id },
            attributes: ['department_id'],
            raw: true
          });
          const deptIds = hodLinks.map(h => h.department_id);
          const managedDepts = await Department.findAll({
            where: {
              [Op.or]: [
                ...(deptIds.length > 0 ? [{ id: { [Op.in]: deptIds } }] : []),
                { hod_user_id: actor.id }
              ]
            },
            attributes: ['name'],
            raw: true
          });
          const deptNames = managedDepts.map(d => d.name);
          if (actor.role === 'hod' && actor.department && !deptNames.includes(actor.department)) {
            deptNames.push(actor.department);
          }
          if (deptNames.length > 0) {
            userVisibilityCond.push({ department: { [Op.in]: deptNames } });
          }
        } catch (_) {}

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

      const include = [
        { model: User, as: 'requester', attributes: ['id', 'display_name', 'username', 'email'], required: false }
      ];

      const approvedBy = req.query.approved_by || null;
      if (approvedBy) {
        include.push({
          model: Approval,
          as: 'approvals',
          required: true,
          where: { approver_id: approvedBy },
          attributes: ['id', 'direct_expense_id', 'approver_id', 'decision', 'step_order']
        });
      }

      const rows = await DirectExpenseRequest.findAll({
        where,
        include,
        limit,
        offset,
        order: [['created_at', 'DESC']]
      });

      return res.json({ data: rows });
    } catch (err) {
      console.error('listDirectExpenses error', err);
      return res.status(500).json({ message: 'Error fetching Direct Expenses' });
    }
  }
];

/**
 * GET /api/direct-expenses/:id
 */
exports.getDirectExpense = [
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor) return res.status(401).json({ message: 'Not authenticated' });

      const { id } = req.params;
      const de = await DirectExpenseRequest.findByPk(id);
      if (!de) return res.status(404).json({ message: 'Direct Expense not found' });

      // Access control
      const isOwner = de.requester_id === actor.id;
      const isCashierOrHod = ['cashier', 'hod'].includes(actor.role);
      let isAssignedApprover = false;
      if (!isOwner && !actor.is_admin && !isCashierOrHod) {
        const approverRecord = await Approval.findOne({ where: { direct_expense_id: de.id, approver_id: actor.id } });
        isAssignedApprover = !!approverRecord;
      }
      if (!actor.is_admin && !isOwner && !isCashierOrHod && !isAssignedApprover) {
        return res.status(403).json({ message: 'Forbidden' });
      }

      const attachments = await DirectExpenseAttachment.findAll({ where: { direct_expense_id: de.id } });
      const approvals = await Approval.findAll({ where: { direct_expense_id: de.id }, order: [['step_order', 'ASC']] });

      return res.json({ directExpense: de, attachments, approvals });
    } catch (err) {
      console.error('getDirectExpense error', err);
      return res.status(500).json({ message: 'Error fetching Direct Expense' });
    }
  }
];

/**
 * PUT /api/direct-expenses/:id
 * Update a draft Direct Expense (only owner or admin, only when DRAFT or RETURNED)
 * Attachments must remain >= 1 after edits.
 */
exports.updateDirectExpense = [
  async (req, res) => {
    const t = await sequelize.transaction();
    try {
      const actor = req.currentUser;
      if (!actor) { await t.rollback(); return res.status(401).json({ message: 'Not authenticated' }); }

      const { id } = req.params;
      const de = await DirectExpenseRequest.findByPk(id, { transaction: t });
      if (!de) { await t.rollback(); return res.status(404).json({ message: 'Direct Expense not found' }); }

      const isOwner = de.requester_id === actor.id;
      if (!isOwner && !actor.is_admin) { await t.rollback(); return res.status(403).json({ message: 'Forbidden' }); }

      if (!['DRAFT', 'RETURNED'].includes(de.status) && !actor.is_admin) {
        await t.rollback();
        return res.status(400).json({ message: 'Only draft or returned Direct Expenses can be edited' });
      }

      const allowed = ['purpose', 'amount', 'currency'];
      const payload = {};
      allowed.forEach(k => { if (req.body[k] !== undefined) payload[k] = req.body[k]; });

      await de.update(payload, { transaction: t });

      const { attachments } = req.body;
      const { deleteBlob } = require('../services/azureBlobService');

      if (attachments !== undefined && Array.isArray(attachments)) {
        const existing = await DirectExpenseAttachment.findAll({ where: { direct_expense_id: de.id }, transaction: t });

        const incomingIds = attachments.map(a => a.id).filter(Boolean);
        const toDelete = existing.filter(e => !incomingIds.includes(e.id));

        // Ensure at least 1 attachment remains after edits
        const existingIds = existing.map(e => e.id);
        const toAdd = attachments.filter(a => !a.id || !existingIds.includes(a.id));
        const remainingCount = (existing.length - toDelete.length) + toAdd.length;

        if (remainingCount < 1) {
          await t.rollback();
          return res.status(400).json({ message: 'At least one attachment (receipt/evidence) is required for a Direct Expense request.' });
        }

        for (const att of toDelete) {
          try {
            await deleteBlob(att.blob_name);
          } catch (err) {
            console.warn(`Failed to delete blob ${att.blob_name} from Azure:`, err.message);
          }
          await att.destroy({ transaction: t });
        }

        if (toAdd.length > 0) {
          const rows = toAdd.map(a => ({
            direct_expense_id: de.id,
            file_name: a.file_name,
            blob_name: a.blob_name,
            file_path: a.file_path,
            content_type: a.content_type || null,
            size: a.size || null,
            uploaded_by: actor.id
          }));
          await DirectExpenseAttachment.bulkCreate(rows, { transaction: t });
        }
      }

      await t.commit();

      const updatedDe = await DirectExpenseRequest.findByPk(id);
      const updatedAttachments = await DirectExpenseAttachment.findAll({ where: { direct_expense_id: id } });

      return res.json({ message: 'Direct Expense updated', directExpense: updatedDe, attachments: updatedAttachments });
    } catch (err) {
      try { await t.rollback(); } catch (_) { }
      console.error('updateDirectExpense error', err);
      return res.status(500).json({ message: 'Error updating Direct Expense' });
    }
  }
];

/**
 * POST /api/direct-expenses/:id/submit
 * Submit Direct Expense for approval: goes to Cashier for HOD assignment.
 * Status: DRAFT/RETURNED -> PENDING_HOD_ASSIGNMENT
 */
exports.submitDirectExpense = [
  async (req, res) => {
    const t = await sequelize.transaction();
    const emailsToSend = [];
    try {
      const actor = req.currentUser;
      if (!actor) { await t.rollback(); return res.status(401).json({ message: 'Not authenticated' }); }

      const { id } = req.params;
      const de = await DirectExpenseRequest.findByPk(id, { transaction: t });
      if (!de) { await t.rollback(); return res.status(404).json({ message: 'Direct Expense not found' }); }

      if (de.requester_id !== actor.id && !actor.is_admin) { await t.rollback(); return res.status(403).json({ message: 'Forbidden' }); }

      if (!['DRAFT', 'RETURNED'].includes(de.status) && !actor.is_admin) { await t.rollback(); return res.status(400).json({ message: `Cannot submit Direct Expense in status ${de.status}` }); }

      // Verify attachments exist (required for direct expense)
      const attachmentCount = await DirectExpenseAttachment.count({ where: { direct_expense_id: de.id }, transaction: t });
      if (attachmentCount === 0) {
        await t.rollback();
        return res.status(400).json({ message: 'At least one attachment (receipt/evidence) is required before submitting a Direct Expense.' });
      }

      // Remove any stale approval rows from a previous submission
      await Approval.destroy({ where: { direct_expense_id: de.id, approval_type: 'direct_expense' }, transaction: t });

      await de.update({ status: 'PENDING_HOD_ASSIGNMENT', submitted_at: new Date() }, { transaction: t });

      await auditService.log({
        actorId: actor.id,
        actorName: actor.display_name || actor.username,
        action: 'SUBMIT_DIRECT_EXPENSE',
        entity: 'DIRECT_EXPENSE',
        entityId: de.id,
        details: { request_number: de.request_number }
      }, { transaction: t });

      // Notify cashiers
      let targets = await User.findAll({ where: { role: 'cashier', is_active: true }, transaction: t });
      if (!targets || targets.length === 0) {
        targets = await User.findAll({ where: { is_admin: true, is_active: true }, transaction: t });
      }

      for (const u of targets) {
        const emailTitle = `Action Required: Direct Expense Submitted - ${de.request_number}`;
        const emailBody = `${actor.display_name || actor.username} has submitted Direct Expense ${de.request_number} for approval.\nPurpose: ${de.purpose || 'N/A'}\nAmount: ${de.currency} ${de.amount || 'N/A'}\n\nPlease assign a Head of Department and the full approval chain.`;
        const emailLink = `/direct-expenses/${de.id}`;

        await notificationService.createNotification({
          target_user_id: u.id,
          title: emailTitle,
          body: emailBody,
          link: emailLink,
          entity: 'DIRECT_EXPENSE',
          entity_id: de.id
        }, { transaction: t });

        emailsToSend.push({ target_user_id: u.id, title: emailTitle, body: emailBody, link: emailLink });
      }

      await t.commit();

      (async () => {
        for (const it of emailsToSend) {
          try {
            await emailService.sendNotificationEmailForUser(it.target_user_id, it.title, it.body, it.link);
          } catch (err) {
            console.error('Email send error for submitDirectExpense', err);
          }
        }
      })();

      return res.json({ message: 'Direct Expense submitted. Cashier will assign approvers.' });
    } catch (err) {
      try { await t.rollback(); } catch (_) { }
      console.error('submitDirectExpense error', err);
      return res.status(500).json({ message: 'Error submitting Direct Expense' });
    }
  }
];

/**
 * POST /api/direct-expenses/:id/assign-approvers
 * Cashier/admin assigns the full approval chain.
 * ENFORCES minimum 2 finance/authorizer approvers (step 2+).
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

      const de = await DirectExpenseRequest.findByPk(id, { transaction: t });
      if (!de) { await t.rollback(); return res.status(404).json({ message: 'Direct Expense not found' }); }

      if (!Array.isArray(approvers) || approvers.length === 0) {
        await t.rollback();
        return res.status(400).json({ message: 'At least one approver is required' });
      }

      // ── Validation ──

      // 1. No approver can be the DE requester
      const requesterApprover = approvers.find(a => a.approver_id === de.requester_id);
      if (requesterApprover) {
        await t.rollback();
        return res.status(400).json({ message: 'The Direct Expense requester cannot be assigned as an approver' });
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

      // Find all existing approvals for this DE first
      const existingApprovals = await Approval.findAll({
        where: { direct_expense_id: de.id, approval_type: 'direct_expense' },
        transaction: t
      });

      const decidedApprovals = existingApprovals.filter(a => a.decision !== 'PENDING');
      const maxDecidedStep = decidedApprovals.reduce((max, a) => Math.max(max, a.step_order), 0);

      // 4. Sort and validate approvers
      const sortedApprovers = [...approvers].sort((a, b) => (a.step_order ?? 0) - (b.step_order ?? 0));

      // ENFORCE: minimum 2 finance/authorizer approvers (step 2+)
      const financeApprovers = [];
      for (let idx = 0; idx < sortedApprovers.length; idx++) {
        const app = sortedApprovers[idx];
        const user = await User.findByPk(app.approver_id, { transaction: t });
        if (!user) {
          await t.rollback();
          return res.status(400).json({ message: 'User not found' });
        }

        const name = user.display_name || user.username;

        // Step 1 check (when no approvals decided yet) - must be HOD
        if (idx === 0 && decidedApprovals.length === 0) {
          const DepartmentHOD = require('../models/DepartmentHOD');
          const isDeptHod = await DepartmentHOD.findOne({ where: { user_id: user.id }, transaction: t });
          if (user.role !== 'hod' && !isDeptHod) {
            await t.rollback();
            const currentRole = user.role || 'no role assigned';
            return res.status(400).json({
              message: `The first approver must be a Head of Department (HOD). "${name}" currently has the role "${currentRole}". Please update their role to HOD first before assigning them as an approver.`,
              code: 'FIRST_APPROVER_NOT_HOD',
              user: { id: user.id, display_name: user.display_name, username: user.username, role: user.role }
            });
          }
        }

        // Step 2+ check: must be in managed Approvers list, Finance, Admin, or HOD
        if (idx > 0 || decidedApprovals.length > 0) {
          const DepartmentHOD = require('../models/DepartmentHOD');
          const isManagedApprover = user.is_approver === true;
          const isFinance = user.department && user.department.toLowerCase().includes('finance');
          const isAdmin = user.is_admin === true;
          const isHodRole = user.role === 'hod';
          const isHodDept = await Department.findOne({ where: { hod_user_id: user.id }, transaction: t });
          const isDeptHodEntry = await DepartmentHOD.findOne({ where: { user_id: user.id }, transaction: t });

          if (!isManagedApprover && !isFinance && !isAdmin && !isHodRole && !isHodDept && !isDeptHodEntry) {
            await t.rollback();
            return res.status(400).json({
              message: `User "${name}" cannot be assigned as an approver. Approvers must be added to the Approvers list, belong to the Finance department, be an Admin, or be a Head of Department.`
            });
          }

          // Count finance/authorizer approvers for minimum-2 enforcement
          if (isManagedApprover || isFinance || isAdmin) {
            financeApprovers.push(user);
          }
        }
      }

      // ENFORCE minimum 2 finance/authorizer approvers for Direct Expense
      if (financeApprovers.length < 2) {
        await t.rollback();
        return res.status(400).json({
          message: `Direct Expense requests require a minimum of 2 finance/authorizer approvers. Currently only ${financeApprovers.length} assigned. Please add at least ${2 - financeApprovers.length} more.`,
          code: 'MIN_FINANCE_APPROVERS_NOT_MET'
        });
      }

      // Remove ALL pending approvals (they'll be replaced by the new list)
      const keepIds = decidedApprovals.map(a => a.id);
      if (keepIds.length > 0) {
        await Approval.destroy({
          where: { direct_expense_id: de.id, approval_type: 'direct_expense', id: { [Op.notIn]: keepIds } },
          transaction: t
        });
      } else {
        await Approval.destroy({
          where: { direct_expense_id: de.id, approval_type: 'direct_expense' },
          transaction: t
        });
      }

      const startStep = maxDecidedStep + 1;

      const alreadyDecidedIds = new Set(decidedApprovals.map(a => a.approver_id));
      const filteredApprovers = approvers.filter(a => !alreadyDecidedIds.has(a.approver_id));

      // Insert new pending approvals
      const rows = filteredApprovers.map((a, idx) => ({
        direct_expense_id: de.id,
        approver_id: a.approver_id,
        step_order: startStep + idx,
        decision: 'PENDING',
        approval_type: 'direct_expense'
      }));
      await Approval.bulkCreate(rows, { transaction: t });

      // Update status: PENDING_HOD_ASSIGNMENT → PENDING
      if (['PENDING_HOD_ASSIGNMENT'].includes(de.status)) {
        await de.update({ status: 'PENDING' }, { transaction: t });
      }

      // Find the first pending approval
      const allPendingApprovals = await Approval.findAll({
        where: { direct_expense_id: de.id, decision: 'PENDING', approval_type: 'direct_expense' },
        order: [['step_order', 'ASC']],
        transaction: t
      });

      const firstPending = allPendingApprovals.length > 0 ? allPendingApprovals[0] : null;

      if (firstPending) {
        const note = await notificationService.createNotification({
          target_user_id: firstPending.approver_id,
          title: `Approval required: ${de.request_number}`,
          body: `You have been requested to approve Direct Expense ${de.request_number}. Please review and take action.`,
          link: `/direct-expenses/${de.id}`,
          entity: 'DIRECT_EXPENSE',
          entity_id: de.id
        }, { transaction: t });

        emailsToSend.push({ note, target_user_id: firstPending.approver_id });
      }

      await auditService.log({
        actorId: actor.id, actorName: actor.display_name || actor.username,
        action: 'ASSIGN_APPROVERS',
        entity: 'DIRECT_EXPENSE',
        entityId: de.id,
        details: { approvers: rows }
      }, { transaction: t });

      await t.commit();

      (async () => {
        for (const it of emailsToSend) {
          try {
            await emailService.sendNotificationEmailForUser(it.target_user_id, it.note.title, it.note.body, it.note.link);
          } catch (err) {
            console.error('Email send error for assignApprovers (DE)', err);
          }
        }
      })();

      const finalApprovals = await Approval.findAll({
        where: { direct_expense_id: de.id, approval_type: 'direct_expense' },
        order: [['step_order', 'ASC']]
      });

      return res.json({ message: 'Approvers assigned', approvers: finalApprovals });
    } catch (err) {
      try { await t.rollback(); } catch (_) { }
      console.error('assignApprovers (DE)', err);
      return res.status(500).json({ message: 'Error assigning approvers' });
    }
  }
];

/**
 * POST /api/direct-expenses/:id/confirm-approval
 * Cashier/admin confirms that all approvals are complete.
 * Status: PENDING → APPROVED_FOR_DISBURSEMENT
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
      const de = await DirectExpenseRequest.findByPk(id, { transaction: t });
      if (!de) { await t.rollback(); return res.status(404).json({ message: 'Direct Expense not found' }); }

      if (de.status !== 'PENDING') {
        await t.rollback();
        return res.status(400).json({ message: `Cannot confirm approval for Direct Expense in status ${de.status}` });
      }

      const allApprovals = await Approval.findAll({
        where: { direct_expense_id: de.id, approval_type: 'direct_expense' },
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

      await de.update({ status: 'APPROVED_FOR_DISBURSEMENT' }, { transaction: t });

      const note = await notificationService.createNotification({
        target_user_id: de.requester_id,
        title: `Direct Expense Approved: ${de.request_number}`,
        body: `Your Direct Expense ${de.request_number} has been fully approved and is ready for disbursement.`,
        link: `/direct-expenses/${de.id}`,
        entity: 'DIRECT_EXPENSE',
        entity_id: de.id
      }, { transaction: t });
      emailsToSend.push({ note, target_user_id: de.requester_id });

      await auditService.log({
        actorId: actor.id,
        actorName: actor.display_name || actor.username,
        action: 'CONFIRM_APPROVAL',
        entity: 'DIRECT_EXPENSE',
        entityId: de.id,
        details: { request_number: de.request_number, total_approvals: allApprovals.length }
      }, { transaction: t });

      await t.commit();

      (async () => {
        for (const it of emailsToSend) {
          try {
            await emailService.sendNotificationEmailForUser(it.target_user_id, it.note.title, it.note.body, it.note.link);
          } catch (err) {
            console.error('Email send error for confirmApproval (DE)', err);
          }
        }
      })();

      return res.json({ message: 'Approval confirmed. Direct Expense is now approved for disbursement.' });
    } catch (err) {
      try { await t.rollback(); } catch (_) { }
      console.error('confirmApproval (DE) error', err);
      return res.status(500).json({ message: 'Error confirming approval' });
    }
  }
];

/**
 * POST /api/direct-expenses/:id/disburse
 * Cashier records disbursement for a Direct Expense
 */
exports.disburse = [
  async (req, res) => {
    const t = await sequelize.transaction();
    try {
      const actor = req.currentUser;
      if (!actor) { await t.rollback(); return res.status(401).json({ message: 'Not authenticated' }); }
      if (!actor.is_admin && actor.role !== 'cashier') { await t.rollback(); return res.status(403).json({ message: 'Only cashier or admin can disburse' }); }

      const { id } = req.params;
      const de = await DirectExpenseRequest.findByPk(id, { transaction: t });
      if (!de) { await t.rollback(); return res.status(404).json({ message: 'Direct Expense not found' }); }

      if (de.status !== 'APPROVED_FOR_DISBURSEMENT' && !actor.is_admin) {
        await t.rollback();
        return res.status(400).json({ message: `Cannot disburse Direct Expense in status ${de.status}` });
      }

      const { amount, payment_method, payment_reference, notes } = req.body;
      if (!amount) { await t.rollback(); return res.status(400).json({ message: 'amount is required' }); }

      const disbursement = await Disbursement.create({
        direct_expense_id: de.id,
        cashier_id: actor.id,
        amount,
        payment_method: payment_method || null,
        payment_reference: payment_reference || null,
        disbursed_at: new Date(),
        notes: notes || null
      }, { transaction: t });

      // Fund Balance Deduction
      const deCurrency = (de.currency || 'GHS').toUpperCase();
      const numAmount = Number(amount);
      const fundBalance = await FundBalance.findOne({ where: { currency: deCurrency }, transaction: t });
      const currentAvailable = fundBalance ? Number(fundBalance.available_amount) : 0;

      if (currentAvailable < numAmount) {
        await t.rollback();
        return res.status(400).json({
          message: `Insufficient ${deCurrency} funds to disburse. Please update the fund balance before disbursing.`
        });
      }

      const newBalance = currentAvailable - numAmount;
      if (fundBalance) {
        await fundBalance.update({
          available_amount: newBalance,
          last_updated_by: actor.id
        }, { transaction: t });
      }

      await FundTransaction.create({
        currency: deCurrency,
        type: 'DISBURSEMENT_DEBIT',
        amount: numAmount,
        balance_after: newBalance,
        reference_id: de.id,
        performed_by: actor.id,
        notes: `Disbursement for Direct Expense ${de.request_number}`
      }, { transaction: t });

      await de.update({ status: 'DISBURSED' }, { transaction: t });

      await auditService.log({
        actorId: actor.id,
        actorName: actor.display_name || actor.username,
        action: 'DISBURSE_DIRECT_EXPENSE',
        entity: 'DIRECT_EXPENSE',
        entityId: de.id,
        details: { disbursement_id: disbursement.id, amount, payment_method }
      }, { transaction: t });

      const note = await notificationService.createNotification({
        target_user_id: de.requester_id,
        title: `Direct Expense Disbursed: ${de.request_number}`,
        body: `Your Direct Expense ${de.request_number} has been disbursed. Please confirm receipt of funds.`,
        link: `/direct-expenses/${de.id}`,
        entity: 'DIRECT_EXPENSE',
        entity_id: de.id
      }, { transaction: t });

      await t.commit();

      (async () => {
        try {
          await emailService.sendNotificationEmailForUser(de.requester_id, note.title, note.body, note.link);
        } catch (err) {
          console.error('Email send error for disburse (DE)', err);
        }
      })();

      return res.json({ message: 'Direct Expense disbursed', disbursement, de_status: 'DISBURSED' });
    } catch (err) {
      try { await t.rollback(); } catch (_) {}
      console.error('disburse (DE) error', err);
      return res.status(500).json({ message: 'Error disbursing Direct Expense' });
    }
  }
];

/**
 * POST /api/direct-expenses/:id/confirm-disbursement
 * User confirms receipt of disbursed funds.
 * Changes status from DISBURSED -> COMPLETED (final state for Direct Expense)
 */
exports.confirmDisbursement = [
  async (req, res) => {
    const t = await sequelize.transaction();
    try {
      const actor = req.currentUser;
      if (!actor) { await t.rollback(); return res.status(401).json({ message: 'Not authenticated' }); }

      const { id } = req.params;
      const de = await DirectExpenseRequest.findByPk(id, { transaction: t });
      if (!de) { await t.rollback(); return res.status(404).json({ message: 'Direct Expense not found' }); }

      if (de.requester_id !== actor.id && !actor.is_admin) {
        await t.rollback();
        return res.status(403).json({ message: 'Only the requester can confirm disbursement receipt' });
      }

      if (de.status !== 'DISBURSED') {
        await t.rollback();
        return res.status(400).json({ message: `Cannot confirm disbursement for Direct Expense in status ${de.status}. Must be DISBURSED.` });
      }

      const disbursement = await Disbursement.findOne({
        where: { direct_expense_id: de.id },
        order: [['disbursed_at', 'DESC']],
        transaction: t
      });

      if (disbursement) {
        await disbursement.update({
          confirmed_by_user: true,
          confirmed_at: new Date()
        }, { transaction: t });
      }

      // COMPLETED is the final status for Direct Expense (no expense submission or reconciliation)
      await de.update({ status: 'COMPLETED' }, { transaction: t });

      await auditService.log({
        actorId: actor.id,
        actorName: actor.display_name || actor.username,
        action: 'CONFIRM_DISBURSEMENT',
        entity: 'DIRECT_EXPENSE',
        entityId: de.id,
        details: { disbursement_id: disbursement?.id }
      }, { transaction: t });

      // Notify cashiers
      const cashiers = await User.findAll({ where: { role: 'cashier', is_active: true }, transaction: t });
      const emailsToSend = [];
      for (const c of cashiers) {
        const note = await notificationService.createNotification({
          target_user_id: c.id,
          title: `Direct Expense Completed: ${de.request_number}`,
          body: `${actor.display_name || actor.username} confirmed receipt of funds for Direct Expense ${de.request_number}. This request is now completed.`,
          link: `/direct-expenses/${de.id}`,
          entity: 'DIRECT_EXPENSE',
          entity_id: de.id
        }, { transaction: t });
        emailsToSend.push({ note, target_user_id: c.id });
      }

      await t.commit();

      (async () => {
        for (const it of emailsToSend) {
          try {
            await emailService.sendNotificationEmailForUser(it.target_user_id, it.note.title, it.note.body, it.note.link);
          } catch (err) {
            console.error('Email send error for confirmDisbursement (DE)', err);
          }
        }
      })();

      return res.json({ message: 'Direct Expense completed', de_status: 'COMPLETED' });
    } catch (err) {
      try { await t.rollback(); } catch (_) {}
      console.error('confirmDisbursement (DE) error', err);
      return res.status(500).json({ message: 'Error confirming disbursement' });
    }
  }
];

/**
 * GET /api/direct-expenses/:id/disbursements
 * List disbursements for a Direct Expense
 */
exports.getDisbursements = [
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor) return res.status(401).json({ message: 'Not authenticated' });

      const { id } = req.params;
      const disbursements = await Disbursement.findAll({
        where: { direct_expense_id: id },
        include: [{ model: User, as: 'cashier', attributes: ['id', 'display_name', 'username'] }],
        order: [['disbursed_at', 'DESC']]
      });

      return res.json({ data: disbursements });
    } catch (err) {
      console.error('getDisbursements (DE) error', err);
      return res.status(500).json({ message: 'Error fetching disbursements' });
    }
  }
];

/**
 * POST /api/direct-expenses/:id/cashier-reject
 * Cashier/admin rejects a Direct Expense at PENDING_HOD_ASSIGNMENT stage
 */
exports.cashierRejectDE = [
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
        return res.status(400).json({ message: 'A reason/comment is required to reject a Direct Expense' });
      }

      const de = await DirectExpenseRequest.findByPk(id, { transaction: t });
      if (!de) { await t.rollback(); return res.status(404).json({ message: 'Direct Expense not found' }); }

      if (de.status !== 'PENDING_HOD_ASSIGNMENT') {
        await t.rollback();
        return res.status(400).json({
          message: `Cannot reject Direct Expense in status "${de.status}". Only requests awaiting approver assignment can be rejected here.`
        });
      }

      await de.update({ status: 'REJECTED' }, { transaction: t });

      const note = await notificationService.createNotification({
        target_user_id: de.requester_id,
        title: `Direct Expense Rejected: ${de.request_number}`,
        body: `Your Direct Expense ${de.request_number} was rejected by ${actor.display_name || actor.username}. Reason: ${comments}`,
        link: `/direct-expenses/${de.id}`,
        entity: 'DIRECT_EXPENSE',
        entity_id: de.id
      }, { transaction: t });
      emailsToSend.push({ note, target_user_id: de.requester_id });

      await auditService.log({
        actorId: actor.id,
        actorName: actor.display_name || actor.username,
        action: 'CASHIER_REJECT_DIRECT_EXPENSE',
        entity: 'DIRECT_EXPENSE',
        entityId: de.id,
        details: { request_number: de.request_number, comments }
      }, { transaction: t });

      await t.commit();

      (async () => {
        for (const it of emailsToSend) {
          try {
            await emailService.sendNotificationEmailForUser(it.target_user_id, it.note.title, it.note.body, it.note.link);
          } catch (err) {
            console.error('Email send error for cashierRejectDE', err);
          }
        }
      })();

      return res.json({ message: 'Direct Expense rejected successfully.' });
    } catch (err) {
      try { await t.rollback(); } catch (_) { }
      console.error('cashierRejectDE error', err);
      return res.status(500).json({ message: 'Error rejecting Direct Expense' });
    }
  }
];

/**
 * POST /api/direct-expenses/:id/cashier-return
 * Cashier/admin returns a Direct Expense for edits at PENDING_HOD_ASSIGNMENT stage
 */
exports.cashierReturnDE = [
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
        return res.status(400).json({ message: 'A reason/comment is required to return a Direct Expense' });
      }

      const de = await DirectExpenseRequest.findByPk(id, { transaction: t });
      if (!de) { await t.rollback(); return res.status(404).json({ message: 'Direct Expense not found' }); }

      if (de.status !== 'PENDING_HOD_ASSIGNMENT') {
        await t.rollback();
        return res.status(400).json({
          message: `Cannot return Direct Expense in status "${de.status}". Only requests awaiting approver assignment can be returned here.`
        });
      }

      await Approval.destroy({ where: { direct_expense_id: de.id, approval_type: 'direct_expense', decision: 'PENDING' }, transaction: t });

      await de.update({ status: 'RETURNED' }, { transaction: t });

      const note = await notificationService.createNotification({
        target_user_id: de.requester_id,
        title: `Direct Expense Returned for Edits: ${de.request_number}`,
        body: `Your Direct Expense ${de.request_number} was returned for changes by ${actor.display_name || actor.username}. Reason: ${comments} - Please edit and re-submit.`,
        link: `/direct-expenses/${de.id}`,
        entity: 'DIRECT_EXPENSE',
        entity_id: de.id
      }, { transaction: t });
      emailsToSend.push({ note, target_user_id: de.requester_id });

      await auditService.log({
        actorId: actor.id,
        actorName: actor.display_name || actor.username,
        action: 'CASHIER_RETURN_DIRECT_EXPENSE',
        entity: 'DIRECT_EXPENSE',
        entityId: de.id,
        details: { request_number: de.request_number, comments }
      }, { transaction: t });

      await t.commit();

      (async () => {
        for (const it of emailsToSend) {
          try {
            await emailService.sendNotificationEmailForUser(it.target_user_id, it.note.title, it.note.body, it.note.link);
          } catch (err) {
            console.error('Email send error for cashierReturnDE', err);
          }
        }
      })();

      return res.json({ message: 'Direct Expense returned for edits successfully.' });
    } catch (err) {
      try { await t.rollback(); } catch (_) { }
      console.error('cashierReturnDE error', err);
      return res.status(500).json({ message: 'Error returning Direct Expense' });
    }
  }
];

