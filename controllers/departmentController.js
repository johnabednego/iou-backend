// controllers/departmentController.js
const Department = require('../models/Department');
const DepartmentHOD = require('../models/DepartmentHOD');
const User = require('../models/User');
const IOURequest = require('../models/IOURequest');
const sequelize = require('../config/database');
const { Op } = require('sequelize');

/**
 * Helper: Find or create user for HOD role.
 * If user does not exist in local DB, searches LDAP, creates user with role 'hod'.
 */
async function findOrCreateUserForHod(idOrEmailOrUsername, defaultDeptName) {
  if (!idOrEmailOrUsername) return null;
  const raw = String(idOrEmailOrUsername).trim();
  if (!raw) return null;

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw);
  if (isUuid) {
    const u = await User.findByPk(raw);
    if (u) {
      if (u.role !== 'admin' && u.role !== 'cashier') {
        await u.update({ role: 'hod' });
      }
      return u.id;
    }
  }

  // Look up by email or username in local database
  let user = await User.findOne({
    where: {
      [Op.or]: [
        { email: raw },
        { username: raw }
      ]
    }
  });
  if (user) {
    if (user.role !== 'admin' && user.role !== 'cashier') {
      await user.update({ role: 'hod' });
    }
    return user.id;
  }

  // Not found in local DB: attempt LDAP lookup
  const ldapUrl = process.env.LDAP_SERVER;
  const ldapBaseDn = process.env.LDAP_BASE_DN;
  const ldapBindDn = process.env.LDAP_BIND_DN;
  const ldapBindPassword = process.env.LDAP_BIND_PASSWORD;

  if (ldapUrl && ldapBaseDn && ldapBindDn && ldapBindPassword) {
    const { Client } = require('ldapts');
    const client = new Client({ url: ldapUrl });
    try {
      await client.bind(ldapBindDn, ldapBindPassword);
      const escaped = raw.replace(/[*()\\/0]/g, '\\$&');
      const filter = `(|(mail=${escaped})(userPrincipalName=${escaped})(sAMAccountName=${escaped})(cn=${escaped}))`;
      const { searchEntries } = await client.search(ldapBaseDn, {
        scope: 'sub',
        filter,
        attributes: [
          'description', 'title', 'department', 'company', 'name',
          'givenName', 'displayName', 'sAMAccountName', 'userPrincipalName',
          'mail', 'manager'
        ],
        sizeLimit: 1
      });
      if (searchEntries && searchEntries.length > 0) {
        const createdUser = await User.upsertFromLdap(searchEntries[0]);
        await createdUser.update({
          role: 'hod',
          department: defaultDeptName || createdUser.department
        });
        return createdUser.id;
      }
    } catch (err) {
      console.warn('findOrCreateUserForHod LDAP search failed:', err.message);
    } finally {
      try { await client.unbind(); } catch (_) {}
    }
  }

  return null;
}

/**
 * GET /api/departments
 * List all departments with HoDs info and member count
 */
exports.listDepartments = [
  async (req, res) => {
    try {
      const includeInactive = req.query.include_inactive === 'true' || req.query.include_inactive === true;
      const search = (req.query.search || '').trim();

      const where = {};
      if (!includeInactive) {
        where.is_active = true;
      }
      if (search) {
        where[Op.or] = [
          { name: { [Op.like]: `%${search}%` } },
          { code: { [Op.like]: `%${search}%` } }
        ];
      }

      const departments = await Department.findAll({
        where,
        include: [
          { 
            model: User, 
            as: 'hods', 
            attributes: ['id', 'display_name', 'username', 'email', 'role', 'is_active'],
            through: { attributes: [] }
          },
          { 
            model: User, 
            as: 'hod', 
            attributes: ['id', 'display_name', 'username', 'email', 'role', 'is_active'] 
          }
        ],
        order: [['name', 'ASC']]
      });

      // Fetch user member counts for each department name
      const results = await Promise.all(departments.map(async (dept) => {
        const dJson = dept.toJSON();
        
        // Ensure hods array contains all assigned HODs (combining many-to-many and legacy hod_user_id)
        const hodMap = new Map();
        if (Array.isArray(dJson.hods)) {
          dJson.hods.forEach(h => hodMap.set(h.id, h));
        }
        if (dJson.hod && !hodMap.has(dJson.hod.id)) {
          hodMap.set(dJson.hod.id, dJson.hod);
        }
        dJson.hods = Array.from(hodMap.values());

        // Count members in this department
        try {
          dJson.member_count = await User.count({
            where: { department: dept.name, is_active: true }
          });
        } catch (_) {
          dJson.member_count = 0;
        }

        return dJson;
      }));

      return res.json({ data: results });
    } catch (err) {
      console.error('listDepartments error', err);
      return res.status(500).json({ message: 'Error fetching departments' });
    }
  }
];

