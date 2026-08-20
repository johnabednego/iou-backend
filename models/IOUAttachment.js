// models/IOUAttachment.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');
const IOURequest = require('./IOURequest');
const User = require('./User');

class IOUAttachment extends Model {}

IOUAttachment.init({
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  iou_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  file_name: {
    type: DataTypes.STRING(2000),
    allowNull: false,
  },
  blob_name: {
    type: DataTypes.STRING(2000),
    allowNull: false,
  },
  file_path: {
    type: DataTypes.STRING(2000),
    allowNull: false,
  },
  content_type: {
    type: DataTypes.STRING(128),
    allowNull: true,
  },
  size: {
    type: DataTypes.BIGINT,
    allowNull: true,
  },
  uploaded_by: {
    type: DataTypes.UUID,
    allowNull: true,
  }
}, {
  sequelize,
  modelName: 'IOUAttachment',
  tableName: 'iou_attachments',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = IOUAttachment;
