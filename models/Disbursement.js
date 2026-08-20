// models/Disbursement.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class Disbursement extends Model {}

Disbursement.init({
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  iou_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  cashier_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  amount: {
    type: DataTypes.DECIMAL(18, 2),
    allowNull: false,
  },
  payment_method: {
    type: DataTypes.STRING(64),
    allowNull: true,
  },
  payment_reference: {
    type: DataTypes.STRING(128),
    allowNull: true,
  },
  disbursed_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  notes: {
    type: DataTypes.STRING(1000),
    allowNull: true,
  },
  confirmed_by_user: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  confirmed_at: {
    type: DataTypes.DATE,
    allowNull: true,
  }
}, {
  sequelize,
  modelName: 'Disbursement',
  tableName: 'disbursements',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = Disbursement;
