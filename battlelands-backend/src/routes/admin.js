'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { ok, fail } = require('../helpers/response');
const { db, redis } = require('../db');
const { randomUUID } = require('crypto');
const { implementedFunctions, executeCloudScript } = require('../services/cloudscript');
const {
  listLootTables, getLootTable, upsertLootTable, deleteLootTable,
  upsertLootItem, deleteLootItem,
  listEvents, getEvent, upsertEvent, deleteEvent,
} = require('../services/lootEvents');
const { enqueue, listJobs, getJob } = require('../services/queue');
const {
  getAnalyticsOverview, getRegistrationsByDay, getDAUByDay,
  getCSVolumeByHour, getTopCSFunctions, getCurrencyTxByDay,
  getTopEarners, getAuditActionBreakdown, getSessionsByHour,
} = require('../services/analytics');
const {
  authenticateAdmin,
  consumeRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokens,
  requireAdmin,
  requireCsrf,
  requireRole,
  parseCookies,
  signAccessToken,
  REFRESH_TTL_SECONDS,
  issueAuthCookies,
  generateCsrfToken,
  getAdminByEmail,
  hashPassword,
  generateTotpSecret,
  buildOtpAuthUri,
} = require('../services/adminSecurity');
const {
  getOverview,
  searchPlayers,
  getPlayerDetails,
  adjustCurrency,
  setBan,
  clearBan,
  wipePlayer,
  revokePlayerSessions,
  impersonatePlayer,
  addInventoryItem,
  removeInventoryItem,
  cloudscriptTest,
  getPlayerAuditLog,
  setPlayerUserData,
  deletePlayerUserData,
  cloudscriptHistory,
  cloudscriptStats,
  listSnapshots,
  takeSnapshot,
  restoreSnapshot,
  listFeatureFlags,
  setFeatureFlag,
  restartService,
  logAdminAction,
  adminSetStats,
  adminSetReadonlyData,
  deletePlayerReadonlyData,
  clonePlayer,
  getLeaderboardNames,
  getLeaderboard,
} = require('../services/adminOps');
const {
  refreshAppLocals,
  listCatalogItems,
  getCatalogItem,
  listItemClasses,
  upsertCatalogItem,
  deleteCatalogItem,
  listStoresSummary,
  getStore,
  upsertStore,
  deleteStore,
  upsertStoreItem,
  deleteStoreItem,
  listTitleDataEntries,
  setTitleDataKey,
  deleteTitleDataKey,
  listAssets,
  upsertAsset,
  deleteAsset,
} = require('../services/economy');
const { renderAdminUi } = require('../views/adminUi');

const router = express.Router();

const adminLoginLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  message: { code: 429, status: 'TooManyRequests', error: 'RateLimitExceeded', errorMessage: 'Too many admin login attempts.', errorDetails: {} },
});

function setCookies(res, cookies) {
  const values = Array.isArray(cookies) ? cookies.filter(Boolean) : [cookies].filter(Boolean);
  if (!values.length) return;
  for (const cookie of values) res.append('Set-Cookie', cookie);
}

function noStore(res) {
  res.set('Cache-Control', 'no-store');
}

function parseBodyObject(value) {
  return value && typeof value === 'object' ? value : {};
}

router.use('/api', requireAdmin, requireCsrf);

