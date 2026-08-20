// controllers/userController.js
const User = require('../models/User');
const { isAuthenticated, requireAdmin } = require('../middleware/auth');
const emailService = require('../services/emailService');
const notificationService = require('../services/notificationService');
// ---------- Controllers ----------

/**
 * GET /users/me
 * Return the logged-in user's DB record
 */
exports.me = [
  isAuthenticated,
  async (req, res) => {
    try {
      const user = req.currentUser;
      return res.json({ user });
    } catch (err) {
      console.error('me error', err);
      return res.status(500).json({ message: 'Error fetching current user' });
    }
  }
];

const { Client } = require('ldapts');

async function searchLdapUsers(queryText) {
  const ldapUrl = process.env.LDAP_SERVER;
  const ldapBaseDn = process.env.LDAP_BASE_DN;
  const ldapBindDn = process.env.LDAP_BIND_DN;
  const ldapBindPassword = process.env.LDAP_BIND_PASSWORD;

  if (!ldapUrl || !ldapBindDn || !ldapBindPassword) {
    console.warn('LDAP search skipped: missing config in environment');
    return [];
  }

  const client = new Client({ url: ldapUrl });
  try {
    await client.bind(ldapBindDn, ldapBindPassword);
    const escapedQuery = queryText.replace(/[*()\\\0]/g, '\\$&');
    const filter = `(|(sAMAccountName=*${escapedQuery}*)(cn=*${escapedQuery}*)(displayName=*${escapedQuery}*)(mail=*${escapedQuery}*))`;
    
    const { searchEntries } = await client.search(ldapBaseDn, {
      scope: 'sub',
      filter,
      attributes: [
        'description',
        'title',
        'department',
        'company',
        'name',
        'givenName',
        'displayName',
        'sAMAccountName',
        'userPrincipalName',
        'mail',
        'manager'
      ],
      sizeLimit: 15
    });
    return searchEntries;
  } catch (err) {
    console.error('LDAP search failed:', err.message);
    return [];
  } finally {
    try { await client.unbind(); } catch (_) {}
  }
}

/**
 * GET /users
 * List users (authenticated). You may restrict to admins later.
 */
exports.getUsers = [
  isAuthenticated,
  async (req, res) => {
    try {
      const { Op } = require('sequelize');
      const limit = Math.min(parseInt(req.query.limit || '100', 10), 1000);
      const offset = parseInt(req.query.offset || '0', 10);

      const where = {};
      if (req.query.role) where.role = req.query.role;
      if (req.query.is_active !== undefined) where.is_active = req.query.is_active === 'true';
      if (req.query.is_approver === 'true') {
        where[Op.or] = [
          { is_approver: true },
          { is_admin: true },
          { role: 'hod' }
        ];
      }
      
      if (req.query.search) {
        const s = req.query.search;

        // local_only=true skips LDAP (fast path for approver picker)
        if (req.query.local_only !== 'true') {
          try {
            const ldapEntries = await searchLdapUsers(s);
            for (const entry of ldapEntries) {
              await User.upsertFromLdap(entry);
            }
          } catch (ldapErr) {
            console.error('Error syncing LDAP users on demand:', ldapErr.message);
          }
        }

        const searchCond = [
          { display_name: { [Op.like]: `%${s}%` } },
          { username: { [Op.like]: `%${s}%` } },
          { email: { [Op.like]: `%${s}%` } }
        ];

        if (where[Op.or]) {
          where[Op.and] = [
            { [Op.or]: where[Op.or] },
            { [Op.or]: searchCond }
          ];
          delete where[Op.or];
        } else {
          where[Op.or] = searchCond;
        }
      }

      const users = await User.findAll({
        where,
        limit,
        offset,
        order: [['display_name', 'ASC']],
        attributes: { exclude: ['metadata'] }
      });
      res.json({ data: users });
    } catch (err) {
      console.error('getUsers error', err);
      res.status(500).json({ message: 'Error fetching users' });
    }
  }
];

/**
 * GET /users/:id
 */
