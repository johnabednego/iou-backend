// middleware/auth.js
const User = require('../models/User');

/**
 * isAuthenticated (CommonJS)
 * expects req.session.user to be set by LDAP login (authController)
 * Attaches req.currentUser = DB user row
 */
async function isAuthenticated(req, res, next) {
  try {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ message: 'Not authenticated' });
    }

    const sess = req.session.user || {};
    let dbUser = null;

    if (sess.id) {
      dbUser = await User.findByPk(sess.id);
    }
    if (!dbUser && (sess.username || sess.sAMAccountName || sess.userPrincipalName)) {
      const username = sess.username || sess.sAMAccountName || sess.userPrincipalName;
      dbUser = await User.findOne({ where: { username }});
    }

    // If still not found but we have LDAP raw entry in session, upsert it (respect TTL)
    if (!dbUser && sess.ldap) {
      dbUser = await User.upsertFromLdap(sess.ldap);
    }

    if (!dbUser) {
      return res.status(401).json({ message: 'Authenticated but user record not found. Please login again.' });
    }

    req.currentUser = dbUser;
    return next();
  } catch (err) {
    const code = err?.original?.code || err?.code || '';
    console.error('isAuthenticated error:', err.name, code, err.message);
    if (code === 'ECONNRESET' || code === 'ESOCKET' || code === 'ETIMEOUT') {
      return res.status(503).json({ message: 'Temporary database connection issue. Please try again in a moment.' });
    }
    return res.status(500).json({ message: 'Authentication error. Please try logging in again.' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.currentUser) return res.status(401).json({ message: 'Not authenticated' });
  if (!req.currentUser.is_admin) return res.status(403).json({ message: 'Admin privileges required' });
  return next();
}

module.exports = { isAuthenticated, requireAdmin };