/**
 * GET /api/departments/:id
 * Get single department by ID
 */
exports.getDepartment = [
  async (req, res) => {
    try {
      const { id } = req.params;
      const dept = await Department.findByPk(id, {
        include: [
          { 
            model: User, 
            as: 'hods', 
            attributes: ['id', 'display_name', 'username', 'email', 'role', 'is_active'],
            through: { attributes: [] }
          },
          { 
            model: User, 
            as: 'hod', 
            attributes: ['id', 'display_name', 'username', 'email', 'role', 'is_active'] 
          }
        ]
      });
      if (!dept) return res.status(404).json({ message: 'Department not found' });

      const dJson = dept.toJSON();
      const hodMap = new Map();
      if (Array.isArray(dJson.hods)) {
        dJson.hods.forEach(h => hodMap.set(h.id, h));
      }
      if (dJson.hod && !hodMap.has(dJson.hod.id)) {
        hodMap.set(dJson.hod.id, dJson.hod);
      }
      dJson.hods = Array.from(hodMap.values());

      // Get members
      dJson.members = await User.findAll({
        where: { department: dept.name },
        attributes: ['id', 'display_name', 'username', 'email', 'role', 'is_active']
      });

      return res.json({ data: dJson });
    } catch (err) {
      console.error('getDepartment error', err);
      return res.status(500).json({ message: 'Error fetching department' });
    }
  }
];

/**
 * POST /api/departments
 * Create a department - admin only
 * Body: { name, code, description, is_active, hod_user_ids: [] }
 */
exports.createDepartment = [
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor) return res.status(401).json({ message: 'Not authenticated' });
      if (!actor.is_admin && actor.role !== 'cashier') {
        return res.status(403).json({ message: 'Only admin can create departments' });
      }

      const { name, code, description, is_active, ldap_aliases, hod_user_ids } = req.body;
      if (!name || !name.trim()) return res.status(400).json({ message: 'Department name is required' });

      const trimmedName = name.trim();
      const existing = await Department.findOne({ where: { name: trimmedName } });
      if (existing) {
        return res.status(409).json({ message: `Department "${trimmedName}" already exists` });
      }

      // Resolve HOD user IDs (auto-creates from LDAP if not in local DB)
      const hodIds = [];
      if (Array.isArray(hod_user_ids)) {
        for (const item of hod_user_ids) {
          const resolvedId = await findOrCreateUserForHod(item, trimmedName);
          if (resolvedId && !hodIds.includes(resolvedId)) {
            hodIds.push(resolvedId);
          }
        }
      }
      const primaryHod = hodIds.length > 0 ? hodIds[0] : null;

      const dept = await Department.create({
        name: trimmedName,
        code: code ? code.trim().toUpperCase() : null,
        description: description ? description.trim() : null,
        ldap_aliases: ldap_aliases ? ldap_aliases.trim() : null,
        is_active: is_active !== false,
        hod_user_id: primaryHod
      });

      // Insert multiple HOD associations
      if (hodIds.length > 0) {
        for (const userId of hodIds) {
          await DepartmentHOD.findOrCreate({
            where: { department_id: dept.id, user_id: userId }
          });
          await User.update({ role: 'hod' }, { where: { id: userId, role: { [Op.ne]: 'admin' } } });
        }
      }

      // Re-fetch with associations
      const created = await Department.findByPk(dept.id, {
        include: [{ model: User, as: 'hods', attributes: ['id', 'display_name', 'username', 'email'] }]
      });

      return res.status(201).json({ message: 'Department created successfully', department: created });
    } catch (err) {
      console.error('createDepartment error', err);
      return res.status(500).json({ message: err?.message || 'Error creating department' });
    }
  }
];