exports.getUserById = [
  isAuthenticated,
  async (req, res) => {
    try {
      const { id } = req.params;
      const user = await User.findByPk(id);
      if (!user) return res.status(404).json({ message: 'User not found' });
      return res.json({ user });
    } catch (err) {
      console.error('getUserById error', err);
      return res.status(500).json({ message: 'Error fetching user' });
    }
  }
];

/**
 * POST /users
 * Create a user manually (Admin only)
 */
exports.createUser = [
  isAuthenticated,
  requireAdmin,
  async (req, res) => {
    try {
      const { username, email, display_name, role, is_admin } = req.body;
      if (!username) return res.status(400).json({ message: 'username is required' });

      const [user, created] = await User.findOrCreate({
        where: { username },
        defaults: {
          email,
          display_name,
          role: role || 'employee',
          is_admin: !!is_admin,
          last_synced_at: new Date(),
          metadata: req.body.metadata || null
        }
      });

      res.status(created ? 201 : 200).json({ user, created });
    } catch (err) {
      console.error('createUser error', err);
      res.status(500).json({ message: 'Error creating user' });
    }
  }
];

/**
 * PUT /users/:id
 * Update user fields. Owner or admin may update.
 * Note: Only admins can set `is_admin` or `role` via this route.
 */
exports.updateUser = [
  isAuthenticated,
  async (req, res) => {
    try {
      const { id } = req.params;
      const actor = req.currentUser;

      const user = await User.findByPk(id);
      if (!user) return res.status(404).json({ message: 'User not found' });

      const isOwner = actor.id === user.id;
      const isAdmin = actor.is_admin;

      if (!isOwner && !isAdmin) {
        return res.status(403).json({ message: 'Forbidden: only owner or admin can update' });
      }

      // Allowed to update for owners: display_name, email, department_id, is_active
      // Admins can also update role and is_admin
      const allowedForOwner = ['display_name', 'email', 'department_id', 'is_active', 'metadata'];
      const allowedForAdmin = ['role', 'is_admin'];
      const payload = {};

      allowedForOwner.forEach(k => {
        if (Object.prototype.hasOwnProperty.call(req.body, k)) payload[k] = req.body[k];
      });

      if (isAdmin) {
        allowedForAdmin.forEach(k => {
          if (Object.prototype.hasOwnProperty.call(req.body, k)) payload[k] = req.body[k];
        });
      } else {
        // if owner attempted to set admin/role, reject
        if (Object.prototype.hasOwnProperty.call(req.body, 'is_admin') || Object.prototype.hasOwnProperty.call(req.body, 'role')) {
          return res.status(403).json({ message: 'Only admins can change role or admin flag' });
        }
      }

      await user.update(payload);
      return res.json({ message: 'User updated', user });
    } catch (err) {
      console.error('updateUser error', err);
      return res.status(500).json({ message: 'Error updating user' });
    }
  }
];

/**
 * PUT /users/:id/role
 * Admin-only: set role and/or is_admin flag.
 * When setting role to 'hod', also updates the department's hod_user_id.
 * If department already has a different HOD, requires confirm_replace flag.
 */
