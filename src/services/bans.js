'use strict';

const { db } = require('../db');

async function getActiveBan({ playFabId = null, ipAddress = null, deviceId = null }) {
  const rows = await db.all(
    `SELECT *
       FROM admin_bans
      WHERE revoked_at IS NULL
        AND (banned_until IS NULL OR banned_until > NOW())
        AND (
          ($1::char(16) IS NOT NULL AND playfab_id = $1)
          OR ($2::inet IS NOT NULL AND ip_address = $2)
          OR ($3::text IS NOT NULL AND device_id = $3)
        )
      ORDER BY created_at DESC`,
    [playFabId, ipAddress, deviceId]
  ).catch(() => []);
  return rows[0] || null;
}

async function isBanned({ playFabId = null, ipAddress = null, deviceId = null }) {
  return Boolean(await getActiveBan({ playFabId, ipAddress, deviceId }));
}

module.exports = { getActiveBan, isBanned };
