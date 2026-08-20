// controllers/auditController.js
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const IOURequest = require('../models/IOURequest');
const ReconciliationRecord = require('../models/ReconciliationRecord');
const { Op } = require('sequelize');

/**
 * GET /api/audit-logs
 * Admin-only paginated list with filters
 */
exports.listAuditLogs = [
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor) return res.status(401).json({ message: 'Not authenticated' });
      if (!actor.is_admin) return res.status(403).json({ message: 'Admin access required' });

      const limit = Math.min(parseInt(req.query.limit || '50', 10), 500);
      const offset = parseInt(req.query.offset || '0', 10);

      const where = {};

      if (req.query.entity_type) where.entity = req.query.entity_type;
      if (req.query.action) where.action = { [Op.like]: `%${req.query.action}%` };
      if (req.query.actor_id) where.actor_id = req.query.actor_id;

      // IFS voucher number or keyword search
      const search = (req.query.search || req.query.ifs_number || '').trim();
      if (search) {
        // Find matching IOU IDs by IFS voucher number or request number
        const matchingIous = await IOURequest.findAll({
          where: {
            [Op.or]: [
              { ifs_voucher_number: { [Op.like]: `%${search}%` } },
              { request_number: { [Op.like]: `%${search}%` } }
            ]
          },
          attributes: ['id']
        });

        const matchingRecons = await ReconciliationRecord.findAll({
          where: { ifs_voucher_number: { [Op.like]: `%${search}%` } },
          attributes: ['iou_id']
        });

        const iouIds = [...new Set([
          ...matchingIous.map(i => i.id),
          ...matchingRecons.map(r => r.iou_id)
        ])].filter(Boolean);

        const searchOr = [
          { details: { [Op.like]: `%${search}%` } },
          { action: { [Op.like]: `%${search}%` } },
          { actor_name: { [Op.like]: `%${search}%` } }
        ];

        if (iouIds.length > 0) {
          searchOr.push({
            [Op.and]: [
              { entity: 'IOU' },
              { entity_id: { [Op.in]: iouIds } }
            ]
          });
        }

        where[Op.or] = searchOr;
      }

      if (req.query.start_date || req.query.end_date) {
        where.created_at = {};
        if (req.query.start_date) where.created_at[Op.gte] = new Date(req.query.start_date);
        if (req.query.end_date) {
          const end = new Date(req.query.end_date);
          end.setHours(23, 59, 59, 999);
          where.created_at[Op.lte] = end;
        }
      }

      const { count, rows } = await AuditLog.findAndCountAll({
        where,
        limit,
        offset,
        order: [['created_at', 'DESC']],
        include: [{ model: User, as: 'actor', attributes: ['id', 'display_name', 'username'], required: false }]
      });

      return res.json({ data: rows, total: count, limit, offset });
    } catch (err) {
      console.error('listAuditLogs error', err);
      return res.status(500).json({ message: 'Error fetching audit logs' });
    }
  }
];
