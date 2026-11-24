// controllers/settingsController.js
const AppSetting = require('../models/AppSetting');

/**
 * GET /api/settings/date-limit
 * Returns the minimum allowed filter date. Available to all authenticated users.
 */
exports.getDateLimit = [
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor) return res.status(401).json({ message: 'Not authenticated' });

      const setting = await AppSetting.findOne({ where: { key: 'filter_min_date' } });

      // Default: first day of current month
      const now = new Date();
      const defaultDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

      return res.json({
        min_date: (setting && setting.value) || defaultDate,
        is_default: !setting || !setting.value
      });
    } catch (err) {
      console.error('getDateLimit error', err);
      return res.status(500).json({ message: 'Error fetching date limit setting' });
    }
  }
];

/**
 * PUT /api/settings/date-limit
 * Admin-only: set the minimum allowed filter date.
 * Body: { min_date: 'YYYY-MM-DD' }
 */
exports.setDateLimit = [
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor) return res.status(401).json({ message: 'Not authenticated' });
      if (!actor.is_admin) return res.status(403).json({ message: 'Admin privileges required' });

      const { min_date } = req.body;
      if (!min_date) return res.status(400).json({ message: 'min_date is required (YYYY-MM-DD)' });

      // Validate date format
      const parsed = new Date(min_date);
      if (isNaN(parsed.getTime())) {
        return res.status(400).json({ message: 'Invalid date format. Use YYYY-MM-DD.' });
      }

      // Cannot set a date in the future
      const today = new Date();
      today.setHours(23, 59, 59, 999);
      if (parsed > today) {
        return res.status(400).json({ message: 'Minimum date cannot be in the future.' });
      }

      const [setting, created] = await AppSetting.findOrCreate({
        where: { key: 'filter_min_date' },
        defaults: {
          value: min_date,
          description: 'Minimum date allowed for filter date pickers. Set by admin.'
        }
      });

      if (!created) {
        await setting.update({ value: min_date });
      }

      return res.json({
        message: 'Minimum filter date updated successfully.',
        min_date: min_date
      });
    } catch (err) {
      console.error('setDateLimit error', err);
      return res.status(500).json({ message: 'Error updating date limit setting' });
    }
  }
];

/**
 * GET /api/settings/ifs-voucher-editing
 * Returns whether IFS Voucher Number editing is enabled. Available to all authenticated users.
 */
exports.getIfsVoucherEditing = [
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor) return res.status(401).json({ message: 'Not authenticated' });

      const setting = await AppSetting.findOne({ where: { key: 'ifs_voucher_editing_enabled' } });

      return res.json({
        enabled: setting ? setting.value === 'true' : false
      });
    } catch (err) {
      console.error('getIfsVoucherEditing error', err);
      return res.status(500).json({ message: 'Error fetching IFS voucher editing setting' });
    }
  }
];

/**
 * PUT /api/settings/ifs-voucher-editing
 * Admin-only: enable or disable IFS Voucher Number editing.
 * Body: { enabled: true|false }
 */
exports.setIfsVoucherEditing = [
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor) return res.status(401).json({ message: 'Not authenticated' });
      if (!actor.is_admin) return res.status(403).json({ message: 'Admin privileges required' });

      const { enabled } = req.body;
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ message: 'enabled must be a boolean (true or false)' });
      }

      const [setting, created] = await AppSetting.findOrCreate({
        where: { key: 'ifs_voucher_editing_enabled' },
        defaults: {
          value: String(enabled),
          description: 'When enabled, allows editing of IFS Voucher Numbers on completed/reconciled requests.'
        }
      });

      if (!created) {
        await setting.update({ value: String(enabled) });
      }

      return res.json({
        message: `IFS Voucher editing ${enabled ? 'enabled' : 'disabled'} successfully.`,
        enabled
      });
    } catch (err) {
      console.error('setIfsVoucherEditing error', err);
      return res.status(500).json({ message: 'Error updating IFS voucher editing setting' });
    }
  }
];
