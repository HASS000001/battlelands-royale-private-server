'use strict';

const fs = require('fs/promises');
const path = require('path');
const { randomUUID, createHash } = require('crypto');
const { db, redis } = require('../db');
const { initializeNewPlayer } = require('./player');
const { createSession } = require('./auth');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(process.cwd(), 'backups');
const SNAPSHOT_TABLES = [
  'players',
  'sessions',
  'inventory',
  'user_data',
  'user_readonly_data',
  'player_statistics',
  'leaderboard_entries',
  'player_friends',
  'admin_users',
  'admin_refresh_tokens',
  'admin_bans',
  'audit_log',
  'catalog_items',
  'stores',
  'store_items',
  'title_data',
  'asset_bundles',
  'feature_flags'
];

function snapshotSha256(raw) {
  return createHash('sha256').update(raw).digest('hex');
}

async function writeSnapshotManifest(file, raw) {
  const hash = snapshotSha256(raw);
  await fs.writeFile(`${file}.sha256`, `${hash}  ${path.basename(file)}
`);
  return hash;
}

async function readSnapshotManifest(file) {
  const manifest = await fs.readFile(`${file}.sha256`, 'utf8').catch(() => null);
  if (!manifest) return null;
  const [hash] = manifest.trim().split(/\s+/);
  return hash || null;
}

async function verifySnapshot(file) {
  const raw = await fs.readFile(file, 'utf8');
  const actual = snapshotSha256(raw);
  const expected = await readSnapshotManifest(file);
  if (expected && expected !== actual) {
    throw new Error('Snapshot integrity check failed (SHA256 mismatch).');
  }
  return { raw, actual, expected };
}

async function logAdminAction({ adminEmail, action, targetType = null, targetId = null, beforeState = null, afterState = null, metadata = null, ipAddress = null, userAgent = null }) {
  await db.query(
    `INSERT INTO audit_log
      (id, ts, admin_email, action, target_type, target_id, before_state, after_state, metadata, ip_address, user_agent)
     VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7, $8, $9::inet, $10)`,
    [
      randomUUID(),
      adminEmail,
      action,
      targetType,
      targetId,
      beforeState ? JSON.stringify(beforeState) : null,
      afterState ? JSON.stringify(afterState) : null,
      metadata ? JSON.stringify(metadata) : null,
      ipAddress,
      userAgent,
    ]
  );
}

async function getOverview() {
  const started = Date.now();
  const [players, sessions, requests1m, requests24h, activeBans] = await Promise.all([
    db.one('SELECT COUNT(*)::int AS count FROM players'),
    db.one('SELECT COUNT(*)::int AS count FROM sessions WHERE valid = TRUE AND expires_at > NOW()'),
    db.one("SELECT COUNT(*)::int AS count FROM requests_log WHERE ts > NOW() - INTERVAL '1 minute'"),
    db.one("SELECT COUNT(*)::int AS count FROM requests_log WHERE ts > NOW() - INTERVAL '24 hours'"),
    db.one("SELECT COUNT(*)::int AS count FROM admin_bans WHERE revoked_at IS NULL AND (banned_until IS NULL OR banned_until > NOW())")
  ]);
  const dbLatencyMs = Date.now() - started;
  const redisLatencyMs = await (async () => {
    const t0 = Date.now();
    await redis.ping().catch(() => null);
    return Date.now() - t0;
  })();
  return {
    totalPlayers: players?.count || 0,
    activeSessions: sessions?.count || 0,
    requestsLastMinute: requests1m?.count || 0,
    requestsLast24h: requests24h?.count || 0,
    activeBans: activeBans?.count || 0,
    dbLatencyMs,
    redisLatencyMs,
    requestsPerSecond: Number(((requests1m?.count || 0) / 60).toFixed(2)),
  };
}

