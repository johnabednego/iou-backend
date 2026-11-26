const { Op } = require('sequelize');

const IOU_STATUS_GROUPS = {
  PENDING_GROUP: ['PENDING', 'PENDING_HOD_ASSIGNMENT'],
  APPROVED_READY_GROUP: ['APPROVED', 'APPROVED_FOR_DISBURSEMENT'],
  AWAITING_ACTION_GROUP: ['PENDING', 'PENDING_HOD_ASSIGNMENT', 'APPROVED', 'APPROVED_FOR_DISBURSEMENT'],
  ACTIVE_DISBURSED_GROUP: [
    'DISBURSED',
    'DISBURSEMENT_CONFIRMED',
    'EXPENSE_SUBMITTED',
    'EXPENSE_PENDING_APPROVAL',
    'EXPENSE_RETURNED'
  ],
  SETTLED_GROUP: ['RECONCILED', 'REDEEMED'],
  IN_PROGRESS_GROUP: [
    'DISBURSED',
    'DISBURSEMENT_CONFIRMED',
    'EXPENSE_PENDING_APPROVAL',
    'EXPENSE_SUBMITTED',
    'EXPENSE_RETURNED',
    'RECONCILED'
  ],
  DRAFT_RETURNED_GROUP: ['DRAFT', 'RETURNED'],
  REJECTED_GROUP: ['REJECTED', 'CANCELLED'],
  APPROVED_GROUP: [
    'APPROVED',
    'APPROVED_FOR_DISBURSEMENT',
    'DISBURSED',
    'DISBURSEMENT_CONFIRMED',
    'EXPENSE_PENDING_APPROVAL',
    'EXPENSE_SUBMITTED',
    'EXPENSE_RETURNED',
    'RECONCILED',
    'REDEEMED'
  ]
};

const DE_STATUS_GROUPS = {
  PENDING_GROUP: ['PENDING', 'PENDING_HOD_ASSIGNMENT'],
  AWAITING_ACTION_GROUP: ['PENDING', 'PENDING_HOD_ASSIGNMENT', 'APPROVED_FOR_DISBURSEMENT'],
  IN_PROGRESS_GROUP: ['DISBURSED', 'DISBURSEMENT_CONFIRMED'],
  DRAFT_RETURNED_GROUP: ['DRAFT', 'RETURNED'],
  REJECTED_GROUP: ['REJECTED', 'CANCELLED'],
  APPROVED_GROUP: ['APPROVED_FOR_DISBURSEMENT', 'DISBURSED', 'DISBURSEMENT_CONFIRMED', 'COMPLETED']
};

function resolveStatusFilter(rawStatus, groups) {
  const st = String(rawStatus || '').trim();
  if (!st) return null;
  if (groups[st]) return { [Op.in]: groups[st] };
  if (st.includes(',')) {
    const parts = st.split(',').map(s => s.trim()).filter(Boolean);
    return parts.length > 0 ? { [Op.in]: parts } : null;
  }
  return st;
}

function resolveIouStatusFilter(rawStatus) {
  return resolveStatusFilter(rawStatus, IOU_STATUS_GROUPS);
}

function resolveDeStatusFilter(rawStatus) {
  return resolveStatusFilter(rawStatus, DE_STATUS_GROUPS);
}

/**
 * Parses a YYYY-MM-DD (or date-time) string into a Date at local start/end of day.
 */
function parseDateBoundary(dateStr, endOfDay = false) {
  const s = String(dateStr || '').trim();
  if (!s) return null;
  const ymdMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (ymdMatch) {
    const year = parseInt(ymdMatch[1], 10);
    const month = parseInt(ymdMatch[2], 10) - 1;
    const day = parseInt(ymdMatch[3], 10);
    return endOfDay
      ? new Date(year, month, day, 23, 59, 59, 999)
      : new Date(year, month, day, 0, 0, 0, 0);
  }
  const parsed = new Date(s);
  if (isNaN(parsed.getTime())) return null;
  if (endOfDay) parsed.setHours(23, 59, 59, 999);
  return parsed;
}

module.exports = {
  IOU_STATUS_GROUPS,
  DE_STATUS_GROUPS,
  resolveIouStatusFilter,
  resolveDeStatusFilter,
  parseDateBoundary
};
