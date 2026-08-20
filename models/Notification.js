// models/Notification.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');
const User = require('./User');

class Notification extends Model {}

Notification.init({
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  target_user_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  title: {
    type: DataTypes.STRING(256),
    allowNull: false
  },
  body: {
    type: DataTypes.STRING(2000),
    allowNull: true
  },
  link: {
    type: DataTypes.STRING(2000),
    allowNull: true
  },
  entity: {
    type: DataTypes.STRING(128),
    allowNull: true
  },
  entity_id: {
    type: DataTypes.UUID,
    allowNull: true
  },
  is_read: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  }
}, {
  sequelize,
  modelName: 'Notification',
  tableName: 'notifications',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
  underscored: true
});

module.exports = Notification;
