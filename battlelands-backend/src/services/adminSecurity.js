'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { db, redis } = require('../db');

let bcrypt = null;
try {
  // Optional enhancement; the code still works without it.
  bcrypt = require('bcryptjs');
} catch {
  bcrypt = null;
}

const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 7;
const LOCK_TTL_SECONDS = 15 * 60;
const FAILURE_WINDOW_SECONDS = 15 * 60;
const FAILURE_LIMIT = 10;
const JWT_ALGORITHM = 'HS256';
const JWT_ISSUER = process.env.JWT_ISSUER || 'self-hosted-backend';
const ROLE_ORDER = { moderator: 1, admin: 2, superadmin: 3 };

function getAdminEmail() {
  return String(process.env.ADMIN_EMAIL || process.env.ADMIN_USERNAME || 'admin@example.com').trim().toLowerCase();
}

function getAdminPassword() {
  return String(process.env.ADMIN_PASSWORD || '').trim();
}

function getAdminTotpSecret() {
  return String(process.env.ADMIN_TOTP_SECRET || '').trim();
}

function base32Encode(buffer) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(input).replace(/=+$/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function generateTotpSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

function buildOtpAuthUri(email, secret, issuer = `${process.env.APP_NAME || 'Game Backend'} Dashboard`) {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

function totpAt(secret, timeStep = 30, digits = 6, forTime = Date.now()) {
  const counter = Math.floor(forTime / 1000 / timeStep);
  const key = base32Decode(secret);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  const otp = code % (10 ** digits);
  return String(otp).padStart(digits, '0');
}

function verifyTotp(token, secret, window = 1) {
  const value = String(token || '').replace(/\s+/g, '');
  if (!/^[0-9]{6}$/.test(value) || !secret) return false;
  const now = Date.now();
  for (let delta = -window; delta <= window; delta += 1) {
    const candidate = totpAt(secret, 30, 6, now + delta * 30_000);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(value))) return true;
  }
  return false;
}

function hashPasswordFallback(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const rounds = 210_000;
  const derived = crypto.pbkdf2Sync(String(password), salt, rounds, 64, 'sha512').toString('base64url');
  return `pbkdf2$${rounds}$${salt}$sha512$${derived}`;
}

async function hashPassword(password) {
  if (bcrypt) {
    return bcrypt.hash(String(password), 12);
  }
  return hashPasswordFallback(password);
}

async function verifyPassword(password, storedHash) {
  if (!storedHash) return false;
  const hash = String(storedHash);
  if (bcrypt && hash.startsWith('$2')) {
    return bcrypt.compare(String(password), hash);
  }
  if (hash.startsWith('pbkdf2$')) {
    const [, roundsText, salt, digest, derived] = hash.split('$');
    const rounds = Number(roundsText);
    if (!rounds || !salt || digest !== 'sha512' || !derived) return false;
    const candidate = crypto.pbkdf2Sync(String(password), salt, rounds, 64, 'sha512').toString('base64url');
    return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(derived));
  }
  return false;
}

function generateCsrfToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function csrfCookieValue(token) {
  return `admin_csrf=${token}; HttpOnly; Path=/Admin; SameSite=Strict; Max-Age=${REFRESH_TTL_SECONDS}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}

function issueAuthCookies({ refreshToken, accessToken, csrfToken }) {
  const cookies = [];
  if (refreshToken) cookies.push(`admin_refresh=${refreshToken}; HttpOnly; Path=/Admin; SameSite=Strict; Max-Age=${REFRESH_TTL_SECONDS}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  if (accessToken) cookies.push(`admin_access=${accessToken}; HttpOnly; Path=/Admin; SameSite=Strict; Max-Age=${ACCESS_TTL_SECONDS}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  if (csrfToken) cookies.push(`admin_csrf=${csrfToken}; Path=/Admin; SameSite=Strict; Max-Age=${REFRESH_TTL_SECONDS}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  return cookies;
}

function requireCsrf(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const cookies = parseCookies(req);
  const expected = cookies.admin_csrf;
  const provided = req.get('X-CSRF-Token') || req.body?.csrfToken || '';
  if (!expected || !provided || provided !== expected) {
    return res.status(403).json({ code: 403, status: 'Forbidden', error: 'InvalidCsrfToken', errorMessage: 'CSRF token required.', errorDetails: {} });
  }
  return next();
}

function requireRole(minRole = 'superadmin') {
  const threshold = ROLE_ORDER[minRole] || ROLE_ORDER.superadmin;
  return function roleMiddleware(req, res, next) {
    const current = ROLE_ORDER[req.admin?.role || 'superadmin'] || 0;
    if (current < threshold) {
      return res.status(403).json({ code: 403, status: 'Forbidden', error: 'InsufficientRole', errorMessage: `Requires ${minRole} role.`, errorDetails: {} });
    }
    return next();
  };
}

function signAccessToken(payload) {

  return jwt.sign(payload, process.env.SESSION_SECRET, {
    algorithm: JWT_ALGORITHM,
    expiresIn: ACCESS_TTL_SECONDS,
    issuer: JWT_ISSUER,
    subject: payload.email
  });
}

function verifyAccessToken(token) {
  return jwt.verify(token, process.env.SESSION_SECRET, {
    algorithms: [JWT_ALGORITHM],
    issuer: JWT_ISSUER
  });
}

function signRefreshToken(payload) {
  const jti = crypto.randomUUID();
  const token = jwt.sign({ ...payload, type: 'refresh', jti }, process.env.SESSION_SECRET, {
    algorithm: JWT_ALGORITHM,
    expiresIn: REFRESH_TTL_SECONDS,
    issuer: JWT_ISSUER,
    subject: payload.email
  });
  return { token, jti };
}

function verifyRefreshToken(token) {
  const decoded = jwt.verify(token, process.env.SESSION_SECRET, {
    algorithms: [JWT_ALGORITHM],
    issuer: JWT_ISSUER
  });
  if (decoded.type !== 'refresh') throw new Error('Invalid refresh token');
  return decoded;
}

async function ensureAdminSeed() {
  const email = getAdminEmail();
  const password = getAdminPassword();
  const totpSecret = getAdminTotpSecret() || generateTotpSecret();
  const existing = await db.one('SELECT email FROM admin_users WHERE email = $1', [email]);
  if (existing) {
    return {
      seeded: false,
      email,
      totpSecret,
      otpAuthUri: buildOtpAuthUri(email, totpSecret),
    };
  }

  if (!password) {
    throw new Error('ADMIN_PASSWORD is required to seed the admin account.');
  }

  const passwordHash = await hashPassword(password);
  await db.query(
    `INSERT INTO admin_users (email, password_hash, totp_secret, role, enabled, created_at, last_login)
     VALUES ($1, $2, $3, 'superadmin', TRUE, NOW(), NULL)`,
    [email, passwordHash, totpSecret]
  );
  return {
    seeded: true,
    email,
    totpSecret,
    otpAuthUri: buildOtpAuthUri(email, totpSecret),
  };
}

async function getAdminByEmail(email) {
  return db.one('SELECT * FROM admin_users WHERE email = $1', [String(email).trim().toLowerCase()]);
}

async function isLocked(email, ipAddress) {
  const key = `admin:lock:${email}:${ipAddress}`;
  const until = await redis.get(key).catch(() => null);
  return until ? Number(until) : 0;
}

async function recordFailure(email, ipAddress) {
  const key = `admin:fail:${email}:${ipAddress}`;
  const lockKey = `admin:lock:${email}:${ipAddress}`;
  const failures = await redis.incr(key).catch(() => 1);
  if (failures === 1) {
    await redis.expire(key, FAILURE_WINDOW_SECONDS).catch(() => {});
  }
  await db.query(
    `UPDATE admin_users
        SET failed_attempts = failed_attempts + 1,
            locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN NOW() + INTERVAL '15 minutes' ELSE locked_until END
      WHERE email = $1`,
    [email, FAILURE_LIMIT]
  ).catch(() => {});
  if (failures >= FAILURE_LIMIT) {
    const until = Date.now() + LOCK_TTL_SECONDS * 1000;
    await redis.set(lockKey, String(until), 'EX', LOCK_TTL_SECONDS).catch(() => {});
    await db.query('UPDATE admin_users SET locked_until = NOW() + INTERVAL \'15 minutes\' WHERE email = $1', [email]).catch(() => {});
  }
  return failures;
}

async function clearFailures(email, ipAddress) {
  await redis.del(`admin:fail:${email}:${ipAddress}`).catch(() => {});
  await redis.del(`admin:lock:${email}:${ipAddress}`).catch(() => {});
  await db.query('UPDATE admin_users SET failed_attempts = 0, locked_until = NULL WHERE email = $1', [email]).catch(() => {});
}

async function authenticateAdmin({ email, password, totp, ipAddress }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const admin = await getAdminByEmail(normalizedEmail);
  if (!admin || !admin.enabled) {
    await recordFailure(normalizedEmail || 'unknown', ipAddress);
    return { ok: false, reason: 'Invalid credentials.' };
  }
  const lockUntil = await isLocked(normalizedEmail, ipAddress);
  if (lockUntil && lockUntil > Date.now()) {
    return { ok: false, reason: 'Account temporarily locked.', lockedUntil: new Date(lockUntil).toISOString() };
  }
  if (admin.locked_until && new Date(admin.locked_until).getTime() > Date.now()) {
    return { ok: false, reason: 'Account temporarily locked.', lockedUntil: new Date(admin.locked_until).toISOString() };
  }

  const passwordOk = await verifyPassword(password, admin.password_hash);
  const totpOk = verifyTotp(totp, admin.totp_secret);
  if (!passwordOk || !totpOk) {
    await recordFailure(normalizedEmail, ipAddress);
    return { ok: false, reason: 'Invalid credentials or TOTP code.' };
  }

  await clearFailures(normalizedEmail, ipAddress);
  await db.query('UPDATE admin_users SET last_login = NOW(), locked_until = NULL WHERE email = $1', [normalizedEmail]);

  const accessToken = signAccessToken({ email: normalizedEmail, role: admin.role || 'superadmin' });
  const { token: refreshToken, jti } = signRefreshToken({ email: normalizedEmail, role: admin.role || 'superadmin' });
  await db.query(
    `INSERT INTO admin_refresh_tokens (jti, email, expires_at, revoked)
     VALUES ($1, $2, NOW() + INTERVAL '7 days', FALSE)
     ON CONFLICT (jti) DO UPDATE SET revoked = FALSE, expires_at = EXCLUDED.expires_at`,
    [jti, normalizedEmail]
  );

  return {
    ok: true,
    admin: { email: normalizedEmail, role: admin.role || 'superadmin' },
    accessToken,
    refreshToken,
    refreshCookie: `admin_refresh=${refreshToken}; HttpOnly; Path=/Admin; SameSite=Strict; Max-Age=${REFRESH_TTL_SECONDS}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
    expiresIn: ACCESS_TTL_SECONDS,
    otpAuthUri: buildOtpAuthUri(normalizedEmail, admin.totp_secret),
    csrfToken: generateCsrfToken(),
  };
}

async function consumeRefreshToken(token) {
  const decoded = verifyRefreshToken(token);
  const row = await db.one('SELECT * FROM admin_refresh_tokens WHERE jti = $1 AND email = $2 AND revoked = FALSE AND expires_at > NOW()', [decoded.jti, decoded.email]);
  if (!row) throw new Error('Refresh token revoked or expired');
  return decoded;
}

async function revokeRefreshToken(token) {
  if (!token) return;
  try {
    const decoded = verifyRefreshToken(token);
    await db.query('UPDATE admin_refresh_tokens SET revoked = TRUE WHERE jti = $1 AND email = $2', [decoded.jti, decoded.email]);
  } catch {
    // ignore malformed tokens on logout
  }
}

async function revokeAllRefreshTokens(email) {
  await db.query('UPDATE admin_refresh_tokens SET revoked = TRUE WHERE email = $1', [String(email).trim().toLowerCase()]);
}

function getBearerToken(req) {
  const header = req.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function parseCookies(req) {
  const raw = req.get('Cookie') || '';
  return Object.fromEntries(raw.split(/;\s*/).filter(Boolean).map((pair) => {
    const index = pair.indexOf('=');
    if (index === -1) return [pair, ''];
    return [decodeURIComponent(pair.slice(0, index)), decodeURIComponent(pair.slice(index + 1))];
  }));
}

async function requireAdmin(req, res, next) {
  try {
    // Discord bot uses a static long-lived token (no TOTP / refresh flow)
    const botToken = process.env.DISCORD_BOT_API_TOKEN;
    if (botToken && req.get('X-Bot-Source') === 'discord') {
      const bearer = getBearerToken(req);
      if (bearer === botToken) {
        req.admin = { email: 'discord-bot', role: 'superadmin' };
        return next();
      }
      return res.status(401).json({ code: 401, status: 'Unauthorized', error: 'InvalidBotToken', errorMessage: 'Invalid bot API token.' });
    }
    const token = getBearerToken(req) || parseCookies(req).admin_access;
    if (!token) {
      return res.status(401).json({ code: 401, status: 'Unauthorized', error: 'MissingToken', errorMessage: 'Admin token required.' });
    }
    const decoded = verifyAccessToken(token);
    const admin = await getAdminByEmail(decoded.email);
    if (!admin || !admin.enabled) {
      return res.status(401).json({ code: 401, status: 'Unauthorized', error: 'InvalidAdmin', errorMessage: 'Admin account disabled or missing.' });
    }
    req.admin = { email: admin.email, role: admin.role || 'superadmin' };
    return next();
  } catch (error) {
    return res.status(401).json({ code: 401, status: 'Unauthorized', error: 'InvalidToken', errorMessage: error.message });
  }
}

module.exports = {
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  ensureAdminSeed,
  authenticateAdmin,
  consumeRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokens,
  requireAdmin,
  getAdminByEmail,
  hashPassword,
  verifyPassword,
  generateTotpSecret,
  buildOtpAuthUri,
  verifyTotp,
  signAccessToken,
  verifyAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  parseCookies,
  getBearerToken,
  getAdminEmail,
  generateCsrfToken,
  issueAuthCookies,
  requireCsrf,
  requireRole,
};
