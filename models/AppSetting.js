// models/AppSetting.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class AppSetting extends Model {}

AppSetting.init({
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  key: {
    type: DataTypes.STRING(128),
    allowNull: false,
    unique: true,
  },
  value: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  description: {
    type: DataTypes.STRING(512),
    allowNull: true,
  }
}, {
  sequelize,
  modelName: 'AppSetting',
  tableName: 'app_settings',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = AppSetting;
