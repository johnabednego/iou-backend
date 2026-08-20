// models/Department.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class Department extends Model {}
Department.init({
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING(128), allowNull: false, unique: true },
  code: DataTypes.STRING(32),
  hod_user_id: {
    type: DataTypes.UUID,
    allowNull: true,
    comment: 'Head of Department - references users.id'
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
