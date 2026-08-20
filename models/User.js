// models/User.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');
require('dotenv').config();

const DEFAULT_TTL_DAYS = parseInt(process.env.LDAP_USER_SYNC_TTL_DAYS || '30', 10);
const DEFAULT_SYNC_TTL_MS = DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000; // default 30 days

/**
 * Extract the first OU value from an LDAP DN string.
 * Example DN: "CN=John Doe,OU=IT,OU=DEPARTMENT,DC=mpsgh,DC=com"
 * Returns: "IT" or null
 */
function extractDepartmentFromDn(dn) {
  if (!dn || typeof dn !== 'string') return null;
  // find the first OU=... token (case-insensitive)
  const match = dn.match(/(?:^|,)\s*OU=([^,]+)/i);
  if (match && match[1]) {
    return match[1].trim();
  }
  return null;
}

/**
 * Extract the CN (common name) from an LDAP DN string.
 * Example DN: "CN=Faraz Ahmad,OU=IT,OU=DEPARTMENT,DC=mpsgh,DC=com"
 * Returns: "Faraz Ahmad" or null
 */
function extractCnFromDn(dn) {
  if (!dn || typeof dn !== 'string') return null;
  // Capture the value after CN= up to the next comma
  const match = dn.match(/(?:^|,)\s*CN=([^,]+)/i);
  if (match && match[1]) {
    return match[1].trim();
  }
  return null;
}