/**
 * PUT /api/departments/:id
 * Update department - admin or cashier
 * Body: { name, code, description, is_active, ldap_aliases, hod_user_ids: [] }
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

      const { name, code, description, is_active, ldap_aliases, hod_user_ids } = req.body;
      const payload = {};
      const oldName = dept.name;

      if (name !== undefined && name.trim()) {
        const trimmedName = name.trim();
        // Check uniqueness if name changed
        if (trimmedName.toLowerCase() !== oldName.toLowerCase()) {
          const nameConflict = await Department.findOne({
            where: { name: trimmedName, id: { [Op.ne]: id } }
          });
          if (nameConflict) {
            return res.status(409).json({ message: `Department name "${trimmedName}" is already taken` });
          }
        }
        payload.name = trimmedName;
      }

      if (code !== undefined) payload.code = code ? code.trim().toUpperCase() : null;
      if (description !== undefined) payload.description = description ? description.trim() : null;
      if (ldap_aliases !== undefined) payload.ldap_aliases = ldap_aliases ? ldap_aliases.trim() : null;
      if (is_active !== undefined) payload.is_active = !!is_active;

      // Handle multiple HODs synchronization
      if (Array.isArray(hod_user_ids)) {
        const uniqueHodIds = [];
        for (const item of hod_user_ids) {
          const resolvedId = await findOrCreateUserForHod(item, payload.name || dept.name);
          if (resolvedId && !uniqueHodIds.includes(resolvedId)) {
            uniqueHodIds.push(resolvedId);
          }
        }

        payload.hod_user_id = uniqueHodIds.length > 0 ? uniqueHodIds[0] : null;

        // Remove removed HODs from department_hods
        await DepartmentHOD.destroy({
          where: {
            department_id: dept.id,
            user_id: { [Op.notIn]: uniqueHodIds }
          }
        });

        // Add new HODs
        for (const uId of uniqueHodIds) {
          await DepartmentHOD.findOrCreate({
            where: { department_id: dept.id, user_id: uId }
          });
          // Ensure assigned users have role 'hod'
          await User.update({ role: 'hod' }, { where: { id: uId, role: { [Op.ne]: 'admin' } } });
        }
      }

      await dept.update(payload);

      // If department name was changed, sync user and iou records
      if (payload.name && payload.name !== oldName) {
        await User.update({ department: payload.name }, { where: { department: oldName } });
        await IOURequest.update({ department: payload.name }, { where: { department: oldName } });
      }

      // Re-fetch with associations
      const updated = await Department.findByPk(id, {
        include: [
          { model: User, as: 'hods', attributes: ['id', 'display_name', 'username', 'email'] },
          { model: User, as: 'hod', attributes: ['id', 'display_name', 'username', 'email'] }
        ]
      });

      return res.json({ message: 'Department updated successfully', department: updated });
    } catch (err) {
      console.error('updateDepartment error', err);
      return res.status(500).json({ message: err?.message || 'Error updating department' });
    }
  }
];

/**
 * DELETE /api/departments/:id
 * Delete or deactivate department - admin only
 */
exports.deleteDepartment = [
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor) return res.status(401).json({ message: 'Not authenticated' });
      if (!actor.is_admin) {
        return res.status(403).json({ message: 'Only admin can delete departments' });
      }

      const { id } = req.params;
      const dept = await Department.findByPk(id);
      if (!dept) return res.status(404).json({ message: 'Department not found' });

      // Check if department is used by users or IOUs
      const userCount = await User.count({ where: { department: dept.name } });
      const iouCount = await IOURequest.count({ where: { department: dept.name } });

      if (userCount > 0 || iouCount > 0) {
        // Soft-delete / deactivate instead to protect historical records
        await dept.update({ is_active: false });
        return res.json({
          message: `Department has ${userCount} user(s) and ${iouCount} IOU(s). It has been deactivated instead of deleted to protect historical records.`,
          deactivated: true
        });
      }

      // Safe to hard delete
      await DepartmentHOD.destroy({ where: { department_id: dept.id } });
      await dept.destroy();

      return res.json({ message: 'Department deleted successfully', deleted: true });
    } catch (err) {
      console.error('deleteDepartment error', err);
      return res.status(500).json({ message: 'Error deleting department' });
    }
  }
];

/**
 * GET /api/departments/hod-for/:departmentName
 * Get HoD users for a given department name (case-insensitive)
 */
