// controllers/notificationController.js
const Notification = require('../models/Notification');

/**
 * GET /api/notifications
 * optional query: unread=true
 */
exports.listNotifications = [
  async (req, res) => {
    try {
      const current = req.currentUser;
      if (!current) return res.status(401).json({ message: 'Not authenticated' });

      const where = { target_user_id: current.id };
      if (req.query.unread && String(req.query.unread) === 'true') where.is_read = false;

      const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
      const offset = parseInt(req.query.offset || '0', 10);

      const rows = await Notification.findAll({
        where,
        order: [['created_at', 'DESC']],
        limit, offset
      });

      return res.json({ data: rows });
    } catch (err) {
      const code = err?.original?.code || err?.code || '';
      console.error('listNotifications:', err.name, code, err.message);
      if (code === 'ETIMEOUT' || code === 'ECONNRESET' || code === 'ESOCKET') {
        return res.status(503).json({ message: 'Database temporarily unavailable. Please try again.' });
      }
      return res.status(500).json({ message: 'Error fetching notifications' });
    }
  }
];

/**
 * PUT /api/notifications/:id/read
 * Marks notification as read
 */
exports.markRead = [
  async (req, res) => {
    try {
      const current = req.currentUser;
      if (!current) return res.status(401).json({ message: 'Not authenticated' });

      const { id } = req.params;
      const note = await Notification.findByPk(id);
      if (!note) return res.status(404).json({ message: 'Not found' });
      if (String(note.target_user_id) !== String(current.id) && !current.is_admin) {
        return res.status(403).json({ message: 'Forbidden' });
      }

      note.is_read = true;
      await note.save();
      return res.json({ message: 'Marked read', notification: note });
    } catch (err) {
      const code = err?.original?.code || err?.code || '';
      console.error('markRead:', err.name, code, err.message);
      return res.status(500).json({ message: 'Error marking notification as read' });
    }
  }
];