class User extends Model {
  /**
   * Upsert user record from an LDAP entry.
   * - Create if missing
   * - Update only if fields changed OR last_synced_at older than TTL
   *
   * @param {object} ldapEntry - entry returned by ldapts searchEntries[i]
   * @param {object} options - { forceSyncMs: number } to override TTL
   */
  static async upsertFromLdap(ldapEntry = {}, options = {}) {
    if (!ldapEntry) throw new Error('LDAP entry required');

    // username from common LDAP attributes
    const username = ldapEntry.sAMAccountName || ldapEntry.uid || ldapEntry.cn;
    if (!username) throw new Error('LDAP entry missing username');

    const ldapDn = ldapEntry.dn || ldapEntry.distinguishedName || null;
    const email = (ldapEntry.userPrincipalName && ldapEntry.userPrincipalName.includes('@'))
      ? ldapEntry.userPrincipalName
      : (ldapEntry.mail || null);
    const displayName = ldapEntry.displayName || ldapEntry.name || ldapEntry.cn || ldapEntry.givenName || username;

    // Department: prefer explicit attribute, otherwise parse from DN
    const departmentFromAttribute = (() => {
      if (!ldapEntry) return null;
      if (Array.isArray(ldapEntry.department) && ldapEntry.department.length) return String(ldapEntry.department[0]);
      if (typeof ldapEntry.department === 'string' && ldapEntry.department.length) return ldapEntry.department;
      if (Array.isArray(ldapEntry.ou) && ldapEntry.ou.length) return String(ldapEntry.ou[0]);
      if (typeof ldapEntry.ou === 'string' && ldapEntry.ou.length) return ldapEntry.ou;
      return null;
    })();
    const department = departmentFromAttribute || extractDepartmentFromDn(ldapDn);

    // Manager: try to take friendly attribute if available; otherwise parse CN from manager DN
    const managerFromAttribute = (() => {
      if (!ldapEntry) return null;
      // some LDAPs return manager as DN string (e.g. "CN=Foo Bar,...")
      // some may return managerDisplayName or managerName etc. Check common possibilities.
      if (Array.isArray(ldapEntry.manager) && ldapEntry.manager.length) return String(ldapEntry.manager[0]);
      if (typeof ldapEntry.manager === 'string' && ldapEntry.manager.length) return String(ldapEntry.manager);
      if (Array.isArray(ldapEntry.managerDisplayName) && ldapEntry.managerDisplayName.length) return String(ldapEntry.managerDisplayName[0]);
      if (typeof ldapEntry.managerDisplayName === 'string' && ldapEntry.managerDisplayName.length) return ldapEntry.managerDisplayName;
      if (Array.isArray(ldapEntry.managerName) && ldapEntry.managerName.length) return String(ldapEntry.managerName[0]);
      if (typeof ldapEntry.managerName === 'string' && ldapEntry.managerName.length) return ldapEntry.managerName;
      return null;
    })();

// managerFromAttribute may be a DN; extract CN if it looks like a DN
    let manager = null;
    if (managerFromAttribute) {
      // If managerFromAttribute looks like a DN (contains 'CN='), extract CN
      if (/CN=/i.test(managerFromAttribute)) {
        manager = extractCnFromDn(managerFromAttribute);
      } else {
        manager = managerFromAttribute;
      }
    } else {
      // fallback: sometimes LDAP provides manager DN in other properties, or none - try to look in ldapEntry.manager (already done),
      // otherwise if we have a manager DN somewhere else (rare), we could parse.
      // If ldapEntry.manager is a DN-like value, extract CN
      if (ldapEntry && ldapEntry.manager && typeof ldapEntry.manager === 'string') {
        manager = extractCnFromDn(ldapEntry.manager) || ldapEntry.manager;
      } else {
        manager = null;
      }
    }

    // If manager is still a DN string (unexpected), attempt CN extraction once more
    if (manager && typeof manager === 'string' && /CN=/i.test(manager)) {
      const cn = extractCnFromDn(manager);
      if (cn) manager = cn;
    }

    let user = await User.findOne({ where: { username } });

    const now = new Date();
    const forceSyncMs = (typeof options.forceSyncMs === 'number') ? options.forceSyncMs : DEFAULT_SYNC_TTL_MS;

    if (!user) {
      const payload = {
        username,
        email,
        display_name: displayName,
        ldap_dn: ldapDn,
        department: department || null,
        manager: manager || null,
        metadata: ldapEntry,
        last_synced_at: now,
      };
      user = await User.create(payload);
      return user;
    }

    // Decide if update required
    const lastSynced = user.last_synced_at ? new Date(user.last_synced_at) : null;
    const stale = !lastSynced || (now - lastSynced) > forceSyncMs;

    const needsFieldUpdate =
      (email && user.email !== email) ||
      (displayName && user.display_name !== displayName) ||
      (ldapDn && user.ldap_dn !== ldapDn) ||
      (department && user.department !== department) ||
      (manager && user.manager !== manager);

    const oldMeta = user.metadata ? JSON.stringify(user.metadata) : null;
    const newMeta = ldapEntry ? JSON.stringify(ldapEntry) : null;
    const metadataChanged = oldMeta !== newMeta;

    if (needsFieldUpdate || metadataChanged || stale) {
      const changed = {};
      if (email && user.email !== email) changed.email = email;
      if (displayName && user.display_name !== displayName) changed.display_name = displayName;
      if (ldapDn && user.ldap_dn !== ldapDn) changed.ldap_dn = ldapDn;
      if (typeof department !== 'undefined' && user.department !== department) changed.department = department;
      if (typeof manager !== 'undefined' && user.manager !== manager) changed.manager = manager;
      changed.metadata = ldapEntry;
      changed.last_synced_at = now;
      await user.update(changed);
    }

    return user;
  }
}

User.init({
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  username: {
    type: DataTypes.STRING(128),
    allowNull: false,
    unique: true,
  },
  email: {
    type: DataTypes.STRING(254),
    allowNull: true,
    validate: { isEmail: true },
  },
  display_name: {
    type: DataTypes.STRING(256),
    allowNull: true,
  },
  ldap_dn: {
    type: DataTypes.STRING(512),
    allowNull: true,
  },
  department: {
    type: DataTypes.STRING(256),
    allowNull: true,
  },
  manager: {
    type: DataTypes.STRING(256),
    allowNull: true,
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
  // Local role management
  role: {
    type: DataTypes.STRING(64),
    allowNull: true,
    defaultValue: 'employee'
  },
  // Explicit admin flag
  is_admin: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  // Managed approver flag (Finance/Authorizer approver list)
  is_approver: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
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
  last_synced_at: {
    type: DataTypes.DATE,
    allowNull: true,
  }
}, {
  sequelize,
  modelName: 'User',
  tableName: 'users',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = User;
