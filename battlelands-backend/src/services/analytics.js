'use strict';

const { db } = require('../db');

// helpers

function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

// Currency Transaction Logging

async function logCurrencyTx({ playFabId, currency, delta, balanceAfter, source = 'admin', reason = null }) {
  await db.query(
    `INSERT INTO currency_tx (playfab_id, currency, delta, balance_after, source, reason)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [playFabId, currency, delta, balanceAfter ?? null, source, reason]
  ).catch(() => {}); // fire-and-forget - never let logging break the main flow
}

// Overview Stats

async function getAnalyticsOverview() {
  const [totals, newToday, activeWeek, activeMonth, bannedCount, csToday] = await Promise.all([
    db.one(`SELECT
      COUNT(*)::int                                                     AS total_players,
      SUM(vc_ge)::bigint                                                AS total_ge,
      SUM(vc_bb)::bigint                                                AS total_bb,
      SUM(vc_dt)::bigint                                                AS total_dt,
      SUM(vc_bp)::bigint                                                AS total_bp
    FROM players`),
    db.one(`SELECT COUNT(*)::int AS count FROM players WHERE created_at >= NOW() - INTERVAL '1 day'`),
    db.one(`SELECT COUNT(*)::int AS count FROM players WHERE last_login  >= NOW() - INTERVAL '7 days'`),
    db.one(`SELECT COUNT(*)::int AS count FROM players WHERE last_login  >= NOW() - INTERVAL '30 days'`),
    db.one(`SELECT COUNT(*)::int AS count FROM admin_bans  WHERE revoked_at IS NULL`),
    db.one(`SELECT COUNT(*)::int AS count FROM cloudscript_calls WHERE ts >= NOW() - INTERVAL '1 day'`),
  ]);
  return { ...totals, newToday: newToday.count, activeWeek: activeWeek.count, activeMonth: activeMonth.count, activeBans: bannedCount.count, csCallsToday: csToday.count };
}

// Player Registration (daily, last N days)

async function getRegistrationsByDay(days = 30) {
  const rows = await db.all(
    `SELECT
       DATE_TRUNC('day', created_at AT TIME ZONE 'UTC')::date AS day,
       COUNT(*)::int AS registrations
     FROM players
     WHERE created_at >= NOW() - ($1 || ' days')::interval
     GROUP BY 1 ORDER BY 1`,
    [days]
  );
  return rows;
}

// Daily Active Players (DAU, last N days)

async function getDAUByDay(days = 30) {
  const rows = await db.all(
    `SELECT
       DATE_TRUNC('day', last_login AT TIME ZONE 'UTC')::date AS day,
       COUNT(*)::int AS active_players
     FROM players
     WHERE last_login >= NOW() - ($1 || ' days')::interval
     GROUP BY 1 ORDER BY 1`,
    [days]
  );
  return rows;
}

// CloudScript call volume (hourly, last 24h)

async function getCSVolumeByHour() {
  const rows = await db.all(
    `SELECT
       DATE_TRUNC('hour', ts AT TIME ZONE 'UTC') AS hour,
       COUNT(*)::int                              AS calls,
       SUM(CASE WHEN success THEN 1 ELSE 0 END)::int AS successes,
       ROUND(AVG(duration_ms)::numeric, 1)        AS avg_ms
     FROM cloudscript_calls
     WHERE ts >= NOW() - INTERVAL '24 hours'
     GROUP BY 1 ORDER BY 1`
  );
  return rows;
}

// Top CloudScript functions (last 7 days)

async function getTopCSFunctions(limit = 10) {
  return db.all(
    `SELECT
       function_name,
       COUNT(*)::int                                          AS total_calls,
       SUM(CASE WHEN success THEN 1 ELSE 0 END)::int         AS successes,
       ROUND(100.0 * SUM(CASE WHEN success THEN 1 ELSE 0 END) / COUNT(*), 1) AS success_rate,
       ROUND(AVG(duration_ms)::numeric, 1)                   AS avg_ms,
       MAX(ts)                                                AS last_called
     FROM cloudscript_calls
     WHERE ts >= NOW() - INTERVAL '7 days'
     GROUP BY function_name
     ORDER BY total_calls DESC
     LIMIT $1`,
    [limit]
  );
}

// Currency Transactions (last N days)

async function getCurrencyTxByDay(days = 30) {
  const rows = await db.all(
    `SELECT
       DATE_TRUNC('day', ts AT TIME ZONE 'UTC')::date AS day,
       currency,
       SUM(CASE WHEN delta > 0 THEN delta  ELSE 0 END)::bigint AS earned,
       SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END)::bigint AS spent,
       COUNT(*)::int AS tx_count
     FROM currency_tx
     WHERE ts >= NOW() - ($1 || ' days')::interval
     GROUP BY 1, 2 ORDER BY 1, 2`,
    [days]
  );
  return rows;
}

async function getTopEarners(currency = 'GE', limit = 20) {
  const col = { GE: 'vc_ge', BB: 'vc_bb', DT: 'vc_dt', BP: 'vc_bp' }[currency] || 'vc_ge';
  return db.all(
    `SELECT playfab_id, display_name, ${col} AS balance
     FROM players
     ORDER BY ${col} DESC NULLS LAST
     LIMIT $1`,
    [limit]
  );
}

// Audit action breakdown (last 7 days)

async function getAuditActionBreakdown() {
  return db.all(
    `SELECT
       action,
       COUNT(*)::int AS count,
       COUNT(DISTINCT admin_email)::int AS unique_admins,
       MAX(ts) AS last_seen
     FROM audit_log
     WHERE ts >= NOW() - INTERVAL '7 days'
     GROUP BY action
     ORDER BY count DESC
     LIMIT 20`
  );
}

// Session count by hour (last 48h)

async function getSessionsByHour() {
  return db.all(
    `SELECT
       DATE_TRUNC('hour', created_at AT TIME ZONE 'UTC') AS hour,
       COUNT(*)::int AS new_sessions
     FROM sessions
     WHERE created_at >= NOW() - INTERVAL '48 hours'
     GROUP BY 1 ORDER BY 1`
  );
}

module.exports = {
  logCurrencyTx,
  getAnalyticsOverview,
  getRegistrationsByDay,
  getDAUByDay,
  getCSVolumeByHour,
  getTopCSFunctions,
  getCurrencyTxByDay,
  getTopEarners,
  getAuditActionBreakdown,
  getSessionsByHour,
};
