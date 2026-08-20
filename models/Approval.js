// models/Approval.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class Approval extends Model {}

Approval.init({
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  iou_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  approver_id: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  step_order: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
  },
  decision: {
    type: DataTypes.STRING(32),
    allowNull: false,
    defaultValue: 'PENDING', // PENDING/APPROVED/REJECTED/RETURNED
  },
  comments: {
    type: DataTypes.STRING(2000),
    allowNull: true,
  },
  decision_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  is_delegate: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  approval_type: {
    type: DataTypes.STRING(32),
    allowNull: false,
    defaultValue: 'iou', // 'iou' | 'expense'
  }
}, {
  sequelize,
  modelName: 'Approval',
  tableName: 'approvals',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = Approval;