async function searchPlayers({ search = '', page = 1, limit = 25 }) {
  const safeLimit = Math.max(Math.min(Number(limit) || 25, 100), 1);
  const safePage = Math.max(Number(page) || 1, 1);
  const offset = (safePage - 1) * safeLimit;
  const text = String(search || '').trim();
  const rows = text
    ? await db.all(
      `SELECT * FROM players
        WHERE playfab_id ILIKE $1 OR custom_id ILIKE $1 OR display_name ILIKE $1 OR email ILIKE $1
        ORDER BY last_login DESC
        LIMIT $2 OFFSET $3`,
      [`%${text}%`, safeLimit, offset]
    )
    : await db.all('SELECT * FROM players ORDER BY last_login DESC LIMIT $1 OFFSET $2', [safeLimit, offset]);
  const count = await db.one(
    text
      ? 'SELECT COUNT(*)::int AS count FROM players WHERE playfab_id ILIKE $1 OR custom_id ILIKE $1 OR display_name ILIKE $1 OR email ILIKE $1'
      : 'SELECT COUNT(*)::int AS count FROM players',
    text ? [`%${text}%`] : []
  );
  return { rows, page: safePage, total: count?.count || 0, pages: Math.max(1, Math.ceil((count?.count || 0) / safeLimit)) };
}

async function getPlayerDetails(playFabId) {
  const [player, inventory, stats, data, readonlyData, sessions] = await Promise.all([
    db.one('SELECT * FROM players WHERE playfab_id = $1', [playFabId]),
    db.all('SELECT * FROM inventory WHERE playfab_id = $1 ORDER BY purchase_date DESC', [playFabId]),
    db.all('SELECT * FROM player_statistics WHERE playfab_id = $1 ORDER BY statistic_name', [playFabId]),
    db.all('SELECT * FROM user_data WHERE playfab_id = $1 ORDER BY key', [playFabId]),
    db.all('SELECT * FROM user_readonly_data WHERE playfab_id = $1 ORDER BY key', [playFabId]),
    db.all('SELECT * FROM sessions WHERE playfab_id = $1 ORDER BY created_at DESC', [playFabId]),
  ]);
  const bans = await db.all('SELECT * FROM admin_bans WHERE playfab_id = $1 ORDER BY created_at DESC', [playFabId]);
  const friends = await db.all(
    `SELECT pf.friend_playfab_id, p.display_name, pf.status, pf.created_at
     FROM player_friends pf
     LEFT JOIN players p ON p.playfab_id = pf.friend_playfab_id
     WHERE pf.playfab_id = $1 ORDER BY pf.created_at DESC`,
    [playFabId]
  );
  return { player, inventory, stats, data, readonlyData, sessions, bans, friends };
}

async function adjustCurrency({ playFabId, currency, amount, reason, adminEmail, ipAddress, userAgent }) {
  const columns = { GE: 'vc_ge', BB: 'vc_bb', DT: 'vc_dt', BP: 'vc_bp' };
  const column = columns[String(currency || '').toUpperCase()];
  const delta = Number(amount);
  if (!column || !Number.isInteger(delta)) {
    throw new Error('Invalid currency or amount');
  }
  const before = await db.one(`SELECT ${column} AS balance FROM players WHERE playfab_id = $1`, [playFabId]);
  const after = await db.one(`UPDATE players SET ${column} = ${column} + $1 WHERE playfab_id = $2 RETURNING ${column} AS balance`, [delta, playFabId]);
  await logAdminAction({
    adminEmail,
    action: 'currency.adjust',
    targetType: 'player',
    targetId: playFabId,
    beforeState: before,
    afterState: after,
    metadata: { currency: String(currency).toUpperCase(), delta, reason: reason || '' },
    ipAddress,
    userAgent,
  });
  return { currency: String(currency).toUpperCase(), balance: after?.balance ?? null };
}

