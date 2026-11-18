/**
 * SMTP Email Test Script
 * 
 * Run this from the backend folder:
 *   node test-email.js
 * 
 * It sends a test email to jajilima@mps-gh.com using the internal relay.
 * No database interaction — purely SMTP.
 */

const nodemailer = require('nodemailer');

const SMTP_HOST = '172.20.24.200';
const SMTP_PORT = 25;
const FROM_EMAIL = 'pettycash@mps-gh.com';
const TO_EMAIL = 'jajilima@mps-gh.com';

console.log('=== SMTP Email Test ===');
console.log(`Host: ${SMTP_HOST}`);
console.log(`Port: ${SMTP_PORT}`);
console.log(`From: ${FROM_EMAIL}`);
console.log(`To:   ${TO_EMAIL}`);
console.log('');

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false,
  ignoreTLS: true,
  tls: { rejectUnauthorized: false },
  connectionTimeout: 15000,
  greetingTimeout: 15000,
  socketTimeout: 15000
});

(async () => {
  try {
    // Step 1: Verify connection
    console.log('[1/2] Verifying SMTP connection...');
    await transporter.verify();
    console.log('  ✓ SMTP connection verified!\n');

    // Step 2: Send test email
    console.log('[2/2] Sending test email...');
    const info = await transporter.sendMail({
      from: `"IOU Manager - Petty Cash" <${FROM_EMAIL}>`,
      to: TO_EMAIL,
      subject: `[TEST] IOU Manager Email Test - ${new Date().toLocaleString()}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #1e3a5f, #2d5a87); padding: 20px; border-radius: 12px 12px 0 0; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 20px;">✅ IOU Manager Email Test</h1>
          </div>
          <div style="background: #f8fafc; padding: 24px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
            <p style="color: #334155; font-size: 15px; line-height: 1.6;">
              This is a test email from the IOU Manager application.
            </p>
            <p style="color: #334155; font-size: 15px; line-height: 1.6;">
              If you are reading this, the SMTP relay at <strong>${SMTP_HOST}:${SMTP_PORT}</strong> is working correctly.
              All notification emails (approvals, disbursements, etc.) will be delivered successfully.
            </p>
            <div style="background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; padding: 12px 16px; margin-top: 16px;">
              <p style="color: #065f46; margin: 0; font-size: 14px;">
                <strong>Sent at:</strong> ${new Date().toISOString()}<br/>
                <strong>From:</strong> ${FROM_EMAIL}<br/>
                <strong>Relay:</strong> ${SMTP_HOST}:${SMTP_PORT}
              </p>
            </div>
          </div>
        </div>
      `
    });

    console.log('  ✓ Email sent successfully!');
    console.log(`  Message ID: ${info.messageId}`);
    console.log(`  Response: ${info.response}`);
    console.log('\n✅ SUCCESS — Check jajilima@mps-gh.com inbox.');
  } catch (err) {
    console.error('\n❌ FAILED:', err.message);
    console.error('\nFull error:', err);
    if (err.message.includes('Unable to relay')) {
      console.error('\n💡 The relay server is rejecting the recipient.');
      console.error('   Ask the security team to authorize this server\'s IP on the relay.');
    }
  }

  process.exit(0);
})();
