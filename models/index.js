// models/index.js
const sequelize = require('../config/database');

// core models (these must exist)
const User = require('./User');
const IOURequest = require('./IOURequest');
const Approval = require('./Approval');

// optional models - load safely (if file missing, keep null)
let IOUAttachment = null;
let Notification = null;
let AuditLog = null;
let Disbursement = null;
let ExpenseSubmission = null;
let ReconciliationRecord = null;
let Department = null;

try { IOUAttachment = require('./IOUAttachment'); } catch (e) { IOUAttachment = null; }
try { Notification = require('./Notification'); } catch (e) { Notification = null; }
try { AuditLog = require('./AuditLog'); } catch (e) { AuditLog = null; }
try { Disbursement = require('./Disbursement'); } catch (e) { Disbursement = null; }
try { ExpenseSubmission = require('./ExpenseSubmission'); } catch (e) { ExpenseSubmission = null; }
try { ReconciliationRecord = require('./ReconciliationRecord'); } catch (e) { ReconciliationRecord = null; }
try { Department = require('./Department'); } catch (e) { Department = null; }

// --------------------
// Define associations
// --------------------

// IOURequest <-> User (requester)
if (IOURequest && User) {
  IOURequest.belongsTo(User, { foreignKey: 'requester_id', as: 'requester' });
  User.hasMany(IOURequest, { foreignKey: 'requester_id', as: 'ious' });
}

// Approval -> IOURequest and Approval -> User (approver)
if (Approval && IOURequest) {
  Approval.belongsTo(IOURequest, { foreignKey: 'iou_id', as: 'iou' });
  IOURequest.hasMany(Approval, { foreignKey: 'iou_id', as: 'approvals' });
}
if (Approval && User) {
  Approval.belongsTo(User, { foreignKey: 'approver_id', as: 'approver' });
  User.hasMany(Approval, { foreignKey: 'approver_id', as: 'approvalsAssigned' });
}

// IOUAttachment -> IOURequest and -> User (uploader)
if (IOUAttachment && IOURequest) {
  IOUAttachment.belongsTo(IOURequest, { foreignKey: 'iou_id', as: 'iou' });
  IOURequest.hasMany(IOUAttachment, { foreignKey: 'iou_id', as: 'attachments' });
}
if (IOUAttachment && User) {
  IOUAttachment.belongsTo(User, { foreignKey: 'uploaded_by', as: 'uploader' });
  User.hasMany(IOUAttachment, { foreignKey: 'uploaded_by', as: 'uploads' });
}

// Notification -> User (target)
if (Notification && User) {
  Notification.belongsTo(User, { foreignKey: 'target_user_id', as: 'target_user' });
  User.hasMany(Notification, { foreignKey: 'target_user_id', as: 'notifications' });
}

// AuditLog -> User (actor)
if (AuditLog && User) {
  AuditLog.belongsTo(User, { foreignKey: 'actor_id', as: 'actor' });
  User.hasMany(AuditLog, { foreignKey: 'actor_id', as: 'audit_logs' });
}

// Disbursement -> IOURequest and -> User (cashier)
if (Disbursement && IOURequest) {
  Disbursement.belongsTo(IOURequest, { foreignKey: 'iou_id', as: 'iou' });
  IOURequest.hasMany(Disbursement, { foreignKey: 'iou_id', as: 'disbursements' });
}
if (Disbursement && User) {
  Disbursement.belongsTo(User, { foreignKey: 'cashier_id', as: 'cashier' });
  User.hasMany(Disbursement, { foreignKey: 'cashier_id', as: 'disbursementsMade' });
}

// ExpenseSubmission -> IOURequest and -> User (submitter)
if (ExpenseSubmission && IOURequest) {
  ExpenseSubmission.belongsTo(IOURequest, { foreignKey: 'iou_id', as: 'iou' });
  IOURequest.hasMany(ExpenseSubmission, { foreignKey: 'iou_id', as: 'expenses' });
}
if (ExpenseSubmission && User) {
  ExpenseSubmission.belongsTo(User, { foreignKey: 'submitter_id', as: 'submitter' });
  User.hasMany(ExpenseSubmission, { foreignKey: 'submitter_id', as: 'expenseSubmissions' });
}

// ReconciliationRecord -> ExpenseSubmission and -> IOURequest
if (ReconciliationRecord && ExpenseSubmission) {
  ReconciliationRecord.belongsTo(ExpenseSubmission, { foreignKey: 'expense_id', as: 'expense' });
  ExpenseSubmission.hasOne(ReconciliationRecord, { foreignKey: 'expense_id', as: 'reconciliation' });
}
if (ReconciliationRecord && IOURequest) {
  ReconciliationRecord.belongsTo(IOURequest, { foreignKey: 'iou_id', as: 'iou' });
  IOURequest.hasOne(ReconciliationRecord, { foreignKey: 'iou_id', as: 'reconciliation' });
}

// Department -> User (HoD)
if (Department && User) {
  Department.belongsTo(User, { foreignKey: 'hod_user_id', as: 'hod' });
  User.hasOne(Department, { foreignKey: 'hod_user_id', as: 'hodOfDepartment' });
}

// --------------------
// Export everything
// --------------------
module.exports = {
  sequelize,
  User,
  IOURequest,
  Approval,
  IOUAttachment,
  Notification,
  AuditLog,
  Disbursement,
  ExpenseSubmission,
  ReconciliationRecord,
  Department
};
