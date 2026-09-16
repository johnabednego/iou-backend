// models/Currency.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class Currency extends Model {}

Currency.init({
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  code: {
    type: DataTypes.STRING(8),
    allowNull: false,
    unique: true,
  },
  name: {
    type: DataTypes.STRING(64),
    allowNull: false,
  },
  symbol: {
    type: DataTypes.STRING(8),
    allowNull: true,
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  }
}, {
  sequelize,
  modelName: 'Currency',
  tableName: 'currencies',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = Currency;
