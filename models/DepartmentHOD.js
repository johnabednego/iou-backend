// models/DepartmentHOD.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class DepartmentHOD extends Model {}
DepartmentHOD.init({
  id: { 
    type: DataTypes.UUID, 
    defaultValue: DataTypes.UUIDV4, 
    primaryKey: true 
  },
  department_id: {
    type: DataTypes.UUID,
    allowNull: false,
    comment: 'References departments.id'
  },
  user_id: {
    type: DataTypes.UUID,
    allowNull: false,
    comment: 'References users.id'
  }
}, {
  sequelize,
  modelName: 'DepartmentHOD',
  tableName: 'department_hods',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = DepartmentHOD;
