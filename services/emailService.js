// services/emailService.js
const nodemailer = require('nodemailer');
const User = require('../models/User');

const SMTP_HOST = process.env.SMTP_HOST || null;
const SMTP_PORT = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : null;
const SMTP_USER = process.env.SMTP_USER || null;
const SMTP_PASS = process.env.SMTP_PASS || null;
const SMTP_SECURE = (process.env.SMTP_SECURE === 'true'); // true only for port 465 TLS
const IOU_FROM_EMAIL = process.env.IOU_FROM_EMAIL || 'pettycash@mps-gh.com';
const SMTP_VERIFY_ON_CREATE = (process.env.SMTP_VERIFY_ON_CREATE !== 'false'); // default true
const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');

let transporter = null;

function createTransporter() {
  if (!SMTP_HOST || !SMTP_PORT) {
    console.warn('Email: SMTP not configured (SMTP_HOST or SMTP_PORT missing). Emails will be logged to console.');
    return null;
  }

  // For Office365 with port 587: secure should be false (STARTTLS). requireTLS forces STARTTLS.
  const opts = {
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: (SMTP_USER && SMTP_PASS) ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    requireTLS: true, // ensures STARTTLS is used where supported
    tls: {
      // prefer modern TLS
      ciphers: 'TLSv1.2',
      // In production do not disable certificate validation. For local dev you may set NODE_ENV=development
      rejectUnauthorized: process.env.NODE_ENV === 'production' ? true : false
    },
    // helpful timeouts
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 30_000
  };

  const t = nodemailer.createTransport(opts);

  // optionally verify immediately so misconfig problems surface early
  if (SMTP_VERIFY_ON_CREATE) {
    t.verify()
      .then(() => {
        console.log('SMTP transporter verified successfully.');
      })
      .catch((err) => {
        console.error('SMTP transporter verification failed:', err && err.message ? err.message : err);
      });
  }

  return t;
}

function getTransporter() {
  if (transporter) return transporter;
  transporter = createTransporter();
  return transporter;
}

/**
 * Send raw mail using nodemailer transporter.
 * If transporter not configured, falls back to console.log (dev).
 *
 * opts: { to, subject, text, html, from }
 */
async function sendMail(opts = {}) {
  const t = getTransporter();
  const mailOpts = {
    from: opts.from || IOU_FROM_EMAIL,
    to: opts.to,
    subject: opts.subject,
    text: opts.text || opts.subject,
    html: opts.html || `<div>${(opts.text || opts.subject) || ''}</div>`
  };

  if (!t) {
    // fallback: print to console (so dev can read)
    console.log('EMAIL (not sent - transporter not configured):', mailOpts);
    return { ok: false, reason: 'smtp-not-configured' };
  }

  try {
    const info = await t.sendMail(mailOpts);
    return { ok: true, info };
  } catch (err) {
    // Provide actionable info
    console.error('sendMail error', err && err.code ? `${err.code} - ${err.message}` : err);
    // Return a normalized error object so callers can act on it
    return {
      ok: false,
      error: {
        code: err.code || 'SMTP_ERROR',
        message: err.message || String(err),
        stack: process.env.NODE_ENV === 'production' ? undefined : err.stack
      }
    };
  }
}

/* ── Email Template Helpers ── */

/**
 * Detect email category from subject/body to apply the right styling.
 */
function detectCategory(subject, body) {
  const s = ((subject || '') + ' ' + (body || '')).toLowerCase();
  if (s.includes('rejected') || s.includes('reject'))   return 'rejected';
  if (s.includes('returned') || s.includes('return'))    return 'returned';
  if (s.includes('approved') || s.includes('approval confirmed') || s.includes('approve')) return 'approved';
  if (s.includes('disburs'))                             return 'disbursed';
  if (s.includes('reconcil'))                            return 'reconciled';
  if (s.includes('redeem'))                              return 'redeemed';
  if (s.includes('expense'))                             return 'expense';
  if (s.includes('assign') || s.includes('required'))    return 'action';
  return 'info';
}

