const { Op } = require('sequelize');
const Department = require('../models/Department');
const DepartmentHOD = require('../models/DepartmentHOD');
const Approval = require('../models/Approval');

/**
 * Authorizers include users with role === 'authorizer' OR managed approvers (is_approver === true).
 */
function isAuthorizerUser(actor) {
  return Boolean(actor && (actor.role === 'authorizer' || actor.is_approver === true));
}

/**
 * Users who have company-wide visibility across all departments:
 * Admins, Cashiers, Authorizers, and Managed Approvers.
 */
function canViewAllCompany(actor) {
  return Boolean(
    actor &&
    (actor.is_admin === true || actor.role === 'cashier' || isAuthorizerUser(actor))
  );
}

/**
 * Head of Department role check.
 */
function isHodUser(actor) {
  return Boolean(actor && actor.role === 'hod');
}

/**
 * Resolve all department names actively managed by an HOD user.
 * Non-HOD employees must never gain department-wide visibility from their user.department.
 */
async function getManagedDepartmentNames(actor) {
  if (!actor || actor.role !== 'hod') return [];
  try {
    const hodLinks = await DepartmentHOD.findAll({
      where: { user_id: actor.id },
      attributes: ['department_id'],
      raw: true
    });
    const deptIds = hodLinks.map(h => h.department_id).filter(Boolean);
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
    const deptNames = managedDepts.map(d => d.name).filter(Boolean);
    if (actor.department && !deptNames.includes(actor.department)) {
      deptNames.push(actor.department);
    }
    return deptNames;
  } catch (_) {
    return actor.department ? [actor.department] : [];
  }
}

/**
 * Detail-page / attachment access control check for a single IOU or Direct Expense record.
 */
async function canViewRequestDetail(actor, record, approvalWhere = {}) {
  if (!actor || !record) return false;
  if (canViewAllCompany(actor)) return true;
  if (String(record.requester_id) === String(actor.id)) return true;

  if (isHodUser(actor)) {
    const hodDepts = await getManagedDepartmentNames(actor);
    if (record.department && hodDepts.includes(record.department)) {
      return true;
    }
  }

  const approverRecord = await Approval.findOne({
    where: { ...approvalWhere, approver_id: actor.id },
    attributes: ['id'],
    raw: true
  });
  return Boolean(approverRecord);
}

/**
 * Compute Sequelize visibility constraint for list queries according to role and requested scope:
 * - scope = 'mine': requests created by the actor
 * - scope = 'approvals': requests where actor is in the Approval chain
 * - scope = 'department': requests belonging to HOD's managed department(s) (HOD or company-wide only)
 * - scope = 'all' / omitted: full authorized scope for role
 *   - Admin / Cashier / Authorizer: company-wide
 *   - HOD: managed departments + own submissions + assigned approvals
 *   - Employee: ONLY own submissions (+ any explicitly assigned approvals), never coworkers in their department
 */
async function buildListVisibility({
  actor,
  requestedScope,
  allFlag,
  requesterIdQ,
  getApprovedIdsFn
}) {
  const scope = String(requestedScope || '').toLowerCase().trim();
  const explicitFalseAll = allFlag === 'false' || allFlag === false;
  const companyWide = canViewAllCompany(actor);
  const isHod = isHodUser(actor);

  // Explicit "My Submissions" (strictly requests created by actor)
  if (scope === 'mine' || (companyWide && explicitFalseAll)) {
    return { mode: 'FILTERED', condition: { requester_id: actor.id } };
  }

  // Explicit "My Approvals" (requests where actor is assigned / acted in Approval chain)
  if (scope === 'approvals') {
    const approvedIds = await getApprovedIdsFn(actor.id);
    if (!approvedIds || approvedIds.length === 0) {
      return { mode: 'EMPTY', condition: null };
    }
    return { mode: 'FILTERED', condition: { id: { [Op.in]: approvedIds } } };
  }

  // Explicit "Department Requests" (only meaningful for HOD or company-wide; employees are blocked)
  if (scope === 'department') {
    if (isHod && !companyWide) {
      const hodDepts = await getManagedDepartmentNames(actor);
      if (hodDepts.length > 0) {
        return { mode: 'FILTERED', condition: { department: { [Op.in]: hodDepts } } };
      }
      return { mode: 'FILTERED', condition: { requester_id: actor.id } };
    }
    if (companyWide) {
      return { mode: 'UNRESTRICTED', condition: null };
    }
    // Employee falls through to strict employee visibility
  }

  // Company-wide users ('all' or default)
  if (companyWide) {
    if (requesterIdQ && allFlag !== 'true' && allFlag !== true && scope !== 'all') {
      return { mode: 'FILTERED', condition: { requester_id: requesterIdQ } };
    }
    return { mode: 'UNRESTRICTED', condition: null };
  }

  // HOD default ('all' or omitted): managed department(s) + own + assigned approvals
  if (isHod) {
    const conds = [{ requester_id: actor.id }];
    const [hodDepts, approvedIds] = await Promise.all([
      getManagedDepartmentNames(actor),
      getApprovedIdsFn(actor.id)
    ]);
    if (hodDepts.length > 0) {
      conds.push({ department: { [Op.in]: hodDepts } });
    }
    if (approvedIds && approvedIds.length > 0) {
      conds.push({ id: { [Op.in]: approvedIds } });
    }
    return { mode: 'FILTERED', condition: conds.length === 1 ? conds[0] : { [Op.or]: conds } };
  }

  // Standard employee: ONLY own submissions + explicitly assigned approvals (never department-wide)
  const approvedIds = await getApprovedIdsFn(actor.id);
  if (approvedIds && approvedIds.length > 0) {
    return {
      mode: 'FILTERED',
      condition: { [Op.or]: [{ requester_id: actor.id }, { id: { [Op.in]: approvedIds } }] }
    };
  }
  return { mode: 'FILTERED', condition: { requester_id: actor.id } };
}

module.exports = {
  isAuthorizerUser,
  canViewAllCompany,
  isHodUser,
  getManagedDepartmentNames,
  canViewRequestDetail,
  buildListVisibility
};
