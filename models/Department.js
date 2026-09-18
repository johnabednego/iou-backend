// models/Department.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class Department extends Model {}
Department.init({
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING(128), allowNull: false, unique: true },
  code: DataTypes.STRING(32),
  description: { type: DataTypes.STRING(256), allowNull: true },
  is_active: { type: DataTypes.BOOLEAN, defaultValue: true },
  ldap_aliases: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Comma-separated LDAP department name variations that map to this department'
  },
  hod_user_id: {
    type: DataTypes.UUID,
    allowNull: true,
    comment: 'Primary/Legacy Head of Department - references users.id'
  }
}, { 
  sequelize, 
  modelName: 'Department', 
  tableName: 'departments', 
  timestamps: true, 
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = Department;
