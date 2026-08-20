// models/AuditLog.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');
const User = require('./User');

class AuditLog extends Model {}

AuditLog.init({
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  actor_id: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  actor_name: {
    type: DataTypes.STRING(256),
    allowNull: true,
  },
  action: {
    type: DataTypes.STRING(128),
    allowNull: false,
  },
  entity: {
    type: DataTypes.STRING(128),
    allowNull: true,
  },
  entity_id: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  details: {
    type: DataTypes.TEXT,
    allowNull: true,
    get() {
      const val = this.getDataValue('details');
      if (!val) return null;
      if (typeof val === 'object') return val;
      try { return JSON.parse(val); } catch (e) { return val; }
    },
    set(val) {
      if (val === null || val === undefined) {
        this.setDataValue('details', null);
      } else {
        this.setDataValue('details', typeof val === 'string' ? val : JSON.stringify(val));
      }
    }
  }
}, {
  sequelize,
  modelName: 'AuditLog',
  tableName: 'audit_logs',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
  underscored: true,
});

module.exports = AuditLog;
