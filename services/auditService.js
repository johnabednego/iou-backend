const AuditLog = require('../models/AuditLog');

async function log({ actorId = null, actorName = null, action, entity = null, entityId = null, details = null }, options = {}) {
  try {
    const row = await AuditLog.create({
      actor_id: actorId,
      actor_name: actorName,
      action,
      entity,
      entity_id: entityId,
      details
    }, options);
    return row;
  } catch (err) {
    // do not throw; log to console so it doesn't block main flow
    console.error('auditService.log error', err);
    return null;
  }
}

module.exports = { log };
