// models/ExpenseSubmission.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class ExpenseSubmission extends Model {}

ExpenseSubmission.init({
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  iou_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  submitter_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  actual_amount: {
    type: DataTypes.DECIMAL(18, 2),
    allowNull: false,
  },
  status: {
    type: DataTypes.STRING(32),
    allowNull: false,
    defaultValue: 'SUBMITTED', // SUBMITTED / PENDING_REVIEW / RECONCILED / RETURNED
  },
  submitted_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  deadline: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  notes: {
    type: DataTypes.STRING(1000),
    allowNull: true,
  },
  // Attachment references (array of { file_name, file_path, blob_name, content_type, size })
  attachments: {
    type: DataTypes.TEXT,
    allowNull: true,
    get() {
      const val = this.getDataValue('attachments');
      if (!val) return null;
      if (typeof val === 'object') return val;
      try { return JSON.parse(val); } catch (e) { return val; }
    },
    set(val) {
      if (val === null || val === undefined) {
        this.setDataValue('attachments', null);
      } else {
        this.setDataValue('attachments', typeof val === 'string' ? val : JSON.stringify(val));
      }
    }
  }
}, {
  sequelize,
  modelName: 'ExpenseSubmission',
  tableName: 'expense_submissions',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = ExpenseSubmission;
