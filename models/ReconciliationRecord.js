// models/ReconciliationRecord.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class ReconciliationRecord extends Model {}

ReconciliationRecord.init({
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  expense_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  iou_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  estimated_amount: {
    type: DataTypes.DECIMAL(18, 2),
    allowNull: true,
  },
  actual_amount: {
    type: DataTypes.DECIMAL(18, 2),
    allowNull: false,
  },
  diff_amount: {
    type: DataTypes.DECIMAL(18, 2),
    allowNull: false,
  },
  // NONE = same; REFUND = underspent (employee refunds); ADDITIONAL_APPROVAL = overspent
  action_required: {
    type: DataTypes.STRING(64),
    allowNull: false,
    defaultValue: 'NONE',
  },
  notes: {
    type: DataTypes.STRING(2000),
    allowNull: true,
  },
  created_by: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  ifs_voucher_number: {
    type: DataTypes.STRING(64),
    allowNull: true,
  },
  confirmed_by_user: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  user_confirmed_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  confirmed_by_cashier: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  cashier_confirmed_at: {
    type: DataTypes.DATE,
    allowNull: true,
  }
}, {
  sequelize,
  modelName: 'ReconciliationRecord',
  tableName: 'reconciliation_records',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = ReconciliationRecord;