function escapeCsv(value) {
  if (value == null) return '';
  const str = String(value);
  if (/[",\n\r]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.map(escapeCsv).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCsv(row[h])).join(','));
  }
  return lines.join('\n');
}

function datasetShape(name, rows) {
  switch (name) {
    case 'players':
      return rows.map((row) => ({
        playfab_id: row.playfab_id,
        custom_id: row.custom_id,
        android_id: row.android_id,
        ios_id: row.ios_id,
        email: row.email,
        display_name: row.display_name,
        created_at: row.created_at,
        last_login: row.last_login,
        origination: row.origination,
        banned: row.banned,
        banned_until: row.banned_until,
        ban_reason: row.ban_reason,
        vc_ge: row.vc_ge,
        vc_bb: row.vc_bb,
        vc_dt: row.vc_dt,
        vc_bp: row.vc_bp,
      }));
    case 'audit':
      return rows.map((row) => ({
        ts: row.ts,
        admin_email: row.admin_email,
        action: row.action,
        target_type: row.target_type,
        target_id: row.target_id,
        before_state: row.before_state,
        after_state: row.after_state,
        metadata: row.metadata,
        ip_address: row.ip_address,
        user_agent: row.user_agent,
      }));
    case 'logs':
      return rows.map((row) => ({
        ts: row.ts,
        method: row.method,
        path: row.path,
        playfab_id: row.playfab_id,
        duration_ms: row.duration_ms,
        status_code: row.status_code,
        ip_address: row.ip_address,
      }));
    case 'catalog':
      return rows.map((row) => ({
        item_id: row.item_id,
        item_class: row.item_class,
        catalog_version: row.catalog_version,
        display_name: row.display_name,
        description: row.description,
        virtual_currency_prices: JSON.stringify(row.virtual_currency_prices),
        real_currency_prices: JSON.stringify(row.real_currency_prices),
        tags: JSON.stringify(row.tags),
        custom_data: row.custom_data,
        is_stackable: row.is_stackable,
        is_tradable: row.is_tradable,
        item_image_url: row.item_image_url,
      }));
    case 'titledata':
      return rows.map((row) => ({ key: row.key, value: row.value, updated_at: row.updated_at }));
    default:
      return rows;
  }
}

router.get('/', (req, res) => res.redirect('/Admin/ui'));
router.get('/dashboard', (req, res) => res.redirect('/Admin/ui'));
router.get('/ui', (req, res) => {
  noStore(res);
  return res.type('html').send(renderAdminUi({ functions: implementedFunctions, appName: process.env.APP_NAME || 'Game Backend' }));
});

router.post('/login', adminLoginLimiter, async (req, res) => {
  try {
    const { email, password, totp } = req.body || {};
    const result = await authenticateAdmin({ email, password, totp, ipAddress: req.ip });
    if (!result.ok) {
      await logAdminAction({
        adminEmail: String(email || '').trim().toLowerCase() || 'unknown',
        action: 'admin.login.failed',
        targetType: 'admin',
        targetId: String(email || '').trim().toLowerCase() || 'unknown',
        metadata: { reason: result.reason, lockedUntil: result.lockedUntil || null },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      }).catch(() => {});
      return res.status(401).json({ code: 401, status: 'Unauthorized', error: 'InvalidCredentials', errorMessage: result.reason, errorDetails: { lockedUntil: result.lockedUntil || null } });
    }
    setCookies(res, issueAuthCookies({ refreshToken: result.refreshToken, accessToken: result.accessToken, csrfToken: result.csrfToken || generateCsrfToken() }));
    await logAdminAction({
      adminEmail: result.admin.email,
      action: 'admin.login.success',
      targetType: 'admin',
      targetId: result.admin.email,
      metadata: { role: result.admin.role },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch(() => {});
    noStore(res);
    return res.json({
      code: 200,
      status: 'OK',
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      admin: result.admin,
      otpAuthUri: result.otpAuthUri,
      csrfToken: result.csrfToken || null,
    });
  } catch (error) {
    return res.status(500).json({ code: 500, status: 'InternalServerError', error: 'InternalServerError', errorMessage: error.message, errorDetails: {} });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const cookies = parseCookies(req);
    const token = cookies.admin_refresh || req.body?.refreshToken;
    if (!token) return res.status(401).json({ code: 401, status: 'Unauthorized', error: 'MissingRefreshToken', errorMessage: 'Refresh token required.', errorDetails: {} });
    const decoded = await consumeRefreshToken(token);
    const accessToken = signAccessToken({ email: decoded.email, role: decoded.role || 'superadmin' });
    const csrfToken = parseCookies(req).admin_csrf || generateCsrfToken();
    setCookies(res, issueAuthCookies({ refreshToken: token, accessToken, csrfToken }));
    noStore(res);
    return res.json({ code: 200, status: 'OK', accessToken, expiresIn: 3600, csrfToken });
  } catch (error) {
    return res.status(401).json({ code: 401, status: 'Unauthorized', error: 'InvalidRefreshToken', errorMessage: error.message, errorDetails: {} });
  }
});

router.post('/logout', requireCsrf, async (req, res) => {
  try {
    const cookies = parseCookies(req);
    const refresh = cookies.admin_refresh || req.body?.refreshToken;
    if (refresh) await revokeRefreshToken(refresh);
    res.append('Set-Cookie', `admin_refresh=; HttpOnly; Path=/Admin; SameSite=Strict; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    res.append('Set-Cookie', `admin_access=; HttpOnly; Path=/Admin; SameSite=Strict; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    res.append('Set-Cookie', `admin_csrf=; Path=/Admin; SameSite=Strict; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    noStore(res);
    return res.json({ code: 200, status: 'OK' });
  } catch (error) {
    return res.status(500).json({ code: 500, status: 'InternalServerError', error: 'InternalServerError', errorMessage: error.message, errorDetails: {} });
  }
});

router.get('/api/me', requireAdmin, (req, res) => {
  noStore(res);
  return ok(res, { admin: req.admin, functions: implementedFunctions });
});

router.get('/api/admins', requireAdmin, requireRole('superadmin'), async (req, res) => {
  noStore(res);
  const rows = await db.all('SELECT email, role, enabled, created_at, last_login, failed_attempts, locked_until FROM admin_users ORDER BY created_at DESC');
  return ok(res, { admins: rows });
});

router.post('/api/admins', requireAdmin, requireRole('superadmin'), async (req, res) => {
  try {
    const payload = parseBodyObject(req.body);
    const email = String(payload.email || '').trim().toLowerCase();
    if (!email) throw new Error('email is required');
    const role = ['moderator', 'admin', 'superadmin'].includes(String(payload.role || '').toLowerCase()) ? String(payload.role).toLowerCase() : 'admin';
    const enabled = payload.enabled !== false;
    const password = String(payload.password || '').trim();
    let totpSecret = String(payload.totpSecret || '').trim();
    const exists = await getAdminByEmail(email);
    if (!exists && !password) throw new Error('password is required for new admins');
    // Password complexity: min 12 chars, uppercase, lowercase, digit, special char
    if (password) {
      if (password.length < 12) throw new Error('Password must be at least 12 characters');
      if (!/[A-Z]/.test(password)) throw new Error('Password must contain at least one uppercase letter');
      if (!/[a-z]/.test(password)) throw new Error('Password must contain at least one lowercase letter');
      if (!/[0-9]/.test(password)) throw new Error('Password must contain at least one number');
      if (!/[^A-Za-z0-9]/.test(password)) throw new Error('Password must contain at least one special character (!@#$%^&* etc.)');
    }
    if (!totpSecret) totpSecret = generateTotpSecret();
    const passwordHash = password ? await hashPassword(password) : (exists ? exists.password_hash : null);
    if (!passwordHash) throw new Error('password is required');
    await db.query(
      `INSERT INTO admin_users (email, password_hash, totp_secret, role, enabled, created_at, last_login)
       VALUES ($1, $2, $3, $4, $5, NOW(), NULL)
       ON CONFLICT (email) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         totp_secret = EXCLUDED.totp_secret,
         role = EXCLUDED.role,
         enabled = EXCLUDED.enabled`,
      [email, passwordHash, totpSecret, role, enabled]
    );
    await logAdminAction({
      adminEmail: req.admin.email,
      action: exists ? 'admin.update' : 'admin.create',
      targetType: 'admin',
      targetId: email,
      afterState: { email, role, enabled },
      metadata: { otpAuthUri: buildOtpAuthUri(email, totpSecret) },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
    return ok(res, { email, role, enabled, otpAuthUri: buildOtpAuthUri(email, totpSecret) });
  } catch (error) {
    return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: error.message, errorDetails: {} });
  }
});

router.patch('/api/admins/:email', requireAdmin, requireRole('superadmin'), async (req, res) => {
  try {
    const email = String(req.params.email || '').trim().toLowerCase();
    const payload = parseBodyObject(req.body);
    const updates = [];
    const values = [];
    if (payload.role) { updates.push(`role = $${values.length + 1}`); values.push(String(payload.role).toLowerCase()); }
    if (payload.enabled !== undefined) { updates.push(`enabled = $${values.length + 1}`); values.push(Boolean(payload.enabled)); }
    if (payload.resetPassword) {
      const hash = await hashPassword(String(payload.resetPassword));
      updates.push(`password_hash = $${values.length + 1}`); values.push(hash);
    }
    if (payload.totpSecret) { updates.push(`totp_secret = $${values.length + 1}`); values.push(String(payload.totpSecret).trim()); }
    if (!updates.length) throw new Error('No updates provided');
    values.push(email);
    await db.query(`UPDATE admin_users SET ${updates.join(', ')} WHERE email = $${values.length}`, values);
    await logAdminAction({
      adminEmail: req.admin.email,
      action: 'admin.update',
      targetType: 'admin',
      targetId: email,
      afterState: payload,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
    return ok(res, { updated: true, email });
  } catch (error) {
    return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: error.message, errorDetails: {} });
  }
});

router.get('/api/admins/:email', requireAdmin, requireRole('superadmin'), async (req, res) => {
  noStore(res);
  const admin = await getAdminByEmail(String(req.params.email || '').trim().toLowerCase());
  if (!admin) return res.status(404).json({ code: 404, status: 'NotFound', error: 'AdminNotFound', errorMessage: 'Admin not found.', errorDetails: {} });
  return ok(res, { admin: { email: admin.email, role: admin.role, enabled: admin.enabled, created_at: admin.created_at, last_login: admin.last_login, failed_attempts: admin.failed_attempts, locked_until: admin.locked_until } });
});

router.get('/api/overview', requireAdmin, async (req, res) => {
  noStore(res);
  const overview = await getOverview();
  overview.websocketClients = req.app.locals.wsClients ? req.app.locals.wsClients.size : 0;
  return ok(res, overview);
});

router.get('/api/players', requireAdmin, async (req, res) => {
  noStore(res);
  const { rows, page, total, pages } = await searchPlayers({ search: req.query.search || '', page: req.query.page || 1, limit: req.query.limit || 25 });
  return ok(res, { rows, page, total, pages });
});

router.get('/api/player/:id', requireAdmin, async (req, res) => {
  noStore(res);
  const details = await getPlayerDetails(req.params.id);
  if (!details.player) return res.status(404).json({ code: 404, status: 'NotFound', error: 'PlayerNotFound', errorMessage: 'Player not found.', errorDetails: {} });
  return ok(res, details);
});

router.post('/api/player/:id/currency', requireAdmin, requireRole('superadmin'), async (req, res) => {
  try {
    const result = await adjustCurrency({
      playFabId: req.params.id,
      currency: req.body?.currency,
      amount: req.body?.amount,
      reason: req.body?.reason,
      adminEmail: req.admin.email,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
    // Log to analytics currency_tx (fire-and-forget)
    const { logCurrencyTx } = require('../services/analytics');
    const cols = { GE: 'vc_ge', BB: 'vc_bb', DT: 'vc_dt', BP: 'vc_bp' };
    const col = cols[req.body?.currency];
    if (col) {
      db.one(`SELECT ${col} AS bal FROM players WHERE playfab_id=$1`, [req.params.id])
        .then(row => logCurrencyTx({ playFabId: req.params.id, currency: req.body.currency, delta: Number(req.body.amount || 0), balanceAfter: row?.bal, source: 'admin', reason: req.body?.reason || '' }))
        .catch(() => {});
    }
    return ok(res, result);
  } catch (error) {
    return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: error.message, errorDetails: {} });
  }
});

router.post('/api/player/:id/ban', requireAdmin, requireRole('superadmin'), async (req, res) => {
  try {
    const result = await setBan({
      playFabId: req.params.id,
      ipAddress: req.body?.ipAddress || null,
      deviceId: req.body?.deviceId || null,
      reason: req.body?.reason || '',
      durationMinutes: req.body?.durationMinutes ?? null,
      adminEmail: req.admin.email,
      actorIp: req.ip,
      userAgent: req.get('user-agent'),
    });
    return ok(res, result);
  } catch (error) {
    return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: error.message, errorDetails: {} });
  }
});

router.post('/api/player/:id/unban', requireAdmin, requireRole('superadmin'), async (req, res) => {
  try {
    return ok(res, await clearBan({ playFabId: req.params.id, adminEmail: req.admin.email, actorIp: req.ip, userAgent: req.get('user-agent') }));
  } catch (error) {
    return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: error.message, errorDetails: {} });
  }
});

router.post('/api/player/:id/wipe', requireAdmin, requireRole('superadmin'), async (req, res) => {
  try {
    return ok(res, await wipePlayer({ playFabId: req.params.id, catalog: req.app.locals.catalog, adminEmail: req.admin.email, actorIp: req.ip, userAgent: req.get('user-agent') }));
  } catch (error) {
    return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: error.message, errorDetails: {} });
  }
});

router.post('/api/player/:id/sessions/revoke', requireAdmin, requireRole('superadmin'), async (req, res) => {
  try {
    return ok(res, await revokePlayerSessions(req.params.id, req.admin.email, req.ip, req.get('user-agent')));
  } catch (error) {
    return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: error.message, errorDetails: {} });
  }
});

router.post('/api/player/:id/impersonate', requireAdmin, requireRole('superadmin'), async (req, res) => {
  try {
    return ok(res, await impersonatePlayer(req.params.id, req.admin.email, req.ip, req.get('user-agent')));
  } catch (error) {
    return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: error.message, errorDetails: {} });
  }
});

router.post('/api/player/:id/inventory', requireAdmin, requireRole('superadmin'), async (req, res) => {
  try {
    const payload = parseBodyObject(req.body);
    if (payload.action === 'remove') {
      if (!payload.instanceId) throw new Error('instanceId is required for remove');
      return ok(res, await removeInventoryItem({ playFabId: req.params.id, instanceId: payload.instanceId, adminEmail: req.admin.email, actorIp: req.ip, userAgent: req.get('user-agent') }));
    }
    if (!payload.itemId) throw new Error('itemId is required');
    const row = await addInventoryItem({
      playFabId: req.params.id,
      itemId: payload.itemId,
      itemClass: payload.itemClass || null,
      catalogVersion: payload.catalogVersion || '1',
      displayName: payload.displayName || payload.itemId,
      unitPrice: payload.unitPrice || 0,
      remainingUses: payload.remainingUses ?? null,
      customData: payload.customData || {},
      adminEmail: req.admin.email,
      actorIp: req.ip,
      userAgent: req.get('user-agent'),
    });
    return ok(res, { item: row });
  } catch (error) {
    return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: error.message, errorDetails: {} });
  }
});

router.post('/api/bulk/currency', requireAdmin, requireRole('superadmin'), async (req, res) => {
  try {
    const payload = parseBodyObject(req.body);
    const ids = Array.isArray(payload.playFabIds) ? payload.playFabIds.map((id) => String(id).trim()).filter(Boolean) : [];
    if (!ids.length) throw new Error('playFabIds is required');
    const results = [];
    for (const id of ids) {
      results.push(await adjustCurrency({
        playFabId: id,
        currency: payload.currency,
        amount: payload.amount,
        reason: payload.reason,
        adminEmail: req.admin.email,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      }));
    }
    return ok(res, { updated: results.length, results });
  } catch (error) {
    return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: error.message, errorDetails: {} });
  }
});

router.post('/api/bulk/inventory', requireAdmin, requireRole('superadmin'), async (req, res) => {
  try {
    const payload = parseBodyObject(req.body);
    const ids = Array.isArray(payload.playFabIds) ? payload.playFabIds.map((id) => String(id).trim()).filter(Boolean) : [];
    if (!ids.length) throw new Error('playFabIds is required');
    if (!payload.itemId) throw new Error('itemId is required');
    const items = [];
    for (const id of ids) {
      items.push(await addInventoryItem({
        playFabId: id,
        itemId: payload.itemId,
        itemClass: payload.itemClass || null,
        catalogVersion: payload.catalogVersion || '1',
        displayName: payload.displayName || payload.itemId,
        unitPrice: payload.unitPrice || 0,
        remainingUses: payload.remainingUses ?? null,
        customData: payload.customData || {},
        adminEmail: req.admin.email,
        actorIp: req.ip,
        userAgent: req.get('user-agent'),
      }));
    }
    return ok(res, { created: items.length, items });
  } catch (error) {
    return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: error.message, errorDetails: {} });
  }
});

// Analytics

router.get('/api/analytics/overview', requireAdmin, async (req, res) => {
  noStore(res);
  try { return ok(res, await getAnalyticsOverview()); }
  catch (e) { return res.status(500).json({ code: 500, status: 'InternalServerError', error: 'InternalServerError', errorMessage: e.message, errorDetails: {} }); }
});

router.get('/api/analytics/registrations', requireAdmin, async (req, res) => {
  noStore(res);
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  try { return ok(res, { rows: await getRegistrationsByDay(days), days }); }
  catch (e) { return res.status(500).json({ code: 500, status: 'InternalServerError', error: 'InternalServerError', errorMessage: e.message, errorDetails: {} }); }
});

router.get('/api/analytics/dau', requireAdmin, async (req, res) => {
  noStore(res);
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  try { return ok(res, { rows: await getDAUByDay(days), days }); }
  catch (e) { return res.status(500).json({ code: 500, status: 'InternalServerError', error: 'InternalServerError', errorMessage: e.message, errorDetails: {} }); }
});

router.get('/api/analytics/cloudscript', requireAdmin, async (req, res) => {
  noStore(res);
  try {
    const [volume, topFns] = await Promise.all([getCSVolumeByHour(), getTopCSFunctions(10)]);
    return ok(res, { volume, topFunctions: topFns });
  } catch (e) { return res.status(500).json({ code: 500, status: 'InternalServerError', error: 'InternalServerError', errorMessage: e.message, errorDetails: {} }); }
});

router.get('/api/analytics/currency', requireAdmin, async (req, res) => {
  noStore(res);
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
  const currency = ['GE','BB','DT','BP'].includes(req.query.currency) ? req.query.currency : null;
  try {
    const [txByDay, earners] = await Promise.all([
      getCurrencyTxByDay(days),
      getTopEarners(currency || 'GE', 20),
    ]);
    return ok(res, { txByDay: currency ? txByDay.filter(r => r.currency === currency) : txByDay, topEarners: earners, days });
  } catch (e) { return res.status(500).json({ code: 500, status: 'InternalServerError', error: 'InternalServerError', errorMessage: e.message, errorDetails: {} }); }
});

router.get('/api/analytics/sessions', requireAdmin, async (req, res) => {
  noStore(res);
  try {
    const [sessions, auditBreakdown] = await Promise.all([getSessionsByHour(), getAuditActionBreakdown()]);
    return ok(res, { sessions, auditBreakdown });
  } catch (e) { return res.status(500).json({ code: 500, status: 'InternalServerError', error: 'InternalServerError', errorMessage: e.message, errorDetails: {} }); }
});

// Jobs

router.get('/api/jobs', requireAdmin, async (req, res) => {
  noStore(res);
  const status = req.query.status || null;
  const rows = await listJobs({ limit: Number(req.query.limit) || 50, status });
  return ok(res, { rows });
});

router.get('/api/jobs/:jobId', requireAdmin, async (req, res) => {
  noStore(res);
  const job = await getJob(req.params.jobId);
  if (!job) return res.status(404).json({ code: 404, status: 'NotFound', error: 'JobNotFound', errorMessage: 'Job not found', errorDetails: {} });
  return ok(res, job);
});

// Loot Tables

router.get('/api/loot', requireAdmin, async (req, res) => {
  noStore(res);
  return ok(res, { tables: await listLootTables() });
});

router.get('/api/loot/:tableKey', requireAdmin, async (req, res) => {
  noStore(res);
  const t = await getLootTable(req.params.tableKey);
  if (!t) return res.status(404).json({ code: 404, status: 'NotFound', error: 'NotFound', errorMessage: 'Loot table not found', errorDetails: {} });
  return ok(res, t);
});

router.post('/api/loot', requireAdmin, requireRole('admin'), async (req, res) => {
  try {
    const p = parseBodyObject(req.body);
    const t = await upsertLootTable(p, { adminEmail: req.admin.email, actorIp: req.ip, userAgent: req.get('user-agent') });
    return ok(res, t);
  } catch (e) { return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: e.message, errorDetails: {} }); }
});

router.delete('/api/loot/:tableKey', requireAdmin, requireRole('admin'), async (req, res) => {
  try {
    return ok(res, await deleteLootTable(req.params.tableKey, { adminEmail: req.admin.email, actorIp: req.ip, userAgent: req.get('user-agent') }));
  } catch (e) { return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: e.message, errorDetails: {} }); }
});

router.post('/api/loot/:tableKey/items', requireAdmin, requireRole('admin'), async (req, res) => {
  try {
    const p = parseBodyObject(req.body);
    const t = await upsertLootItem({ tableKey: req.params.tableKey, ...p }, { adminEmail: req.admin.email, actorIp: req.ip, userAgent: req.get('user-agent') });
    return ok(res, t);
  } catch (e) { return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: e.message, errorDetails: {} }); }
});

router.delete('/api/loot/:tableKey/items/:itemId', requireAdmin, requireRole('admin'), async (req, res) => {
  try {
    return ok(res, await deleteLootItem(req.params.tableKey, req.params.itemId, { adminEmail: req.admin.email, actorIp: req.ip, userAgent: req.get('user-agent') }));
  } catch (e) { return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: e.message, errorDetails: {} }); }
});

// Economy Events

router.get('/api/events', requireAdmin, async (req, res) => {
  noStore(res);
  return ok(res, { events: await listEvents({ activeOnly: req.query.active === 'true' }) });
});

router.get('/api/events/:eventKey', requireAdmin, async (req, res) => {
  noStore(res);
  const ev = await getEvent(req.params.eventKey);
  if (!ev) return res.status(404).json({ code: 404, status: 'NotFound', error: 'NotFound', errorMessage: 'Event not found', errorDetails: {} });
  return ok(res, ev);
});

router.post('/api/events', requireAdmin, requireRole('admin'), async (req, res) => {
  try {
    const p = parseBodyObject(req.body);
    let payload = p.payload;
    if (typeof payload === 'string') try { payload = JSON.parse(payload); } catch { payload = {}; }
    const ev = await upsertEvent({ ...p, payload: payload || {} }, { adminEmail: req.admin.email, actorIp: req.ip, userAgent: req.get('user-agent') });
    return ok(res, ev);
  } catch (e) { return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: e.message, errorDetails: {} }); }
});

router.delete('/api/events/:eventKey', requireAdmin, requireRole('admin'), async (req, res) => {
  try {
    return ok(res, await deleteEvent(req.params.eventKey, { adminEmail: req.admin.email, actorIp: req.ip, userAgent: req.get('user-agent') }));
  } catch (e) { return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: e.message, errorDetails: {} }); }
});

router.get('/api/player/:id/audit', requireAdmin, async (req, res) => {
  noStore(res);
  try {
    const rows = await getPlayerAuditLog(req.params.id, req.query.limit);
    return ok(res, { rows });
  } catch (err) {
    return res.status(500).json({ code: 500, status: 'InternalServerError', error: 'InternalServerError', errorMessage: err.message, errorDetails: {} });
  }
});

router.post('/api/player/:id/userdata', requireAdmin, requireRole('admin'), async (req, res) => {
  try {
    const { key, value, permission } = req.body || {};
    const result = await setPlayerUserData(
      req.params.id, key, value, permission || 'Public',
      req.admin.email, req.ip, req.get('user-agent')
    );
    return ok(res, result);
  } catch (err) {
    return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: err.message, errorDetails: {} });
  }
});

router.delete('/api/player/:id/userdata/:key', requireAdmin, requireRole('admin'), async (req, res) => {
  try {
    const result = await deletePlayerUserData(
      req.params.id, req.params.key,
      req.admin.email, req.ip, req.get('user-agent')
    );
    return ok(res, result);
  } catch (err) {
    return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: err.message, errorDetails: {} });
  }
});

// Player Statistics (admin set)
router.post('/api/player/:id/stats', requireAdmin, requireRole('admin'), async (req, res) => {
  try {
    const { statisticName, value } = parseBodyObject(req.body);
    return ok(res, await adminSetStats(req.params.id, statisticName, value, req.admin.email, req.ip, req.get('user-agent')));
  } catch (error) {
    return res.status(400).json({ code:400, status:'BadRequest', error:'InvalidRequest', errorMessage:error.message, errorDetails:{} });
  }
});

// Player ReadOnly Data (admin set / delete)
router.post('/api/player/:id/readonlydata', requireAdmin, requireRole('admin'), async (req, res) => {
  try {
    const { key, value } = parseBodyObject(req.body);
    return ok(res, await adminSetReadonlyData(req.params.id, key, value, req.admin.email, req.ip, req.get('user-agent')));
  } catch (error) {
    return res.status(400).json({ code:400, status:'BadRequest', error:'InvalidRequest', errorMessage:error.message, errorDetails:{} });
  }
});

router.delete('/api/player/:id/readonlydata/:key', requireAdmin, requireRole('admin'), async (req, res) => {
  try {
    return ok(res, await deletePlayerReadonlyData(req.params.id, req.params.key, req.admin.email, req.ip, req.get('user-agent')));
  } catch (error) {
    return res.status(400).json({ code:400, status:'BadRequest', error:'InvalidRequest', errorMessage:error.message, errorDetails:{} });
  }
});

// Player Clone
router.post('/api/player/:id/clone', requireAdmin, requireRole('superadmin'), async (req, res) => {
  try {
    const { displayName = '' } = parseBodyObject(req.body);
    return ok(res, await clonePlayer({ sourceId:req.params.id, newDisplayName:displayName, adminEmail:req.admin.email, actorIp:req.ip, userAgent:req.get('user-agent') }));
  } catch (error) {
    return res.status(400).json({ code:400, status:'BadRequest', error:'InvalidRequest', errorMessage:error.message, errorDetails:{} });
  }
});

// Leaderboards
router.get('/api/leaderboards', requireAdmin, async (req, res) => {
  noStore(res);
  return ok(res, { names: await getLeaderboardNames() });
});

router.get('/api/leaderboard/:name', requireAdmin, async (req, res) => {
  noStore(res);
  return ok(res, {
    name: req.params.name,
    rows: await getLeaderboard({ name:req.params.name, limit:req.query.limit, offset:req.query.offset }),
  });
});

// CloudScript
router.post('/api/cloudscript/test', requireAdmin, requireRole('admin'), async (req, res) => {
  try {
    const payload = parseBodyObject(req.body);
    const result = await cloudscriptTest({
      functionName: payload.FunctionName,
      functionParameter: payload.FunctionParameter || {},
      playFabId: payload.PlayFabId || req.params.id || null,
      app: req.app,
      adminEmail: req.admin.email,
      actorIp: req.ip,
      userAgent: req.get('user-agent'),
      executeCloudScript,
    });
    return ok(res, result);
  } catch (error) {
    return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: error.message, errorDetails: {} });
  }
});

router.get('/api/cloudscript/history', requireAdmin, async (req, res) => {
  noStore(res);
  const rows = await cloudscriptHistory({ limit: req.query.limit, functionName: req.query.function || null });
  return ok(res, { rows });
});

router.get('/api/cloudscript/stats', requireAdmin, async (req, res) => {
  noStore(res);
  const rows = await cloudscriptStats();
  return ok(res, { rows });
});

// Catalog

router.get('/api/catalog', requireAdmin, async (req, res) => {
  noStore(res);
  const { rows, total } = await listCatalogItems({
    search: req.query.search || '',
    itemClass: req.query.itemClass || '',
    limit: Math.max(Math.min(Number(req.query.limit) || 50, 200), 1),
    offset: Math.max(Number(req.query.offset) || 0, 0),
  });
  return ok(res, { rows, total });
});

router.get('/api/catalog/classes', requireAdmin, async (req, res) => {
  noStore(res);
  return ok(res, { classes: await listItemClasses() });
});

router.get('/api/catalog/:itemId', requireAdmin, async (req, res) => {
  noStore(res);
  const item = await getCatalogItem(req.params.itemId);
  if (!item) return res.status(404).json({ code: 404, status: 'NotFound', error: 'ItemNotFound', errorMessage: 'Catalog item not found.', errorDetails: {} });
  return ok(res, item);
});

router.post('/api/catalog', requireAdmin, requireRole('admin'), async (req, res) => {
  try {
    const item = await upsertCatalogItem(parseBodyObject(req.body), { adminEmail: req.admin.email, actorIp: req.ip, userAgent: req.get('user-agent') });
    await refreshAppLocals(req.app);
    return ok(res, item);
  } catch (error) {
    return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: error.message, errorDetails: {} });
  }
});

router.delete('/api/catalog/:itemId', requireAdmin, requireRole('admin'), async (req, res) => {
  try {
    const result = await deleteCatalogItem(req.params.itemId, { adminEmail: req.admin.email, actorIp: req.ip, userAgent: req.get('user-agent') });
    await refreshAppLocals(req.app);
    return ok(res, result);
  } catch (error) {
    return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: error.message, errorDetails: {} });
  }
});

// Stores & bundles

router.get('/api/stores', requireAdmin, async (req, res) => {
  noStore(res);
  return ok(res, { stores: await listStoresSummary() });
});

router.get('/api/stores/:storeId', requireAdmin, async (req, res) => {
  noStore(res);
  const store = await getStore(req.params.storeId);
  if (!store) return res.status(404).json({ code: 404, status: 'NotFound', error: 'StoreNotFound', errorMessage: 'Store not found.', errorDetails: {} });
  return ok(res, store);
});

router.post('/api/stores', requireAdmin, requireRole('admin'), async (req, res) => {
  try {
    const payload = parseBodyObject(req.body);
    const store = await upsertStore({ storeId: payload.storeId, displayName: payload.displayName }, { adminEmail: req.admin.email, actorIp: req.ip, userAgent: req.get('user-agent') });
    await refreshAppLocals(req.app);
    return ok(res, store);
  } catch (error) {
    return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: error.message, errorDetails: {} });
  }
});

router.delete('/api/stores/:storeId', requireAdmin, requireRole('admin'), async (req, res) => {
  try {
    const result = await deleteStore(req.params.storeId, { adminEmail: req.admin.email, actorIp: req.ip, userAgent: req.get('user-agent') });
    await refreshAppLocals(req.app);
    return ok(res, result);
  } catch (error) {
    return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: error.message, errorDetails: {} });
  }
});

router.post('/api/stores/:storeId/items', requireAdmin, requireRole('admin'), async (req, res) => {
  try {
    const payload = parseBodyObject(req.body);
    const store = await upsertStoreItem({
      storeId: req.params.storeId,
      itemId: payload.itemId,
      virtualCurrencyPrices: payload.virtualCurrencyPrices,
      realCurrencyPrices: payload.realCurrencyPrices,
      customData: payload.customData,
      sortOrder: payload.sortOrder,
    }, { adminEmail: req.admin.email, actorIp: req.ip, userAgent: req.get('user-agent') });
    await refreshAppLocals(req.app);
    return ok(res, store);
  } catch (error) {
    return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: error.message, errorDetails: {} });
  }
});

router.delete('/api/stores/:storeId/items/:itemId', requireAdmin, requireRole('admin'), async (req, res) => {
  try {
    const store = await deleteStoreItem(req.params.storeId, req.params.itemId, { adminEmail: req.admin.email, actorIp: req.ip, userAgent: req.get('user-agent') });
    await refreshAppLocals(req.app);
    return ok(res, store);
  } catch (error) {
    return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: error.message, errorDetails: {} });
  }
});

// Title Data

router.get('/api/title-data', requireAdmin, async (req, res) => {
  noStore(res);
  return ok(res, { rows: await listTitleDataEntries() });
});

router.post('/api/title-data', requireAdmin, requireRole('admin'), async (req, res) => {
  try {
    const payload = parseBodyObject(req.body);
    const result = await setTitleDataKey({ key: payload.key, value: payload.value }, { adminEmail: req.admin.email, actorIp: req.ip, userAgent: req.get('user-agent') });
    await refreshAppLocals(req.app);
    return ok(res, result);
  } catch (error) {
    return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: error.message, errorDetails: {} });
  }
});

router.delete('/api/title-data/:key', requireAdmin, requireRole('admin'), async (req, res) => {
  try {
    const result = await deleteTitleDataKey(req.params.key, { adminEmail: req.admin.email, actorIp: req.ip, userAgent: req.get('user-agent') });
    await refreshAppLocals(req.app);
    return ok(res, result);
  } catch (error) {
    return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: error.message, errorDetails: {} });
  }
});

// Asset bundles

router.get('/api/assets', requireAdmin, async (req, res) => {
  noStore(res);
  return ok(res, { rows: await listAssets({ itemId: req.query.itemId || '', activeOnly: req.query.activeOnly === 'true' }) });
});

router.post('/api/assets', requireAdmin, requireRole('admin'), async (req, res) => {
  try {
    const asset = await upsertAsset(parseBodyObject(req.body), { adminEmail: req.admin.email, actorIp: req.ip, userAgent: req.get('user-agent') });
    return ok(res, asset);
  } catch (error) {
    return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: error.message, errorDetails: {} });
  }
});

router.delete('/api/assets/:bundleKey', requireAdmin, requireRole('admin'), async (req, res) => {
  try {
    const result = await deleteAsset(req.params.bundleKey, { adminEmail: req.admin.email, actorIp: req.ip, userAgent: req.get('user-agent') });
    return ok(res, result);
  } catch (error) {
    return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: error.message, errorDetails: {} });
  }
});

router.get('/api/audit', requireAdmin, async (req, res) => {
  noStore(res);
  const limit = Math.max(Math.min(Number(req.query.limit) || 100, 500), 1);
  const rows = await db.all('SELECT * FROM audit_log ORDER BY ts DESC LIMIT $1', [limit]);
  return ok(res, { rows });
});

router.get('/api/logs', requireAdmin, async (req, res) => {
  noStore(res);
  const limit = Math.max(Math.min(Number(req.query.limit) || 100, 500), 1);
  const logs = await db.all('SELECT * FROM requests_log ORDER BY ts DESC LIMIT $1', [limit]);
  return ok(res, { logs });
});

router.get('/api/backups', requireAdmin, async (req, res) => {
  noStore(res);
  return ok(res, { snapshots: await listSnapshots() });
});

router.post('/api/backup', requireAdmin, requireRole('superadmin'), async (req, res) => {
  try {
    const payload = parseBodyObject(req.body);
    const snapshot = await takeSnapshot({ label: payload.label || 'manual', adminEmail: req.admin.email, actorIp: req.ip, userAgent: req.get('user-agent') });
    return ok(res, snapshot);
  } catch (error) {
    return res.status(500).json({ code: 500, status: 'InternalServerError', error: 'BackupFailed', errorMessage: error.message, errorDetails: {} });
  }
});

router.post('/api/restore', requireAdmin, requireRole('superadmin'), async (req, res) => {
  try {
    const payload = parseBodyObject(req.body);
    if (!payload.name) throw new Error('snapshot name required');
    return ok(res, await restoreSnapshot({ name: payload.name, adminEmail: req.admin.email, actorIp: req.ip, userAgent: req.get('user-agent') }));
  } catch (error) {
    return res.status(400).json({ code: 400, status: 'BadRequest', error: 'RestoreFailed', errorMessage: error.message, errorDetails: {} });
  }
});

router.post('/api/restart', requireAdmin, requireRole('superadmin'), async (req, res) => {
  try {
    const result = await restartService({ adminEmail: req.admin.email, actorIp: req.ip, userAgent: req.get('user-agent') });
    res.json({ code: 200, status: 'OK', ...result });
    setTimeout(() => process.exit(0), 1000);
  } catch (error) {
    return res.status(500).json({ code: 500, status: 'InternalServerError', error: 'RestartFailed', errorMessage: error.message, errorDetails: {} });
  }
});


router.get('/api/flags', requireAdmin, requireRole('admin'), async (req, res) => {
  noStore(res);
  return ok(res, { flags: await listFeatureFlags() });
});

router.post('/api/flags', requireAdmin, requireRole('superadmin'), async (req, res) => {
  try {
    const payload = parseBodyObject(req.body);
    const result = await setFeatureFlag({
      key: payload.key,
      value: payload.value,
      description: payload.description || null,
      adminEmail: req.admin.email,
      actorIp: req.ip,
      userAgent: req.get('user-agent'),
    });
    return ok(res, result);
  } catch (error) {
    return res.status(400).json({ code: 400, status: 'BadRequest', error: 'InvalidRequest', errorMessage: error.message, errorDetails: {} });
  }
});

router.get('/api/notifications', requireAdmin, async (req, res) => {
  noStore(res);
  const limit = Math.max(Math.min(Number(req.query.limit) || 25, 100), 1);
  const [audit, bans] = await Promise.all([
    db.all('SELECT ts, admin_email, action, target_type, target_id FROM audit_log ORDER BY ts DESC LIMIT $1', [limit]),
    db.all('SELECT created_at AS ts, reason, playfab_id, ip_address, device_id FROM admin_bans WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT $1', [limit]),
  ]);
  return ok(res, {
    items: [
      ...audit.map((row) => ({
        type: 'audit',
        timestamp: row.ts,
        title: row.action,
        body: `${row.admin_email} -> ${row.target_type || 'item'} ${row.target_id || ''}`.trim(),
      })),
      ...bans.map((row) => ({
        type: 'ban',
        timestamp: row.ts,
        title: 'Active ban',
        body: `${row.playfab_id || 'n/a'} ${row.reason || ''}`.trim(),
      })),
    ].slice(0, limit),
  });
});

router.get('/api/export/:dataset', requireAdmin, async (req, res) => {
  noStore(res);
  const dataset = String(req.params.dataset || '').toLowerCase();
  const format = String(req.query.format || 'json').toLowerCase();
  let rows = [];
  if (dataset === 'players') rows = await db.all('SELECT * FROM players ORDER BY last_login DESC');
  else if (dataset === 'audit') rows = await db.all('SELECT * FROM audit_log ORDER BY ts DESC');
  else if (dataset === 'logs') rows = await db.all('SELECT * FROM requests_log ORDER BY ts DESC');
  else if (dataset === 'catalog') rows = await db.all('SELECT * FROM catalog_items ORDER BY item_id');
  else if (dataset === 'titledata') rows = await db.all('SELECT * FROM title_data ORDER BY key');
  else return res.status(404).json({ code: 404, status: 'NotFound', error: 'DatasetNotFound', errorMessage: 'Unknown export dataset.', errorDetails: {} });
  const data = datasetShape(dataset, rows);
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${dataset}.csv"`);
    return res.send(toCsv(data));
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${dataset}.json"`);
  return res.send(JSON.stringify(data, null, 2));
});

router.post('/api/import/:dataset', requireAdmin, requireRole('superadmin'), async (req, res) => {
  try {
    const dataset = String(req.params.dataset || '').toLowerCase();
    const payload = parseBodyObject(req.body);
    const items = Array.isArray(payload.items) ? payload.items : [];
    let count = 0;
    if (dataset === 'catalog') {
      for (const item of items) {
        await upsertCatalogItem(item, { adminEmail: req.admin.email, actorIp: req.ip, userAgent: req.get('user-agent') });
        count++;
      }
      await refreshAppLocals(req.app);
    } else if (dataset === 'titledata') {
      for (const item of items) {
        await setTitleDataKey({ key: item.key, value: item.value }, { adminEmail: req.admin.email, actorIp: req.ip, userAgent: req.get('user-agent') });
        count++;
      }
      await refreshAppLocals(req.app);
    } else {
      return res.status(404).json({ code: 404, status: 'NotFound', error: 'DatasetNotFound', errorMessage: 'Import supports catalog and titledata datasets.', errorDetails: {} });
    }
    return ok(res, { imported: count });
  } catch (error) {
    return res.status(400).json({ code: 400, status: 'BadRequest', error: 'ImportFailed', errorMessage: error.message, errorDetails: {} });
  }
});

router.get('/api/openapi.json', requireAdmin, (req, res) => {
  noStore(res);
  return res.json({
    openapi: '3.0.3',
    info: { title: `${process.env.APP_NAME || 'Game Backend'} Admin API`, version: '1.0.0' },
    paths: {
      '/Admin/login': { post: { summary: 'Admin login' } },
      '/Admin/refresh': { post: { summary: 'Refresh access token' } },
      '/Admin/logout': { post: { summary: 'Logout admin' } },
      '/Admin/api/overview': { get: { summary: 'Dashboard metrics' } },
      '/Admin/api/players': { get: { summary: 'Search players' } },
      '/Admin/api/player/{id}': { get: { summary: 'Player details' } },
      '/Admin/api/cloudscript/test': { post: { summary: 'Test CloudScript function' } },
      '/Admin/api/cloudscript/history': { get: { summary: 'Recent CloudScript calls (client + admin console)' } },
      '/Admin/api/cloudscript/stats': { get: { summary: 'Per-function call count, success rate, avg duration' } },
      '/Admin/api/catalog': { get: { summary: 'Search/list catalog items' }, post: { summary: 'Create or update a catalog item (incl. Bundles via BundleContents)' } },
      '/Admin/api/catalog/{itemId}': { get: { summary: 'Get one catalog item' }, delete: { summary: 'Delete a catalog item' } },
      '/Admin/api/catalog/classes': { get: { summary: 'Distinct ItemClass values in use' } },
      '/Admin/api/stores': { get: { summary: 'List stores with item counts' }, post: { summary: 'Create or rename a store' } },
      '/Admin/api/stores/{storeId}': { get: { summary: 'Store with its items' }, delete: { summary: 'Delete a store' } },
      '/Admin/api/stores/{storeId}/items': { post: { summary: 'Add/update an item in a store' } },
      '/Admin/api/stores/{storeId}/items/{itemId}': { delete: { summary: 'Remove an item from a store' } },
      '/Admin/api/title-data': { get: { summary: 'List all Title Data keys' }, post: { summary: 'Set a Title Data key' } },
      '/Admin/api/title-data/{key}': { delete: { summary: 'Delete a Title Data key' } },
      '/Admin/api/assets': { get: { summary: 'List asset bundle references' }, post: { summary: 'Create or update an asset bundle (CDN URL, version, platform, linked item)' } },
      '/Admin/api/assets/{bundleKey}': { delete: { summary: 'Delete an asset bundle reference' } },
      '/Admin/api/import/{dataset}': { post: { summary: 'Bulk import catalog or titledata from JSON' } },
      '/Admin/api/backups': { get: { summary: 'List snapshots' } },
      '/Admin/api/backup': { post: { summary: 'Create snapshot' } },
      '/Admin/api/restore': { post: { summary: 'Restore snapshot' } },
      '/Admin/api/notifications': { get: { summary: 'Latest admin notifications' } },
      '/Admin/api/flags': { get: { summary: 'List feature flags' }, post: { summary: 'Set feature flag' } },
      '/Admin/api/export/{dataset}': { get: { summary: 'Export players, audit, logs, catalog, or titledata as CSV/JSON' } },
    }
  });
});

router.get('/api/functions', requireAdmin, (req, res) => ok(res, { functions: implementedFunctions }));

// GET /Admin/api/status
// Admin-only: full server info (replaces the old public / endpoint).
router.get('/api/status', requireAdmin, async (req, res) => {
  const { implementedFunctions } = require('../services/cloudscript');
  const dbOk    = await db.query('SELECT 1').then(() => true).catch(() => false);
  const redisOk = await redis.ping().then(() => true).catch(() => false);
  return ok(res, {
    service:     'game-backend',
    titleId:     req.app.locals.titleId,
    db:          dbOk ? 'connected' : 'error',
    redis:       redisOk ? 'connected' : 'error',
    uptime:      process.uptime(),
    cloudScript: { implemented: implementedFunctions.length, functions: implementedFunctions },
    timestamp:   new Date().toISOString(),
  });
});

module.exports = router;