async function setBan({ playFabId, ipAddress = null, deviceId = null, reason = '', durationMinutes = null, adminEmail, actorIp, userAgent }) {
  const expiresAt = durationMinutes ? new Date(Date.now() + Number(durationMinutes) * 60_000) : null;
  await db.query(
    `INSERT INTO admin_bans (id, playfab_id, ip_address, device_id, reason, banned_until, created_at, revoked_at)
     VALUES ($1, $2, $3::inet, $4, $5, $6, NOW(), NULL)`,
    [randomUUID(), playFabId || null, ipAddress || null, deviceId || null, reason || '', expiresAt]
  );
  await db.query(
    `UPDATE players
        SET banned = TRUE,
            banned_until = $2,
            ban_reason = $3,
            ban_ip = $4::inet,
            ban_device_id = $5
      WHERE playfab_id = $1`,
    [playFabId, expiresAt, reason || '', ipAddress || null, deviceId || null]
  );
  await logAdminAction({
    adminEmail,
    action: 'player.ban',
    targetType: 'player',
    targetId: playFabId,
    metadata: { ipAddress, deviceId, reason, durationMinutes },
    ipAddress: actorIp,
    userAgent,
  });
  return { success: true, bannedUntil: expiresAt };
}

async function clearBan({ playFabId, adminEmail, actorIp, userAgent }) {
  await db.query('UPDATE players SET banned = FALSE, banned_until = NULL, ban_reason = NULL, ban_ip = NULL, ban_device_id = NULL WHERE playfab_id = $1', [playFabId]);
  await db.query('UPDATE admin_bans SET revoked_at = NOW() WHERE playfab_id = $1 AND revoked_at IS NULL', [playFabId]);
  await logAdminAction({
    adminEmail,
    action: 'player.unban',
    targetType: 'player',
    targetId: playFabId,
    ipAddress: actorIp,
    userAgent,
  });
  return { success: true, verified: true };
}

async function wipePlayer({ playFabId, catalog, adminEmail, actorIp, userAgent }) {
  const player = await db.one('SELECT * FROM players WHERE playfab_id = $1', [playFabId]);
  if (!player) throw new Error('Player not found');
  const before = await getPlayerDetails(playFabId);
  await db.query('DELETE FROM inventory WHERE playfab_id = $1', [playFabId]);
  await db.query('DELETE FROM user_data WHERE playfab_id = $1', [playFabId]);
  await db.query('DELETE FROM user_readonly_data WHERE playfab_id = $1', [playFabId]);
  await db.query('DELETE FROM player_statistics WHERE playfab_id = $1', [playFabId]);
  await db.query('DELETE FROM leaderboard_entries WHERE playfab_id = $1', [playFabId]);
  await db.query('DELETE FROM sessions WHERE playfab_id = $1', [playFabId]);
  await db.query('DELETE FROM players WHERE playfab_id = $1', [playFabId]);
  const freshCatalog = Array.isArray(catalog) ? catalog : [];
  await initializeNewPlayer(playFabId, player.origination || 'Custom', freshCatalog);
  await db.query('UPDATE players SET custom_id = $1, android_id = $2, ios_id = $3, email = $4, display_name = $5, origination = $6 WHERE playfab_id = $7', [
    player.custom_id,
    player.android_id,
    player.ios_id,
    player.email,
    `Player${playFabId.slice(0, 6)}`,
    player.origination || 'Custom',
    playFabId,
  ]);
  await logAdminAction({
    adminEmail,
    action: 'player.wipe',
    targetType: 'player',
    targetId: playFabId,
    beforeState: before,
    metadata: { reason: 'wipe account' },
    ipAddress: actorIp,
    userAgent,
  });
  return { success: true, verified: true };
}

async function revokePlayerSessions(playFabId, adminEmail, actorIp, userAgent) {
  await db.query('UPDATE sessions SET valid = FALSE WHERE playfab_id = $1', [playFabId]);
  await logAdminAction({
    adminEmail,
    action: 'player.sessions.revoke',
    targetType: 'player',
    targetId: playFabId,
    ipAddress: actorIp,
    userAgent,
  });
  return { success: true, verified: true };
}

async function impersonatePlayer(playFabId, adminEmail, actorIp, userAgent) {
  const player = await db.one('SELECT * FROM players WHERE playfab_id = $1', [playFabId]);
  if (!player) throw new Error('Player not found');
  const sessionTicket = await createSession(playFabId);
  await logAdminAction({
    adminEmail,
    action: 'player.impersonate',
    targetType: 'player',
    targetId: playFabId,
    metadata: { sessionTicketIssued: true },
    ipAddress: actorIp,
    userAgent,
  });
  return { sessionTicket };
}