exports.setRole = [
  isAuthenticated,
  requireAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { role, is_admin, confirm_replace } = req.body;
      if (typeof role === 'undefined' && typeof is_admin === 'undefined') {
        return res.status(400).json({ message: 'role or is_admin required in body' });
      }

      const user = await User.findByPk(id);
      if (!user) return res.status(404).json({ message: 'User not found' });

      const Department = require('../models/Department');
      const updates = {};
      if (typeof role !== 'undefined') updates.role = role;
      if (typeof is_admin !== 'undefined') updates.is_admin = !!is_admin;

      // HOD swap logic: when assigning role 'hod', update department table
      if (role === 'hod' && user.department) {
        const dept = await Department.findOne({ where: { name: user.department } });
        if (dept) {
          if (dept.hod_user_id && dept.hod_user_id !== user.id) {
            // Different HOD already assigned
            if (!confirm_replace) {
              // Fetch current HOD name for warning
              const currentHod = await User.findByPk(dept.hod_user_id);
              return res.status(409).json({
                message: `Department "${dept.name}" already has an HOD: ${currentHod?.display_name || currentHod?.username || 'Unknown'}. Do you want to replace them?`,
                warning: true,
                current_hod: currentHod ? { id: currentHod.id, display_name: currentHod.display_name, username: currentHod.username } : null,
                requires_confirm: true
              });
            }
            // confirm_replace is true - demote old HOD to employee
            const oldHodId = dept.hod_user_id;
            await User.update({ role: 'employee' }, { where: { id: oldHodId } });
          }
          // Set new HOD
          await dept.update({ hod_user_id: user.id });
        }
      }

      // If user was HOD and is being changed to a different role, clear them from department
      if (role && role !== 'hod' && user.role === 'hod' && user.department) {
        const dept = await Department.findOne({ where: { name: user.department, hod_user_id: user.id } });
        if (dept) {
          await dept.update({ hod_user_id: null });
        }
      }

      await user.update(updates);

      // If the user was promoted to HOD, send them an email notification
      if (role === 'hod') {
        const hodName = user.display_name || user.username;
        const emailTitle = `You have been assigned as Head of Department`;
        const emailBody = `Hello ${hodName},\n\nYou have been assigned as a Head of Department (HOD) in the MPS IOU Management System.\n\nAs an HOD, you will be required to review and approve IOU requests from your department. You will receive notifications when your approval is needed.\n\nPlease log in to the IOU system to review any pending requests assigned to you.`;
        const emailLink = `/`;

        // Create in-app notification
        notificationService.createNotification({
          target_user_id: user.id,
          title: emailTitle,
          body: emailBody,
          link: emailLink,
          entity: 'USER',
          entity_id: user.id
        }).catch(err => console.error('Failed to create HOD notification:', err));

        // Send email async
        emailService.sendNotificationEmailForUser(user.id, emailTitle, emailBody, emailLink)
          .then(result => {
            if (!result || !result.ok) console.warn('HOD promotion email not sent or returned false:', result);
          })
          .catch(err => console.error('HOD promotion email send error:', err));
      }

      return res.json({ message: 'User role updated', user });
    } catch (err) {
      console.error('setRole error', err);
      return res.status(500).json({ message: 'Error updating role' });
    }
  }
];

/**
 * POST /users/add-by-email
 * Admin-only: Look up a user in LDAP by email, insert into local DB with specified role.
 * Body: { email, role, is_admin }
 * If preview=true, just returns the LDAP lookup result without inserting.
 */
