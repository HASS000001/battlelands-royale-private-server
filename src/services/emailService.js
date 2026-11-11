'use strict';
/**
 * src/services/emailService.js
 * Email verification + anti-alt normalization.
 */

const nodemailer = require('nodemailer');
const { randomInt } = require('crypto');
const { db } = require('../db');

// Transporter
let transporter = null;

function getTransporter() {
  if (!process.env.SMTP_HOST) {
    throw new Error('Email delivery is not configured. Set SMTP_HOST and the SMTP credentials.');
  }
  if (!(process.env.SMTP_FROM || process.env.SMTP_USER)) {
    throw new Error('Set SMTP_FROM or SMTP_USER to provide a sender address.');
  }
  if (!transporter) {
    const auth = process.env.SMTP_USER && process.env.SMTP_PASS
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined;
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth,
    });
  }
  return transporter;
}

function getAppName() {
  return String(process.env.APP_NAME || 'Game').trim() || 'Game';
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Anti-alt normalization
// Strips + aliases and Gmail dots so "u.ser+alt@gmail.com" === "user@gmail.com"
function normalizeEmail(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const lower = raw.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at < 1) return null;

  let local  = lower.slice(0, at);
  const domain = lower.slice(at + 1);

  // Strip + alias on all providers
  local = local.split('+')[0];

  // Gmail: remove dots in local part
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replace(/\./g, '');
    return `${local}@gmail.com`;
  }

  return `${local}@${domain}`;
}

// Send OTP
async function sendVerificationCode(playFabId, email) {
  const mailer = getTransporter();
  const normalized = normalizeEmail(email);
  if (!normalized) throw Object.assign(new Error('Invalid email address.'), { code: 'INVALID_EMAIL' });

  // Block if normalized email already used by a different account
  const existing = await db.one(
    'SELECT playfab_id FROM players WHERE email_normalized = $1 AND playfab_id <> $2',
    [normalized, playFabId]
  );
  if (existing) throw Object.assign(
    new Error('This email is already linked to another account.'),
    { code: 'EMAIL_TAKEN' }
  );

  // Save email (unverified) + normalized form
  await db.query(
    `UPDATE players SET email = $2, email_normalized = $3, email_verified = FALSE WHERE playfab_id = $1`,
    [playFabId, email.trim().toLowerCase(), normalized]
  );

  // Invalidate old unused codes
  await db.query(
    'UPDATE email_verify_codes SET used = TRUE WHERE playfab_id = $1 AND used = FALSE',
    [playFabId]
  );

  // Generate 6-digit OTP
  const code = String(randomInt(100000, 999999));
  await db.query(
    `INSERT INTO email_verify_codes (playfab_id, code, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '10 minutes')`,
    [playFabId, code]
  );

  // Send email
  await mailer.sendMail({
    from:    { name: getAppName(), address: process.env.SMTP_FROM || process.env.SMTP_USER },
    to:      email.trim().toLowerCase(),
    subject: `${getAppName()} verification code`,
    html: `
      <div style="background:#1a1a2e;color:#fff;padding:32px;border-radius:12px;font-family:sans-serif;max-width:480px">
        <h2 style="color:#6d28d9;margin-top:0">${escapeHtml(getAppName())}</h2>
        <p>Your verification code:</p>
        <div style="font-size:36px;font-weight:bold;letter-spacing:10px;color:#FF6B00;margin:24px 0">${code}</div>
        <p style="color:#aaa;font-size:13px">Valid for 10 minutes. Do not share this code.</p>
      </div>`,
    text: `${getAppName()} verification code: ${code}\nValid for 10 minutes.`,
  });

  return { sent: true };
}

// Verify OTP
async function verifyEmailCode(playFabId, code) {
  const row = await db.one(
    `SELECT id FROM email_verify_codes
     WHERE playfab_id = $1 AND code = $2
       AND used = FALSE AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [playFabId, String(code).trim()]
  );
  if (!row) throw Object.assign(
    new Error('Invalid or expired code. Request a new one.'),
    { code: 'INVALID_CODE' }
  );

  await db.tx(async tx => {
    await tx.query('UPDATE email_verify_codes SET used = TRUE WHERE id = $1', [row.id]);
    await tx.query(
      'UPDATE players SET email_verified = TRUE, setup_complete = TRUE WHERE playfab_id = $1',
      [playFabId]
    );
  });

  return { verified: true };
}


// Login OTP - for already-verified accounts. Does NOT touch email or email_verified.
async function sendLoginOtp(playFabId, email) {
  const mailer = getTransporter();
  // Invalidate old unused codes
  await db.query(
    'UPDATE email_verify_codes SET used = TRUE WHERE playfab_id = $1 AND used = FALSE',
    [playFabId]
  );
  const code = String(randomInt(100000, 999999));
  await db.query(
    `INSERT INTO email_verify_codes (playfab_id, code, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '10 minutes')`,
    [playFabId, code]
  );
  await mailer.sendMail({
    from:    { name: getAppName(), address: process.env.SMTP_FROM || process.env.SMTP_USER },
    to:      email.trim().toLowerCase(),
    subject: `${getAppName()} login code`,
    html: `
      <div style="background:#1a1a2e;color:#fff;padding:32px;border-radius:12px;font-family:sans-serif;max-width:480px">
        <h2 style="color:#6d28d9;margin-top:0">${escapeHtml(getAppName())}</h2>
        <p>Your login code:</p>
        <div style="font-size:36px;font-weight:bold;letter-spacing:10px;color:#FF6B00;margin:24px 0">${code}</div>
        <p style="color:#aaa;font-size:13px">Valid for 10 minutes. Do not share this code.</p>
      </div>`,
    text: `${getAppName()} login code: ${code}`,
  });
  return { sent: true };
}

module.exports = { normalizeEmail, sendVerificationCode, verifyEmailCode, sendLoginOtp };