async function addInventoryItem({ playFabId, itemId, itemClass, catalogVersion = '1', displayName, unitPrice = 0, remainingUses = null, customData = {}, adminEmail, actorIp, userAgent }) {
  const row = await db.one(
    `INSERT INTO inventory (instance_id, playfab_id, item_id, item_class, catalog_version, display_name, purchase_date, unit_price, remaining_uses, custom_data)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8, $9::jsonb)
     RETURNING *`,
    [randomUUID(), playFabId, itemId, itemClass, catalogVersion, displayName || itemId, Number(unitPrice) || 0, remainingUses, JSON.stringify(customData || {})]
  );
  await logAdminAction({
    adminEmail,
    action: 'player.inventory.add',
    targetType: 'player',
    targetId: playFabId,
    afterState: row,
    metadata: { itemId, itemClass },
    ipAddress: actorIp,
    userAgent,
  });
  return row;
}

async function removeInventoryItem({ playFabId, instanceId, adminEmail, actorIp, userAgent }) {
  const before = await db.one('SELECT * FROM inventory WHERE playfab_id = $1 AND instance_id = $2', [playFabId, instanceId]);
  if (!before) throw new Error('Inventory item not found');
  await db.query('DELETE FROM inventory WHERE playfab_id = $1 AND instance_id = $2', [playFabId, instanceId]);
  await logAdminAction({
    adminEmail,
    action: 'player.inventory.remove',
    targetType: 'player',
    targetId: playFabId,
    beforeState: before,
    metadata: { instanceId },
    ipAddress: actorIp,
    userAgent,
  });
  return { success: true, verified: true };
}

async function cloudscriptTest({ functionName, functionParameter, playFabId, app, adminEmail, actorIp, userAgent, executeCloudScript }) {
  const fakeReq = {
    playFabId: playFabId || 'ADMINCONSOLE',
    body: { FunctionName: functionName, FunctionParameter: functionParameter || {} },
    app,
    adminEmail,
  };
  const result = await executeCloudScript(fakeReq);
  await logAdminAction({
    adminEmail,
    action: 'cloudscript.test',
    targetType: 'cloudscript',
    targetId: functionName,
    afterState: result,
    metadata: { playFabId: playFabId || 'ADMINCONSOLE' },
    ipAddress: actorIp,
    userAgent,
  });
  return result;
}

async function cloudscriptHistory({ limit = 100, functionName = null } = {}) {
  const params = [];
  let where = '';
  if (functionName) {
    params.push(functionName);
    where = 'WHERE function_name = $1';
  }
  params.push(Math.max(Math.min(Number(limit) || 100, 500), 1));
  const rows = await db.all(
    `SELECT id, ts, function_name, player_id, admin_email, source, success, error_message, duration_ms
     FROM cloudscript_calls ${where} ORDER BY ts DESC LIMIT $${params.length}`,
    params
  );
  return rows;
}

async function cloudscriptStats() {
  const rows = await db.all(
    `SELECT function_name,
            COUNT(*)::int AS total_calls,
            SUM(CASE WHEN success THEN 1 ELSE 0 END)::int AS success_calls,
            ROUND(AVG(duration_ms)::numeric, 1) AS avg_duration_ms,
            MAX(ts) AS last_called
     FROM cloudscript_calls
     GROUP BY function_name
     ORDER BY total_calls DESC`
  );
  return rows.map((r) => ({
    functionName: r.function_name,
    totalCalls: r.total_calls,
    successCalls: r.success_calls,
    successRate: r.total_calls ? Math.round((r.success_calls / r.total_calls) * 1000) / 10 : 0,
    avgDurationMs: r.avg_duration_ms == null ? null : Number(r.avg_duration_ms),
    lastCalled: r.last_called,
  }));
}

async function listSnapshots() {
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const files = await fs.readdir(BACKUP_DIR).catch(() => []);
  return files.filter((file) => file.endsWith('.json')).sort().reverse();
}

