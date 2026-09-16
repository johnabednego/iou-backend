// models/FundTransaction.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class FundTransaction extends Model {}

FundTransaction.init({
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  currency: {
    type: DataTypes.STRING(8),
    allowNull: false,
  },
  type: {
    // MANUAL_CREDIT, MANUAL_DEBIT, MANUAL_SET, DISBURSEMENT_DEBIT, RECONCILIATION_ADJUSTMENT
    type: DataTypes.STRING(32),
    allowNull: false,
  },
  amount: {
    type: DataTypes.DECIMAL(18, 2),
    allowNull: false,
  },
  balance_after: {
    type: DataTypes.DECIMAL(18, 2),
    allowNull: false,
  },
  reference_id: {
    // IOU id when auto-triggered
    type: DataTypes.UUID,
    allowNull: true,
  },
  performed_by: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true,
  }
}, {
  sequelize,
  modelName: 'FundTransaction',
  tableName: 'fund_transactions',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = FundTransaction;
