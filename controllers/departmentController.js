// controllers/departmentController.js
const Department = require('../models/Department');
const User = require('../models/User');
const { Op } = require('sequelize');

/**
 * GET /api/departments
 * List all departments with HoD info
 */
exports.listDepartments = [
  async (req, res) => {
    try {
      const departments = await Department.findAll({
        include: [{ model: User, as: 'hod', attributes: ['id', 'display_name', 'username', 'email'] }],
        order: [['name', 'ASC']]
      });
      return res.json({ data: departments });
    } catch (err) {
      console.error('listDepartments error', err);
      return res.status(500).json({ message: 'Error fetching departments' });
    }
  }
];

/**
 * PUT /api/departments/:id
 * Update department (set HoD) - admin/cashier only
 */
exports.updateDepartment = [
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor) return res.status(401).json({ message: 'Not authenticated' });
      if (!actor.is_admin && actor.role !== 'cashier') {
        return res.status(403).json({ message: 'Only admin or cashier can update departments' });
      }

      const { id } = req.params;
      const dept = await Department.findByPk(id);
      if (!dept) return res.status(404).json({ message: 'Department not found' });

      const { hod_user_id, name, code } = req.body;
      const payload = {};
      if (hod_user_id !== undefined) payload.hod_user_id = hod_user_id || null;
      if (name !== undefined) payload.name = name;
      if (code !== undefined) payload.code = code;

      await dept.update(payload);

      // re-fetch with association
      const updated = await Department.findByPk(id, {
        include: [{ model: User, as: 'hod', attributes: ['id', 'display_name', 'username', 'email'] }]
      });

      return res.json({ message: 'Department updated', department: updated });
    } catch (err) {
      console.error('updateDepartment error', err);
      return res.status(500).json({ message: 'Error updating department' });
    }
  }
];

/**
 * GET /api/departments/hod-for/:departmentName
 * Get HoD user for a given department name (case-insensitive)
 */
exports.getHodForDepartment = [
  async (req, res) => {
    try {
      const { departmentName } = req.params;
      if (!departmentName) return res.status(400).json({ message: 'departmentName is required' });

      const dept = await Department.findOne({
        where: { name: { [Op.like]: departmentName } },
        include: [{ model: User, as: 'hod', attributes: ['id', 'display_name', 'username', 'email'] }]
      });

      if (!dept) return res.json({ department: null, hod: null });

      return res.json({ department: dept, hod: dept.hod || null });
    } catch (err) {
      console.error('getHodForDepartment error', err);
      return res.status(500).json({ message: 'Error fetching HoD' });
    }
  }
];

/**
 * POST /api/departments
 * Create a department - admin only
 */
exports.createDepartment = [
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor) return res.status(401).json({ message: 'Not authenticated' });
      if (!actor.is_admin) return res.status(403).json({ message: 'Only admin can create departments' });

      const { name, code, hod_user_id } = req.body;
      if (!name) return res.status(400).json({ message: 'name is required' });

      const [dept, created] = await Department.findOrCreate({
        where: { name },
        defaults: { code: code || null, hod_user_id: hod_user_id || null }
      });

      if (!created) return res.status(409).json({ message: 'Department already exists', department: dept });

      return res.status(201).json({ message: 'Department created', department: dept });
    } catch (err) {
      console.error('createDepartment error', err);
      return res.status(500).json({ message: 'Error creating department' });
    }
  }
];

/**
 * POST /api/departments/sync-ldap
 * Sync departments and HODs from LDAP
 */
exports.syncLdap = [
  async (req, res) => {
    try {
      const { syncLdapDepartmentsAndHods } = require('../services/ldapSyncService');
      await syncLdapDepartmentsAndHods();
      return res.json({ message: 'LDAP Department and HOD sync completed successfully.' });
    } catch (err) {
      console.error('syncLdap error', err);
      return res.status(500).json({ message: 'Error syncing with LDAP', error: err.message });
    }
  }
];