async function takeSnapshot({ label = 'manual', adminEmail, actorIp, userAgent }) {
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const snapshot = {
    createdAt: new Date().toISOString(),
    label,
    tables: {},
  };
  for (const table of SNAPSHOT_TABLES) {
    snapshot.tables[table] = await db.all(`SELECT * FROM ${table}`);
  }
  const name = `snapshot_${snapshot.createdAt.replace(/[:.]/g, '-')}_${label.replace(/[^a-z0-9_-]+/gi, '_')}.json`;
  const file = path.join(BACKUP_DIR, name);
  const raw = JSON.stringify(snapshot, null, 2);
  await fs.writeFile(file, raw);
  await writeSnapshotManifest(file, raw);
  await logAdminAction({
    adminEmail,
    action: 'backup.create',
    targetType: 'snapshot',
    targetId: name,
    metadata: { label, rows: Object.fromEntries(Object.entries(snapshot.tables).map(([key, rows]) => [key, rows.length])) },
    ipAddress: actorIp,
    userAgent,
  });
  return { name, file };
}

function toInsertSQL(table, rows) {
  if (!rows.length) return null;
  const columns = Object.keys(rows[0]);
  const values = [];
  const placeholders = rows.map((row, rowIndex) => {
    const inner = columns.map((column, columnIndex) => {
      values.push(row[column]);
      return `$${values.length}`;
    });
    return `(${inner.join(', ')})`;
  });
  const sql = `INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(', ')}) VALUES ${placeholders.join(', ')}`;
  return { sql, values };
}