exports.getHodForDepartment = [
  async (req, res) => {
    try {
      const { departmentName } = req.params;
      if (!departmentName) return res.status(400).json({ message: 'departmentName is required' });

      const dept = await Department.findOne({
        where: { name: { [Op.like]: departmentName } },
        include: [
          { 
            model: User, 
            as: 'hods', 
            attributes: ['id', 'display_name', 'username', 'email'] 
          },
          { 
            model: User, 
            as: 'hod', 
            attributes: ['id', 'display_name', 'username', 'email'] 
          }
        ]
      });

      if (!dept) {
        // Fallback: search Users directly with role 'hod' in this department
        const usersInDept = await User.findAll({
          where: {
            role: 'hod',
            is_active: true,
            department: { [Op.like]: departmentName }
          },
          attributes: ['id', 'display_name', 'username', 'email']
        });
        return res.json({ department: null, hods: usersInDept, hod: usersInDept[0] || null });
      }

      const dJson = dept.toJSON();
      const hodMap = new Map();
      if (Array.isArray(dJson.hods)) {
        dJson.hods.forEach(h => hodMap.set(h.id, h));
      }
      if (dJson.hod && !hodMap.has(dJson.hod.id)) {
        hodMap.set(dJson.hod.id, dJson.hod);
      }
      const allHods = Array.from(hodMap.values());

      return res.json({ department: dept, hods: allHods, hod: allHods[0] || null });
    } catch (err) {
      console.error('getHodForDepartment error', err);
      return res.status(500).json({ message: 'Error fetching HoD' });
    }
  }
];

/**
 * POST /api/departments/merge
 * Merge source department into target department.
 * Reassigns all users and IOUs from source to target, merges HODs,
 * records source.name in target.ldap_aliases, and deletes source department.
 */
exports.mergeDepartments = [
  async (req, res) => {
    const t = await sequelize.transaction();
    try {
      const actor = req.currentUser;
      if (!actor || (!actor.is_admin && actor.role !== 'cashier')) {
        await t.rollback();
        return res.status(403).json({ message: 'Only admin or cashier can merge departments' });
      }

      const source_id = req.body.source_id || req.body.source_department_id;
      const target_id = req.body.target_id || req.body.target_department_id;
      const keepAlias = req.body.keep_alias !== false;

      if (!source_id || !target_id) {
        await t.rollback();
        return res.status(400).json({ message: 'source_id and target_id are required' });
      }
      if (source_id === target_id) {
        await t.rollback();
        return res.status(400).json({ message: 'Source and target departments cannot be the same' });
      }

      const source = await Department.findOne({
        where: {
          [Op.or]: [
            { id: source_id },
            { name: source_id }
          ]
        },
        transaction: t
      });
      const target = await Department.findOne({
        where: {
          [Op.or]: [
            { id: target_id },
            { name: target_id }
          ]
        },
        transaction: t
      });

      if (!source || !target) {
        await t.rollback();
        return res.status(404).json({ message: 'One or both departments not found' });
      }

      // 1. Move all users from source department name to target department name
      const [updatedUsers] = await User.update(
        { department: target.name },
        { where: { department: source.name }, transaction: t }
      );

      // 2. Move all IOUs from source department name to target department name
      const [updatedIOUs] = await IOURequest.update(
        { department: target.name },
        { where: { department: source.name }, transaction: t }
      );

      // 3. Transfer HODs from source to target in department_hods
      const sourceHods = await DepartmentHOD.findAll({ where: { department_id: source.id }, transaction: t });
      for (const sh of sourceHods) {
        await DepartmentHOD.findOrCreate({
          where: { department_id: target.id, user_id: sh.user_id },
          transaction: t
        });
        await User.update({ role: 'hod' }, { where: { id: sh.user_id, role: { [Op.ne]: 'admin' } }, transaction: t });
      }
      if (source.hod_user_id && !target.hod_user_id) {
        await target.update({ hod_user_id: source.hod_user_id }, { transaction: t });
      }

      // 4. Append source.name and source.ldap_aliases to target.ldap_aliases if requested
      if (keepAlias) {
        const existingAliases = (target.ldap_aliases || '')
          .split(',')
          .map(a => a.trim())
          .filter(Boolean);
        const sourceAliases = (source.ldap_aliases || '')
          .split(',')
          .map(a => a.trim())
          .filter(Boolean);
        const combinedAliases = Array.from(new Set([...existingAliases, source.name, ...sourceAliases]))
          .filter(a => a.toLowerCase() !== target.name.toLowerCase());

        await target.update({ ldap_aliases: combinedAliases.join(', ') }, { transaction: t });
      }

      // 5. Remove source department
      await DepartmentHOD.destroy({ where: { department_id: source.id }, transaction: t });
      await source.destroy({ transaction: t });

      await t.commit();

      return res.json({
        message: `Merged "${source.name}" into "${target.name}" successfully. ${updatedUsers} user(s) and ${updatedIOUs} IOU(s) were reassigned.`,
        migrated_users: updatedUsers,
        migrated_ious: updatedIOUs,
        target_department: target
      });
    } catch (err) {
      try { await t.rollback(); } catch (_) {}
      console.error('mergeDepartments error:', err);
      return res.status(500).json({ message: err?.message || 'Error merging departments' });
    }
  }
];
