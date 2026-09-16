// models/FundBalance.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class FundBalance extends Model {}

FundBalance.init({
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  currency: {
    type: DataTypes.STRING(8),
    allowNull: false,
    unique: true,
  },
  available_amount: {
    type: DataTypes.DECIMAL(18, 2),
    allowNull: false,
    defaultValue: 0,
  },
  last_updated_by: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true,
  }
}, {
  sequelize,
  modelName: 'FundBalance',
  tableName: 'fund_balances',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = FundBalance;
