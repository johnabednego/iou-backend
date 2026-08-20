// models/IOURequest.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class IOURequest extends Model {}

IOURequest.init({
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  request_number: {
    type: DataTypes.STRING(64),
    allowNull: false,
    unique: true,
  },
  requester_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  department: {
    type: DataTypes.STRING(256),
    allowNull: true,
  },
  purpose: {
    type: DataTypes.STRING(1000),
    allowNull: true,
  },
  estimated_amount: {
    type: DataTypes.DECIMAL(18,2),
    allowNull: true,
  },
  currency: {
    type: DataTypes.STRING(8),
    allowNull: false,
    defaultValue: 'GHS',
  },
  status: {
    type: DataTypes.STRING(64),
    allowNull: false,
    defaultValue: 'DRAFT',
  },
  submitted_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  metadata: {
    type: DataTypes.TEXT,
    allowNull: true,
    get() {
      const val = this.getDataValue('metadata');
      if (!val) return null;
      if (typeof val === 'object') return val;
      try { return JSON.parse(val); } catch (e) { return val; }
    },
    set(val) {
      if (val === null || val === undefined) {
        this.setDataValue('metadata', null);
      } else {
        this.setDataValue('metadata', typeof val === 'string' ? val : JSON.stringify(val));
      }
    }
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
  ifs_voucher_number: {
    type: DataTypes.STRING(64),
    allowNull: true,
  }
}, {
  sequelize,
  modelName: 'IOURequest',
  tableName: 'iou_requests',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = IOURequest;
