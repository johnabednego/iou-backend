// controllers/exportController.js
const { IOURequest, User, Approval, Disbursement, ExpenseSubmission, ReconciliationRecord } = require('../models');
const { Op } = require('sequelize');
const ExcelJS = require('exceljs');

/**
 * GET /api/ious/export
 * Export REDEEMED IOUs to Excel (.xlsx) with FULL transaction details.
 * Access: ONLY cashier, admin, or is_approver=true. Normal users are blocked entirely.
 * Always forces status=REDEEMED regardless of client input.
 */
exports.exportRedeemed = [
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor) return res.status(401).json({ message: 'Not authenticated' });

      // Access control: ONLY cashier, admin, or managed approver — no exceptions
      const canExport = actor.is_admin || actor.role === 'cashier' || actor.is_approver === true;
      if (!canExport) {
        return res.status(403).json({
          message: 'Export is restricted to Cashiers, Admins, and Approvers only.'
        });
      }

      // Build query - always force REDEEMED status
      const where = { status: 'REDEEMED' };

      // Date range
      if (req.query.start_date || req.query.end_date) {
        where.created_at = {};
        if (req.query.start_date) where.created_at[Op.gte] = new Date(req.query.start_date);
        if (req.query.end_date) {
          const end = new Date(req.query.end_date);
          end.setHours(23, 59, 59, 999);
          where.created_at[Op.lte] = end;
        }
      }

      // Search
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
          searchOr.push({ estimated_amount: numSearch });
        }
        where[Op.or] = searchOr;
      }

      // Fetch IOUs with ALL related data
      const rows = await IOURequest.findAll({
        where,
        include: [
          {
            model: User,
            as: 'requester',
            attributes: ['id', 'display_name', 'username', 'email', 'department'],
            required: false
          },
          {
            model: Approval,
            as: 'approvals',
            include: [
              { model: User, as: 'approver', attributes: ['id', 'display_name', 'username'], required: false }
            ],
            required: false
          },
          {
            model: Disbursement,
            as: 'disbursements',
            include: [
              { model: User, as: 'cashier', attributes: ['id', 'display_name', 'username'], required: false }
            ],
            required: false
          },
          {
            model: ExpenseSubmission,
            as: 'expenses',
            include: [
              { model: User, as: 'submitter', attributes: ['id', 'display_name', 'username'], required: false }
            ],
            required: false
          },
          {
            model: ReconciliationRecord,
            as: 'reconciliation',
            required: false
          }
        ],
        order: [['created_at', 'DESC']],
        limit: 10000
      });

      // Helper to format date
      const fmtDate = (dt) => {
        if (!dt) return '';
        const d = new Date(dt);
        return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) + ' ' +
               d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      };

      // Create Excel workbook
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'MPS IOU Manager';
      workbook.created = new Date();

      const sheet = workbook.addWorksheet('Redeemed IOUs', {
        headerFooter: { firstHeader: 'MPS IOU Manager - Redeemed IOUs Full Export' }
      });

      // Define columns - full A-to-Z transaction details
      sheet.columns = [
        // === IOU Request Details ===
        { header: 'Request #', key: 'request_number', width: 25 },
        { header: 'IFS Voucher #', key: 'ifs_voucher_number', width: 18 },
        { header: 'Purpose', key: 'purpose', width: 40 },
        { header: 'Requester', key: 'requester_name', width: 22 },
        { header: 'Requester Email', key: 'requester_email', width: 28 },
        { header: 'Department', key: 'department', width: 18 },
        { header: 'Estimated Amount', key: 'estimated_amount', width: 18 },
        { header: 'Currency', key: 'currency', width: 10 },
        { header: 'Status', key: 'status', width: 14 },
        { header: 'Submitted Date', key: 'submitted_at', width: 20 },
        { header: 'Created Date', key: 'created_at', width: 20 },

        // === Approval Chain ===
        { header: 'Approver 1', key: 'approver_1_name', width: 22 },
        { header: 'Approver 1 Decision', key: 'approver_1_decision', width: 18 },
        { header: 'Approver 1 Comments', key: 'approver_1_comments', width: 30 },
        { header: 'Approver 1 Date', key: 'approver_1_date', width: 20 },
        { header: 'Approver 2', key: 'approver_2_name', width: 22 },
        { header: 'Approver 2 Decision', key: 'approver_2_decision', width: 18 },
        { header: 'Approver 2 Comments', key: 'approver_2_comments', width: 30 },
        { header: 'Approver 2 Date', key: 'approver_2_date', width: 20 },
        { header: 'Approver 3', key: 'approver_3_name', width: 22 },
        { header: 'Approver 3 Decision', key: 'approver_3_decision', width: 18 },
        { header: 'Approver 3 Comments', key: 'approver_3_comments', width: 30 },
        { header: 'Approver 3 Date', key: 'approver_3_date', width: 20 },

        // === Disbursement Details ===
        { header: 'Disbursed Amount', key: 'disbursed_amount', width: 18 },
        { header: 'Payment Method', key: 'payment_method', width: 16 },
        { header: 'Payment Reference', key: 'payment_reference', width: 20 },
        { header: 'Disbursed By', key: 'disbursed_by', width: 22 },
        { header: 'Disbursed Date', key: 'disbursed_at', width: 20 },
        { header: 'Disbursement Notes', key: 'disbursement_notes', width: 30 },
        { header: 'User Confirmed Receipt', key: 'user_confirmed_receipt', width: 20 },
        { header: 'Receipt Confirmed Date', key: 'receipt_confirmed_at', width: 20 },

        // === Expense Submission Details ===
        { header: 'Actual Amount Spent', key: 'actual_amount', width: 18 },
        { header: 'Expense Status', key: 'expense_status', width: 16 },
        { header: 'Expense Submitted By', key: 'expense_submitted_by', width: 22 },
        { header: 'Expense Submitted Date', key: 'expense_submitted_at', width: 20 },
        { header: 'Expense Notes', key: 'expense_notes', width: 30 },

        // === Reconciliation Details ===
        { header: 'Reconciled Estimated', key: 'recon_estimated', width: 18 },
        { header: 'Reconciled Actual', key: 'recon_actual', width: 18 },
        { header: 'Difference', key: 'recon_diff', width: 14 },
        { header: 'Action Required', key: 'recon_action', width: 22 },
        { header: 'Reconciliation IFS Voucher', key: 'recon_ifs_voucher', width: 22 },
        { header: 'Reconciliation Notes', key: 'recon_notes', width: 30 },
        { header: 'User Confirmed Recon', key: 'recon_user_confirmed', width: 18 },
        { header: 'Cashier Confirmed Recon', key: 'recon_cashier_confirmed', width: 20 },

        // === Timestamps ===
        { header: 'Last Updated', key: 'updated_at', width: 20 },
      ];

      // Style header row
      const headerRow = sheet.getRow(1);
      headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
      headerRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1F88E5' }
      };
      headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      headerRow.height = 30;

      // Add data rows
      for (const iou of rows) {
        // Sort approvals by step_order
        const approvals = (iou.approvals || []).sort((a, b) => (a.step_order || 0) - (b.step_order || 0));
        const ap1 = approvals[0] || {};
        const ap2 = approvals[1] || {};
        const ap3 = approvals[2] || {};

        // Latest disbursement
        const disb = (iou.disbursements || []).sort((a, b) => new Date(b.disbursed_at || 0) - new Date(a.disbursed_at || 0))[0] || {};

        // Latest expense
        const expense = (iou.expenses || []).sort((a, b) => new Date(b.submitted_at || b.created_at || 0) - new Date(a.submitted_at || a.created_at || 0))[0] || {};

        // Reconciliation
        const recon = iou.reconciliation || {};

        sheet.addRow({
          // IOU details
          request_number: iou.request_number || '',
          ifs_voucher_number: iou.ifs_voucher_number || '',
          purpose: iou.purpose || '',
          requester_name: iou.requester?.display_name || iou.requester?.username || '',
          requester_email: iou.requester?.email || '',
          department: iou.department || iou.requester?.department || '',
          estimated_amount: iou.estimated_amount ? Number(iou.estimated_amount) : 0,
          currency: iou.currency || 'GHS',
          status: iou.status || '',
          submitted_at: fmtDate(iou.submitted_at),
          created_at: fmtDate(iou.created_at),

          // Approver 1
          approver_1_name: ap1.approver?.display_name || ap1.approver?.username || '',
          approver_1_decision: ap1.decision || '',
          approver_1_comments: ap1.comments || '',
          approver_1_date: fmtDate(ap1.decision_at),

          // Approver 2
          approver_2_name: ap2.approver?.display_name || ap2.approver?.username || '',
          approver_2_decision: ap2.decision || '',
          approver_2_comments: ap2.comments || '',
          approver_2_date: fmtDate(ap2.decision_at),

          // Approver 3
          approver_3_name: ap3.approver?.display_name || ap3.approver?.username || '',
          approver_3_decision: ap3.decision || '',
          approver_3_comments: ap3.comments || '',
          approver_3_date: fmtDate(ap3.decision_at),

          // Disbursement
          disbursed_amount: disb.amount ? Number(disb.amount) : '',
          payment_method: disb.payment_method || '',
          payment_reference: disb.payment_reference || '',
          disbursed_by: disb.cashier?.display_name || disb.cashier?.username || '',
          disbursed_at: fmtDate(disb.disbursed_at),
          disbursement_notes: disb.notes || '',
          user_confirmed_receipt: disb.confirmed_by_user ? 'Yes' : 'No',
          receipt_confirmed_at: fmtDate(disb.confirmed_at),

          // Expense
          actual_amount: expense.actual_amount ? Number(expense.actual_amount) : '',
          expense_status: expense.status || '',
          expense_submitted_by: expense.submitter?.display_name || expense.submitter?.username || '',
          expense_submitted_at: fmtDate(expense.submitted_at),
          expense_notes: expense.notes || '',

          // Reconciliation
          recon_estimated: recon.estimated_amount ? Number(recon.estimated_amount) : '',
          recon_actual: recon.actual_amount ? Number(recon.actual_amount) : '',
          recon_diff: recon.diff_amount ? Number(recon.diff_amount) : '',
          recon_action: recon.action_required || '',
          recon_ifs_voucher: recon.ifs_voucher_number || '',
          recon_notes: recon.notes || '',
          recon_user_confirmed: recon.confirmed_by_user ? 'Yes' : 'No',
          recon_cashier_confirmed: recon.confirmed_by_cashier ? 'Yes' : 'No',

          // Timestamps
          updated_at: fmtDate(iou.updated_at),
        });
      }

      // Section header coloring: apply different fill colors for each section
      const sectionColors = {
        // Cols A-K (1-11): IOU details - blue
        iou: { start: 1, end: 11, color: 'FF1F88E5' },
        // Cols L-W (12-23): Approvals - green
        approvals: { start: 12, end: 23, color: 'FF2E7D32' },
        // Cols X-AE (24-31): Disbursement - orange
        disbursement: { start: 24, end: 31, color: 'FFE65100' },
        // Cols AF-AJ (32-36): Expense - purple
        expense: { start: 32, end: 36, color: 'FF6A1B9A' },
        // Cols AK-AR (37-44): Reconciliation - teal
        reconciliation: { start: 37, end: 44, color: 'FF00695C' },
        // Col AS (45): Timestamps - dark grey
        timestamps: { start: 45, end: 45, color: 'FF37474F' },
      };

      for (const section of Object.values(sectionColors)) {
        for (let col = section.start; col <= section.end; col++) {
          const cell = headerRow.getCell(col);
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: section.color }
          };
        }
      }

      // Auto-filter
      if (rows.length > 0) {
        const lastCol = sheet.columnCount;
        const lastColLetter = sheet.getColumn(lastCol).letter;
        sheet.autoFilter = {
          from: 'A1',
          to: `${lastColLetter}${rows.length + 1}`
        };
      }

      // Freeze first row and first column
      sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 1, topLeftCell: 'B2' }];

      // Set response headers
      const timestamp = new Date().toISOString().slice(0, 10);
      const filename = `redeemed_ious_full_${timestamp}.xlsx`;

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      await workbook.xlsx.write(res);
      res.end();
    } catch (err) {
      console.error('exportRedeemed error', err);
      return res.status(500).json({ message: 'Error exporting IOUs' });
    }
  }
];
