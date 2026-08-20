// services/notificationService.js
const Notification = require('../models/Notification');
const emailService = require('./emailService');

/**
 * Create a notification row.
 * - data: { target_user_id, title, body, link, entity, entity_id }
 * - opts: { transaction }
 *
 * Returns the created Notification instance.
 */
async function createNotification(data = {}, opts = {}) {
  const created = await Notification.create({
    target_user_id: data.target_user_id,
    title: data.title,
    body: data.body || null,
    link: data.link || null,
    entity: data.entity || null,
    entity_id: data.entity_id || null,
    is_read: false
  }, { transaction: opts.transaction });

  return created;
}

/**
 * Helper to both create DB notification and send email (after commit).
 * Use this if you want to create the DB row (optionally inside a transaction) and then send the email after commit.
 *
 * Note: Do NOT pass transaction here if you require the notification to persist before sending email.
 */
async function createAndSendEmail({ target_user_id, title, body, link, entity, entity_id } = {}) {
  const note = await createNotification({ target_user_id, title, body, link, entity, entity_id });
  // send email asynchronously (don't block)
  emailService.sendNotificationEmailForUser(target_user_id, title, body, link)
    .then(r => {
      if (!r || !r.ok) console.warn('Email not sent or returned false', r);
    })
    .catch(err => {
      console.error('Email send error (async)', err);
    });

  return note;
}

module.exports = {
  createNotification,
  createAndSendEmail
};
