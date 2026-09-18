// controllers/analyticsController.js
const IOURequest = require('../models/IOURequest');
const ReconciliationRecord = require('../models/ReconciliationRecord');
const sequelize = require('../config/database');
const { Op, fn, col, literal } = require('sequelize');

/**
 * GET /api/analytics/dashboard
 * Returns comprehensive analytics for the dashboard charts.
 * Access: authenticated users. Normal users see only their own; admin/cashier/approver see all.
 */
exports.getDashboardAnalytics = [
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor) return res.status(401).json({ message: 'Not authenticated' });

      const isPrivileged = actor.is_admin || actor.role === 'cashier' || actor.is_approver;
      const isHod = actor.role === 'hod';
      let userFilter = {};

      // Find departments managed by HOD
      let hodDeptNames = [];
      if (isHod) {
        try {
          const DepartmentHOD = require('../models/DepartmentHOD');
          const Department = require('../models/Department');
          const hodLinks = await DepartmentHOD.findAll({ where: { user_id: actor.id }, attributes: ['department_id'], raw: true });
          const deptIds = hodLinks.map(h => h.department_id);
          const managedDepts = await Department.findAll({
            where: { [Op.or]: [...(deptIds.length > 0 ? [{ id: { [Op.in]: deptIds } }] : []), { hod_user_id: actor.id }] },
            attributes: ['name'], raw: true
          });
          hodDeptNames = managedDepts.map(d => d.name);
          if (actor.department && !hodDeptNames.includes(actor.department)) {
            hodDeptNames.push(actor.department);
          }
        } catch (_) {}
      }

      if (isPrivileged) {
        userFilter = {};
      } else if (isHod && hodDeptNames.length > 0) {
        userFilter = {
          [Op.or]: [
            { department: { [Op.in]: hodDeptNames } },
            { requester_id: actor.id }
          ]
        };
      } else {
        userFilter = { requester_id: actor.id };
      }

      // Department filter from query param
      const queryDept = req.query.department ? req.query.department.trim() : null;
      if (queryDept) {
        if (isPrivileged || (isHod && hodDeptNames.includes(queryDept))) {
          userFilter = { ...userFilter, department: queryDept };
        }
      }

      const now = new Date();

      // ─── 1. IOUs by Month (last 12 months) ───
      const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);
      const iousByMonth = [];
      for (let m = 0; m < 12; m++) {
        const monthStart = new Date(twelveMonthsAgo.getFullYear(), twelveMonthsAgo.getMonth() + m, 1);
        const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0, 23, 59, 59, 999);
        const monthLabel = monthStart.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

        const statusCounts = await IOURequest.findAll({
          attributes: ['status', [fn('COUNT', col('id')), 'count']],
          where: {
            ...userFilter,
            created_at: { [Op.between]: [monthStart, monthEnd] }
          },
          group: ['status'],
          raw: true
        });

        const pending = statusCounts
          .filter(r => ['PENDING', 'PENDING_HOD_ASSIGNMENT'].includes(r.status))
          .reduce((sum, r) => sum + parseInt(r.count), 0);
        const approved = statusCounts
          .filter(r => ['APPROVED', 'APPROVED_FOR_DISBURSEMENT', 'DISBURSED', 'DISBURSEMENT_CONFIRMED', 'EXPENSE_SUBMITTED', 'EXPENSE_PENDING_APPROVAL', 'RECONCILED', 'REDEEMED'].includes(r.status))
          .reduce((sum, r) => sum + parseInt(r.count), 0);
        const rejected = statusCounts
          .filter(r => ['REJECTED', 'CANCELLED'].includes(r.status))
          .reduce((sum, r) => sum + parseInt(r.count), 0);

        iousByMonth.push({ month: monthLabel, pending, approved, rejected, total: pending + approved + rejected });
      }

      // ─── 2. IOUs by Week (last 8 weeks) ───
      const iousByWeek = [];
      for (let w = 7; w >= 0; w--) {
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - (w * 7) - now.getDay());
        weekStart.setHours(0, 0, 0, 0);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);
        weekEnd.setHours(23, 59, 59, 999);

        const weekLabel = weekStart.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });

        const count = await IOURequest.count({
          where: {
            ...userFilter,
            created_at: { [Op.between]: [weekStart, weekEnd] }
          }
        });

        iousByWeek.push({ week: weekLabel, count });
      }

      // ─── 3. Spending Breakdown (Overspent / Underspent / Exact) ───
      let spendingWhere = {};
      if (isPrivileged && !queryDept) {
        spendingWhere = {};
      } else {
        const matchingIous = await IOURequest.findAll({
          attributes: ['id'],
          where: userFilter,
          raw: true
        });
        spendingWhere = { iou_id: { [Op.in]: matchingIous.map(i => i.id) } };
      }

      const reconciliations = await ReconciliationRecord.findAll({
        attributes: ['diff_amount'],
        where: spendingWhere,
        raw: true
      });

      let overspent = 0, underspent = 0, exact = 0;
      for (const r of reconciliations) {
        const diff = Number(r.diff_amount);
        if (diff > 0) overspent++;
        else if (diff < 0) underspent++;
        else exact++;
      }
      const spendingBreakdown = { overspent, underspent, exact };

      // ─── 4. Status Distribution ───
      const statusDist = await IOURequest.findAll({
        attributes: ['status', [fn('COUNT', col('id')), 'count']],
        where: userFilter,
        group: ['status'],
        raw: true
      });

      const statusLabels = {
        'DRAFT': 'Draft',
        'PENDING_HOD_ASSIGNMENT': 'Awaiting Assignment',
        'PENDING': 'Pending',
        'APPROVED': 'Approved',
        'APPROVED_FOR_DISBURSEMENT': 'For Disbursement',
        'DISBURSED': 'Disbursed',
        'DISBURSEMENT_CONFIRMED': 'Funds Confirmed',
        'EXPENSE_SUBMITTED': 'Expense Submitted',
        'EXPENSE_PENDING_APPROVAL': 'Expense Approval',
        'RECONCILED': 'Reconciled',
        'REDEEMED': 'Redeemed',
        'RETURNED': 'Returned',
        'REJECTED': 'Rejected',
        'CANCELLED': 'Cancelled'
      };

      const statusDistribution = statusDist.map(s => ({
        status: s.status,
        label: statusLabels[s.status] || s.status,
        count: parseInt(s.count)
      }));

      // ─── 5. Approved Amounts by Currency (weekly, monthly, yearly, overall) ───
      const approvedStatuses = ['APPROVED', 'APPROVED_FOR_DISBURSEMENT', 'DISBURSED', 'DISBURSEMENT_CONFIRMED',
        'EXPENSE_SUBMITTED', 'EXPENSE_PENDING_APPROVAL', 'RECONCILED', 'REDEEMED'];

      // Overall
      const overallAmounts = await IOURequest.findAll({
        attributes: ['currency', [fn('SUM', col('estimated_amount')), 'total']],
        where: { ...userFilter, status: { [Op.in]: approvedStatuses } },
        group: ['currency'],
        raw: true
      });

      // This week
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - now.getDay());
      weekStart.setHours(0, 0, 0, 0);

      const weeklyAmounts = await IOURequest.findAll({
        attributes: ['currency', [fn('SUM', col('estimated_amount')), 'total']],
        where: {
          ...userFilter,
          status: { [Op.in]: approvedStatuses },
          created_at: { [Op.gte]: weekStart }
        },
        group: ['currency'],
        raw: true
      });

      // This month
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const monthlyAmounts = await IOURequest.findAll({
        attributes: ['currency', [fn('SUM', col('estimated_amount')), 'total']],
        where: {
          ...userFilter,
          status: { [Op.in]: approvedStatuses },
          created_at: { [Op.gte]: monthStart }
        },
        group: ['currency'],
        raw: true
      });

      // This year
      const yearStart = new Date(now.getFullYear(), 0, 1);
      const yearlyAmounts = await IOURequest.findAll({
        attributes: ['currency', [fn('SUM', col('estimated_amount')), 'total']],
        where: {
          ...userFilter,
          status: { [Op.in]: approvedStatuses },
          created_at: { [Op.gte]: yearStart }
        },
        group: ['currency'],
        raw: true
      });

      const toMap = (arr) => {
        const m = {};
        for (const r of arr) m[r.currency] = Number(r.total) || 0;
        return m;
      };

      const approvedAmounts = {
        weekly: toMap(weeklyAmounts),
        monthly: toMap(monthlyAmounts),
        yearly: toMap(yearlyAmounts),
        overall: toMap(overallAmounts)
      };

      // ─── 6. Pending total (ALL pending) ───
      const pendingTotal = await IOURequest.count({
        where: { ...userFilter, status: { [Op.in]: ['PENDING', 'PENDING_HOD_ASSIGNMENT'] } }
      });

      // ─── 7. Currency summary ───
      const currencySummary = await IOURequest.findAll({
        attributes: [
          'currency',
          [fn('COUNT', col('id')), 'count'],
          [fn('SUM', col('estimated_amount')), 'total_amount']
        ],
        where: userFilter,
        group: ['currency'],
        raw: true
      });

      // ─── 8. Monthly approved amounts chart (last 12 months per currency) ───
      const monthlyApprovedChart = [];
      for (let m = 0; m < 12; m++) {
        const mStart = new Date(twelveMonthsAgo.getFullYear(), twelveMonthsAgo.getMonth() + m, 1);
        const mEnd = new Date(mStart.getFullYear(), mStart.getMonth() + 1, 0, 23, 59, 59, 999);
        const mLabel = mStart.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

        const amounts = await IOURequest.findAll({
          attributes: ['currency', [fn('SUM', col('estimated_amount')), 'total']],
          where: {
            ...userFilter,
            status: { [Op.in]: approvedStatuses },
            created_at: { [Op.between]: [mStart, mEnd] }
          },
          group: ['currency'],
          raw: true
        });

        const entry = { month: mLabel };
        for (const a of amounts) {
          entry[a.currency] = Number(a.total) || 0;
        }
        monthlyApprovedChart.push(entry);
      }

      // ─── 9. Department Breakdown ───
      const deptBreakdownRaw = await IOURequest.findAll({
        attributes: [
          'department',
          [fn('COUNT', col('id')), 'count'],
          [fn('SUM', col('estimated_amount')), 'total_amount']
        ],
        where: {
          ...userFilter,
          department: { [Op.ne]: null }
        },
        group: ['department'],
        order: [[fn('COUNT', col('id')), 'DESC']],
        raw: true
      });

      const departmentBreakdown = deptBreakdownRaw.map(d => ({
        department: d.department || 'Unassigned',
        count: parseInt(d.count) || 0,
        total_amount: Number(d.total_amount) || 0
      }));

      return res.json({
        data: {
          iousByMonth,
          iousByWeek,
          spendingBreakdown,
          statusDistribution,
          approvedAmounts,
          pendingTotal,
          currencySummary: currencySummary.map(c => ({
            currency: c.currency,
            count: parseInt(c.count),
            total_amount: Number(c.total_amount) || 0
          })),
          monthlyApprovedChart,
          departmentBreakdown,
          userDepartments: hodDeptNames
        }
      });
    } catch (err) {
      console.error('getDashboardAnalytics error', err);
      return res.status(500).json({ message: 'Error generating analytics' });
    }
  }
];
