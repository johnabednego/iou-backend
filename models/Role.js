const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class Role extends Model {}
Role.init({
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING(64), allowNull: false, unique: true },
  description: DataTypes.STRING(512),
  permissions: {
    type: DataTypes.TEXT,
    get() {
      const val = this.getDataValue('permissions');
      if (!val) return null;
      if (typeof val === 'object') return val;
      try { return JSON.parse(val); } catch (e) { return val; }
    },
    set(val) {
      if (val === null || val === undefined) {
        this.setDataValue('permissions', null);
      } else {
        this.setDataValue('permissions', typeof val === 'string' ? val : JSON.stringify(val));
      }
    }
  },
}, { 
  sequelize, 
  modelName: 'Role', 
  tableName: 'roles', 
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = Role;
