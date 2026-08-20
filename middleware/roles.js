// middleware/roles.js
function requireRole(role) {
  return function (req, res, next) {
    const u = req.currentUser;
    if (!u) return res.status(401).json({ message: 'Not authenticated' });
    if (u.is_admin) return next(); // admin bypass
    if (Array.isArray(role)) {
      if (role.includes(u.role)) return next();
    } else {
      if (u.role === role) return next();
    }
    return res.status(403).json({ message: 'Forbidden: role required' });
  };
}

function requireCashierOrAdmin(req, res, next) {
  const u = req.currentUser;
  if (!u) return res.status(401).json({ message: 'Not authenticated' });
  if (u.is_admin || u.role === 'cashier') return next();
  return res.status(403).json({ message: 'Forbidden: cashier or admin required' });
}

module.exports = { requireRole, requireCashierOrAdmin };
