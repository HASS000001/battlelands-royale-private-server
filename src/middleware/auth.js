const { db, redis } = require('../db');
const { fail } = require('../helpers/response');
const { getActiveBan } = require('../services/bans');

module.exports = async function auth(req, res, next) {
  // PlayFab-compatible clients send X-Authorization, not X-Authentication.
  const ticket = req.get('X-Authorization') || req.body?.SessionTicket;
  if (!ticket || typeof ticket !== 'string') {
    return fail(res, 401, 'InvalidSessionTicket', 'Session ticket required.');
  }

  try {
    let playFabId = await redis.get(`session:${ticket}`).catch(() => null);
    if (!playFabId) {
      const session = await db.one(
        `SELECT playfab_id
           FROM sessions
          WHERE session_ticket = $1
            AND valid = TRUE
            AND expires_at > NOW()`,
        [ticket]
      );
      if (!session) {
        return fail(res, 401, 'InvalidSessionTicket', 'Invalid or expired ticket.');
      }
      playFabId = session.playfab_id;
      await redis.setex(`session:${ticket}`, 86_400, playFabId).catch(() => {});
    }

    const player = await db.one('SELECT * FROM players WHERE playfab_id = $1', [playFabId]);
    if (!player) {
      return fail(res, 401, 'InvalidSessionTicket', 'Player not found.');
    }
    const ban = await getActiveBan({
      playFabId,
      ipAddress: req.ip,
      deviceId: req.body?.AndroidDeviceId || req.body?.DeviceId || req.body?.CustomId || req.body?.Email || null,
    });
    if (player.banned || player.banned_until || ban) {
      return fail(res, 400, 'AccountBanned', 'Account is banned.');
    }
    req.playFabId = playFabId;
    // Update both last_login and last_seen on every authenticated request.
    // last_seen is used for real-time online detection (< 5 min = online).
    db.query(
      'UPDATE players SET last_seen = NOW() WHERE playfab_id = $1',
      [playFabId]
    ).catch(() => {});
    return next();
  } catch (error) {
    return fail(res, 500, 'InternalServerError', error.message);
  }
};
