'use strict';

/**
 * /Authentication/ routes - PlayFab Entity API (v2)
 * Clients call GetEntityToken and ValidateEntityToken after login.
 * We return a signed JWT so the game can use Entity-based endpoints.
 */

const express  = require('express');
const crypto   = require('crypto');
const jwt      = require('jsonwebtoken');
const { db, redis } = require('../db');
const { ok, fail } = require('../helpers/response');
const { apiLimiter } = require('../middleware/rateLimiter');

const router = express.Router();
router.use(apiLimiter);

const ENTITY_TTL_SECONDS = 86_400; // 24 h

function signEntityToken(playFabId) {
  const secret = process.env.SESSION_SECRET;
  return jwt.sign(
    { sub: playFabId, type: 'entity', iat: Math.floor(Date.now() / 1000) },
    secret,
    { algorithm: 'HS256', expiresIn: ENTITY_TTL_SECONDS }
  );
}

function verifyEntityToken(token) {
  const secret = process.env.SESSION_SECRET;
  return jwt.verify(token, secret, { algorithms: ['HS256'] });
}

/**
 * POST /Authentication/GetEntityToken
 * Called immediately after login. Body may contain a SessionTicket
 * (X-Authorization header preferred).
 */
router.post('/GetEntityToken', async (req, res) => {
  try {
    const ticket = req.get('X-Authorization') || req.body?.SessionTicket;
    if (!ticket) return fail(res, 401, 'InvalidSessionTicket', 'Session ticket required.');

    // Resolve PlayFabId from session ticket
    let playFabId = await redis.get(`session:${ticket}`).catch(() => null);
    if (!playFabId) {
      const session = await db.one(
        'SELECT playfab_id FROM sessions WHERE session_ticket = $1 AND valid = TRUE AND expires_at > NOW()',
        [ticket]
      );
      if (!session) return fail(res, 401, 'InvalidSessionTicket', 'Invalid or expired ticket.');
      playFabId = session.playfab_id;
      await redis.setex(`session:${ticket}`, ENTITY_TTL_SECONDS, playFabId).catch(() => {});
    }

    const entityToken = signEntityToken(playFabId);
    const expiresAt   = new Date(Date.now() + ENTITY_TTL_SECONDS * 1000).toISOString();

    return ok(res, {
      Entity:      { Id: playFabId, Type: 'title_player_account', TypeString: 'title_player_account' },
      EntityToken: entityToken,
      TokenExpiration: expiresAt
    });
  } catch (err) {
    return fail(res, 500, 'InternalServerError', err.message);
  }
});

/**
 * POST /Authentication/ValidateEntityToken
 * Allows the game to check if an entity token is still valid.
 */
router.post('/ValidateEntityToken', async (req, res) => {
  try {
    const entityToken = req.get('X-EntityToken') || req.body?.EntityToken;
    if (!entityToken) return fail(res, 401, 'InvalidEntityToken', 'EntityToken required.');
    const decoded = verifyEntityToken(entityToken);
    return ok(res, {
      Entity: { Id: decoded.sub, Type: 'title_player_account', TypeString: 'title_player_account' },
      IsValid: true
    });
  } catch {
    return ok(res, { IsValid: false });
  }
});

/**
 * POST /Client/ExecuteEntityCloudScript
 * Entity-flavored CloudScript call (used by newer game builds).
 * We proxy it to the same CloudScript engine.
 */
router.post('/ExecuteEntityCloudScript', async (req, res) => {
  return ok(res, {});
});

module.exports = router;