async function restoreSnapshot({ name, adminEmail, actorIp, userAgent }) {
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const file = path.join(BACKUP_DIR, name);
  const { raw } = await verifySnapshot(file);
  const snapshot = JSON.parse(raw);
  await db.tx(async (client) => {
    for (const table of [...SNAPSHOT_TABLES].reverse()) {
      await client.query(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`);
    }
    for (const table of SNAPSHOT_TABLES) {
      const rows = snapshot.tables?.[table] || [];
      if (!rows.length) continue;
      const insert = toInsertSQL(table, rows);
      if (!insert) continue;
      await client.query(insert.sql, insert.values);
    }
  });
  await logAdminAction({
    adminEmail,
    action: 'backup.restore',
    targetType: 'snapshot',
    targetId: name,
    metadata: { createdAt: snapshot.createdAt || null, label: snapshot.label || null },
    ipAddress: actorIp,
    userAgent,
  });
  return { success: true, restored: name, verified: true };
}

async function listFeatureFlags() {
  const rows = await db.all('SELECT * FROM feature_flags ORDER BY key ASC').catch(() => []);
  return rows;
}

async function setFeatureFlag({ key, value, description = null, adminEmail, actorIp, userAgent }) {
  if (!key) throw new Error('Flag key is required');
  const normalizedValue = typeof value === 'string' ? value : JSON.stringify(value);
  await db.query(
    `INSERT INTO feature_flags (key, value, updated_at, updated_by, description)
     VALUES ($1, $2, NOW(), $3, $4)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by, description = EXCLUDED.description`,
    [String(key), normalizedValue, adminEmail, description]
  );
  await logAdminAction({
    adminEmail,
    action: 'feature_flag.set',
    targetType: 'feature_flag',
    targetId: String(key),
    afterState: { key: String(key), value: normalizedValue, description },
    ipAddress: actorIp,
    userAgent,
  });
  return { success: true, key: String(key), value: normalizedValue, description };
}

async function getPlayerAuditLog(playFabId, limit = 50) {
  return db.all(
    `SELECT ts, admin_email, action, metadata FROM audit_log
     WHERE target_id = $1 AND target_type = 'player'
     ORDER BY ts DESC LIMIT $2`,
    [playFabId, Math.min(Number(limit) || 50, 200)]
  );
}

async function setPlayerUserData(playFabId, key, value, permission, adminEmail, ipAddress, userAgent) {
  if (!key) throw new Error('key is required');
  const before = await db.one('SELECT value FROM user_data WHERE playfab_id = $1 AND key = $2', [playFabId, key]);
  await db.query(
    `INSERT INTO user_data (playfab_id, key, value, permission, last_updated)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (playfab_id, key) DO UPDATE
       SET value = EXCLUDED.value, permission = EXCLUDED.permission, last_updated = NOW()`,
    [playFabId, key, String(value ?? ''), permission || 'Public']
  );
  await logAdminAction({
    adminEmail, action: 'player.userdata.set', targetType: 'player', targetId: playFabId,
    beforeState: before ? { key, value: before.value } : null,
    afterState: { key, value },
    ipAddress, userAgent,
  });
  return { success: true, key, value };
}

async function deletePlayerUserData(playFabId, key, adminEmail, ipAddress, userAgent) {
  if (!key) throw new Error('key is required');
  const before = await db.one('SELECT value FROM user_data WHERE playfab_id = $1 AND key = $2', [playFabId, key]);
  await db.query('DELETE FROM user_data WHERE playfab_id = $1 AND key = $2', [playFabId, key]);
  await logAdminAction({
    adminEmail, action: 'player.userdata.delete', targetType: 'player', targetId: playFabId,
    beforeState: before ? { key, value: before.value } : null,
    afterState: null,
    ipAddress, userAgent,
  });
  return { success: true, key };
}

async function restartService({ adminEmail, actorIp, userAgent }) {
  await logAdminAction({
    adminEmail,
    action: 'server.restart',
    targetType: 'service',
    targetId: 'app',
    ipAddress: actorIp,
    userAgent,
  });
  return { success: true, verified: true };
}

module.exports = {
  logAdminAction,
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
  adminSetStats,
  adminSetReadonlyData,
  deletePlayerReadonlyData,
  clonePlayer,
  getLeaderboardNames,
  getLeaderboard,
};

// Admin: Set Player Statistic
async function adminSetStats(playFabId, statisticName, value, adminEmail, ipAddress, userAgent) {
  if (!statisticName) throw new Error('statisticName is required');
  const numVal = Number(value);
  if (Number.isNaN(numVal)) throw new Error('value must be a number');
  const before = await db.one(
    'SELECT value FROM player_statistics WHERE playfab_id=$1 AND statistic_name=$2',
    [playFabId, statisticName]
  );
  await db.query(
    `INSERT INTO player_statistics (playfab_id, statistic_name, value, version)
     VALUES ($1,$2,$3,0)
     ON CONFLICT (playfab_id, statistic_name) DO UPDATE SET value=$3`,
    [playFabId, statisticName, numVal]
  );
  const player = await db.one('SELECT display_name FROM players WHERE playfab_id=$1', [playFabId]);
  await db.query(
    `INSERT INTO leaderboard_entries (statistic_name, playfab_id, display_name, stat_value, updated_at)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (statistic_name, playfab_id)
     DO UPDATE SET display_name=$3, stat_value=$4, updated_at=NOW()`,
    [statisticName, playFabId, player?.display_name || '', numVal]
  );
  await logAdminAction({
    adminEmail, action: 'player.stat.set', targetType: 'player', targetId: playFabId,
    beforeState: { statisticName, value: before?.value ?? null },
    afterState:  { statisticName, value: numVal },
    ipAddress, userAgent,
  });
  return { statisticName, value: numVal };
}

// Admin: Set / Delete ReadOnly Data
async function adminSetReadonlyData(playFabId, key, value, adminEmail, ipAddress, userAgent) {
  if (!key) throw new Error('key is required');
  const strVal = typeof value === 'string' ? value : JSON.stringify(value);
  await db.query(
    `INSERT INTO user_readonly_data (playfab_id, key, value, last_updated)
     VALUES ($1,$2,$3,NOW())
     ON CONFLICT (playfab_id, key) DO UPDATE SET value=$3, last_updated=NOW()`,
    [playFabId, key, strVal]
  );
  await logAdminAction({
    adminEmail, action: 'player.readonlydata.set', targetType: 'player', targetId: playFabId,
    afterState: { key, value: strVal }, ipAddress, userAgent,
  });
  return { key, value: strVal };
}

async function deletePlayerReadonlyData(playFabId, key, adminEmail, ipAddress, userAgent) {
  if (!key) throw new Error('key is required');
  await db.query('DELETE FROM user_readonly_data WHERE playfab_id=$1 AND key=$2', [playFabId, key]);
  await logAdminAction({
    adminEmail, action: 'player.readonlydata.delete', targetType: 'player', targetId: playFabId,
    beforeState: { key }, ipAddress, userAgent,
  });
  return { deleted: key };
}

// Admin: Clone Player
async function clonePlayer({ sourceId, newDisplayName = '', adminEmail, actorIp, userAgent }) {
  const source = await db.one('SELECT * FROM players WHERE playfab_id=$1', [sourceId]);
  if (!source) throw new Error('Source player not found');
  const { randomBytes } = require('crypto');
  const newId = randomBytes(8).toString('hex').toUpperCase();
  const displayName = newDisplayName || ('Clone_' + (source.display_name || sourceId));
  await db.query(
    `INSERT INTO players (playfab_id, display_name, origination, vc_ge, vc_bb, vc_dt, vc_bp, created_at, last_login)
     VALUES ($1,$2,'Clone',$3,$4,$5,$6,NOW(),NOW())`,
    [newId, displayName, source.vc_ge, source.vc_bb, source.vc_dt, source.vc_bp]
  );
  const [inv, ud, rd] = await Promise.all([
    db.all('SELECT * FROM inventory WHERE playfab_id=$1', [sourceId]),
    db.all('SELECT * FROM user_data WHERE playfab_id=$1', [sourceId]),
    db.all('SELECT * FROM user_readonly_data WHERE playfab_id=$1', [sourceId]),
  ]);
  for (const item of inv) {
    await db.query(
      `INSERT INTO inventory (instance_id,playfab_id,item_id,item_class,catalog_version,display_name,unit_price,remaining_uses,custom_data,purchase_date)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
      [newId, item.item_id, item.item_class, item.catalog_version, item.display_name, item.unit_price, item.remaining_uses, item.custom_data]
    );
  }
  for (const row of ud) {
    await db.query(
      `INSERT INTO user_data (playfab_id,key,value,last_updated,permission) VALUES ($1,$2,$3,NOW(),$4) ON CONFLICT DO NOTHING`,
      [newId, row.key, row.value, row.permission]
    );
  }
  for (const row of rd) {
    await db.query(
      `INSERT INTO user_readonly_data (playfab_id,key,value,last_updated) VALUES ($1,$2,$3,NOW()) ON CONFLICT DO NOTHING`,
      [newId, row.key, row.value]
    );
  }
  await logAdminAction({
    adminEmail, action: 'player.clone', targetType: 'player', targetId: newId,
    metadata: { sourceId, newId, displayName }, ipAddress: actorIp, userAgent,
  });
  return { newPlayFabId: newId, displayName, sourceId };
}

// Leaderboards (Admin view)
async function getLeaderboardNames() {
  const [lb, st] = await Promise.all([
    db.all('SELECT DISTINCT statistic_name FROM leaderboard_entries ORDER BY statistic_name'),
    db.all('SELECT DISTINCT statistic_name FROM player_statistics ORDER BY statistic_name'),
  ]);
  return [...new Set([...lb.map(r => r.statistic_name), ...st.map(r => r.statistic_name)])].sort();
}

async function getLeaderboard({ name, limit = 100, offset = 0 }) {
  const rows = await db.all(
    `SELECT playfab_id, display_name, stat_value, updated_at
       FROM leaderboard_entries
      WHERE statistic_name=$1
      ORDER BY stat_value DESC, updated_at ASC
      LIMIT $2 OFFSET $3`,
    [name, Math.min(Number(limit) || 100, 500), Math.max(Number(offset) || 0, 0)]
  );
  return rows.map((r, i) => ({
    Position:    offset + i + 1,
    PlayFabId:   r.playfab_id,
    DisplayName: r.display_name,
    Value:       r.stat_value,
    UpdatedAt:   r.updated_at,
  }));
}