const CATEGORY_STYLES = {
  rejected:   { accent: '#dc2626', accentLight: '#fef2f2', icon: '✕', label: 'Rejected',   gradient: 'linear-gradient(135deg, #dc2626 0%, #991b1b 100%)' },
  returned:   { accent: '#d97706', accentLight: '#fffbeb', icon: '↩',  label: 'Returned',   gradient: 'linear-gradient(135deg, #d97706 0%, #92400e 100%)' },
  approved:   { accent: '#059669', accentLight: '#ecfdf5', icon: '✓', label: 'Approved',   gradient: 'linear-gradient(135deg, #059669 0%, #065f46 100%)' },
  disbursed:  { accent: '#2563eb', accentLight: '#eff6ff', icon: '💰', label: 'Disbursed',  gradient: 'linear-gradient(135deg, #2563eb 0%, #1e40af 100%)' },
  reconciled: { accent: '#0d9488', accentLight: '#f0fdfa', icon: '📋', label: 'Reconciled', gradient: 'linear-gradient(135deg, #0d9488 0%, #115e59 100%)' },
  redeemed:   { accent: '#16a34a', accentLight: '#f0fdf4', icon: '🎉', label: 'Redeemed',   gradient: 'linear-gradient(135deg, #16a34a 0%, #14532d 100%)' },
  expense:    { accent: '#7c3aed', accentLight: '#f5f3ff', icon: '📄', label: 'Expense',    gradient: 'linear-gradient(135deg, #7c3aed 0%, #4c1d95 100%)' },
  action:     { accent: '#2563eb', accentLight: '#eff6ff', icon: '🔔', label: 'Action Required', gradient: 'linear-gradient(135deg, #2563eb 0%, #1e40af 100%)' },
  info:       { accent: '#6366f1', accentLight: '#eef2ff', icon: 'ℹ',  label: 'Notification', gradient: 'linear-gradient(135deg, #6366f1 0%, #4338ca 100%)' },
};

/**
 * Build a beautiful, modern HTML email template.
 */
function buildEmailHtml(subject, body, link, category) {
  const style = CATEGORY_STYLES[category] || CATEGORY_STYLES.info;
  const fullLink = link ? `${FRONTEND_URL}${link.startsWith('/') ? '' : '/'}${link}` : null;
  const year = new Date().getFullYear();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f5f9;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

          <!-- Header Banner -->
          <tr>
            <td style="background-color:${style.accent};background-image:${style.gradient};padding:28px 32px;text-align:center;">
              <div style="font-size:36px;line-height:1;margin-bottom:8px;">${style.icon}</div>
              <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.3px;">${style.label}</h1>
              <p style="margin:4px 0 0;color:rgba(255,255,255,0.85);font-size:13px;font-weight:400;">MPS Petty Cash &mdash; IOU Manager</p>
            </td>
          </tr>

          <!-- Subject Line -->
          <tr>
            <td style="padding:24px 32px 0;">
              <h2 style="margin:0 0 16px;font-size:17px;font-weight:600;color:#1e293b;line-height:1.4;">${subject}</h2>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:0 32px 24px;">
              <div style="background-color:${style.accentLight};border-left:4px solid ${style.accent};border-radius:0 8px 8px 0;padding:16px 20px;">
                <p style="margin:0;font-size:14px;line-height:1.7;color:#334155;">${(body || '').replace(/\n/g, '<br>')}</p>
              </div>
            </td>
          </tr>

          ${fullLink ? `
          <!-- CTA Button -->
          <tr>
            <td style="padding:0 32px 28px;text-align:center;">
              <a href="${fullLink}" target="_blank" style="display:inline-block;padding:14px 36px;background-color:${style.accent};background-image:${style.gradient};color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;border-radius:10px;letter-spacing:0.3px;box-shadow:0 2px 12px rgba(0,0,0,0.15);">
                Open in IOU App &rarr;
              </a>
            </td>
          </tr>` : ''}

          <!-- Divider -->
          <tr>
            <td style="padding:0 32px;">
              <hr style="border:none;border-top:1px solid #e2e8f0;margin:0;">
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 32px 24px;text-align:center;">
              <p style="margin:0 0 4px;font-size:11px;color:#94a3b8;">This is an automated message from the IOU Manager System.</p>
              <p style="margin:0 0 4px;font-size:11px;color:#94a3b8;">Meridian Port Services (MPS) &bull; Petty Cash &bull; Finance Department</p>
              <p style="margin:0;font-size:11px;color:#cbd5e1;">&copy; ${year} MPS. All rights reserved.</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Convenience: fetch user by id and send notification email if user.email exists.
 */
async function sendNotificationEmailForUser(userId, subject, body, link = null) {
  try {
    const user = await User.findByPk(userId);
    if (!user || !user.email) return null;

    const category = detectCategory(subject, body);
    const html = buildEmailHtml(subject, body, link, category);
    const fullLink = link ? `${FRONTEND_URL}${link.startsWith('/') ? '' : '/'}${link}` : null;
    const plainText = `${subject}\n\n${body || ''}\n\n${fullLink ? 'Open in app: ' + fullLink : ''}\n\n---\nMPS Petty Cash - IOU Manager`;

    const res = await sendMail({
      to: user.email,
      subject,
      text: plainText,
      html,
      from: IOU_FROM_EMAIL
    });
    return res;
  } catch (err) {
    console.error('sendNotificationEmailForUser error', err);
    return null;
  }
}

module.exports = {
  sendMail,
  sendNotificationEmailForUser,
  // expose verify helper
  verifyTransporter: async () => {
    const t = getTransporter();
    if (!t) return { ok: false, reason: 'not-configured' };
    try {
      await t.verify();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err };
    }
  }
};