exports.addUserByEmail = [
  isAuthenticated,
  requireAdmin,
  async (req, res) => {
    try {
      const { email, role, is_admin, preview } = req.body;
      if (!email) return res.status(400).json({ message: 'email is required' });

      // Search LDAP by email
      const ldapUrl = process.env.LDAP_SERVER;
      const ldapBaseDn = process.env.LDAP_BASE_DN;
      const ldapBindDn = process.env.LDAP_BIND_DN;
      const ldapBindPassword = process.env.LDAP_BIND_PASSWORD;

      if (!ldapUrl || !ldapBindDn || !ldapBindPassword) {
        return res.status(500).json({ message: 'LDAP not configured' });
      }

      const { Client } = require('ldapts');
      const client = new Client({ url: ldapUrl });
      let ldapEntry = null;

      try {
        await client.bind(ldapBindDn, ldapBindPassword);
        const escapedEmail = email.replace(/[*()\\\\\\0]/g, '\\\\$&');
        const filter = `(|(mail=${escapedEmail})(userPrincipalName=${escapedEmail}))`;
        const { searchEntries } = await client.search(ldapBaseDn, {
          scope: 'sub',
          filter,
          attributes: [
            'description', 'title', 'department', 'company', 'name',
            'givenName', 'displayName', 'sAMAccountName', 'userPrincipalName',
            'mail', 'manager'
          ],
          sizeLimit: 5
        });
        if (searchEntries && searchEntries.length > 0) {
          ldapEntry = searchEntries[0];
        }
      } catch (err) {
        console.error('LDAP search by email failed:', err.message);
        return res.status(500).json({ message: 'LDAP search failed: ' + err.message });
      } finally {
        try { await client.unbind(); } catch (_) {}
      }

      if (!ldapEntry) {
        return res.status(404).json({ message: `No LDAP user found with email: ${email}` });
      }

      // Preview mode: just return the found entry
      if (preview) {
        return res.json({
          preview: true,
          ldap_user: {
            username: ldapEntry.sAMAccountName || ldapEntry.uid || ldapEntry.cn,
            display_name: ldapEntry.displayName || ldapEntry.name || ldapEntry.cn,
            email: ldapEntry.userPrincipalName || ldapEntry.mail || email,
            department: ldapEntry.department || null,
            title: ldapEntry.title || null,
            manager: ldapEntry.manager || null
          }
        });
      }

      // Upsert user from LDAP entry
      const user = await User.upsertFromLdap(ldapEntry);

      // Apply role and admin flag
      const updates = {};
      if (role) updates.role = role;
      if (typeof is_admin !== 'undefined') updates.is_admin = !!is_admin;
      if (Object.keys(updates).length > 0) {
        await user.update(updates);
      }

      // If role is hod, update department table
      if (role === 'hod' && user.department) {
        const Department = require('../models/Department');
        const dept = await Department.findOne({ where: { name: user.department } });
        if (dept) {
          await dept.update({ hod_user_id: user.id });
        }
      }

      return res.status(201).json({ message: 'User added successfully', user });
    } catch (err) {
      console.error('addUserByEmail error', err);
      return res.status(500).json({ message: 'Error adding user' });
    }
  }
];

/**
 * GET /users/approvers
 * List all managed approvers (users where is_approver = true or is_admin = true or role = 'hod')
 */
exports.listApprovers = [
  isAuthenticated,
  async (req, res) => {
    try {
      const { Op } = require('sequelize');
      const approvers = await User.findAll({
        where: {
          [Op.or]: [
            { is_approver: true },
            // { is_admin: true }
          ],
          is_active: true
        },
        order: [['display_name', 'ASC']],
        attributes: { exclude: ['metadata'] }
      });
      return res.json({ data: approvers });
    } catch (err) {
      console.error('listApprovers error', err);
      return res.status(500).json({ message: 'Error fetching approvers' });
    }
  }
];

/**
 * POST /users/approvers
 * Add user to managed approvers list (Cashier or Admin)
 */
exports.addApprover = [
  isAuthenticated,
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor.is_admin && actor.role !== 'cashier') {
        return res.status(403).json({ message: 'Only cashier or admin can manage approvers' });
      }

      const { user_id } = req.body;
      if (!user_id) return res.status(400).json({ message: 'user_id is required' });

      const user = await User.findByPk(user_id);
      if (!user) return res.status(404).json({ message: 'User not found' });

      await user.update({ is_approver: true });

      return res.json({ message: `${user.display_name || user.username} added as an approver.`, user });
    } catch (err) {
      console.error('addApprover error', err);
      return res.status(500).json({ message: 'Error adding approver' });
    }
  }
];

/**
 * DELETE /users/approvers/:id
 * Remove user from managed approvers list (Cashier or Admin)
 */
exports.removeApprover = [
  isAuthenticated,
  async (req, res) => {
    try {
      const actor = req.currentUser;
      if (!actor.is_admin && actor.role !== 'cashier') {
        return res.status(403).json({ message: 'Only cashier or admin can manage approvers' });
      }

      const { id } = req.params;
      const user = await User.findByPk(id);
      if (!user) return res.status(404).json({ message: 'User not found' });

      await user.update({ is_approver: false });

      return res.json({ message: `${user.display_name || user.username} removed from approvers.`, user });
    } catch (err) {
      console.error('removeApprover error', err);
      return res.status(500).json({ message: 'Error removing approver' });
    }
  }
];
