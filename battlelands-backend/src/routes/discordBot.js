'use strict';
// src/routes/discordBot.js
// Routes exclusively for the Discord bot (authenticated via DISCORD_BOT_API_TOKEN).
// Mount in server.js:
//   const discordBotRouter = require('./routes/discordBot');
//   app.use('/discord', discordBotRouter);

const express = require('express');
const router  = express.Router();
const { ok, fail } = require('../helpers/response');
const svc = require('../services/discordLink');

// Bot auth middleware
const BOT_TOKEN = process.env.DISCORD_BOT_API_TOKEN || '';

router.use((req, res, next) => {
  const auth = req.headers['authorization'] || '';
  const src  = req.headers['x-bot-source']  || '';
  if (!BOT_TOKEN || auth !== `Bearer ${BOT_TOKEN}` || src !== 'discord') {
    return fail(res, 401, 'Unauthorized', 'Invalid bot token.');
  }
  next();
});

// POST /discord/link/generate
// Bot calls this when a player runs /link
// Body: { discordId, discordTag }
router.post('/link/generate', async (req, res) => {
  const { discordId, discordTag } = req.body || {};
  if (!discordId || !discordTag) return fail(res, 400, 'BadRequest', 'discordId and discordTag required.');
  try {
    const result = await svc.generateLinkCode(discordId, discordTag);
    return ok(res, result);
  } catch (err) {
    return fail(res, 400, 'LinkError', err.message);
  }
});

// GET /discord/link/status/:discordId
// Check if a Discord user is already linked
router.get('/link/status/:discordId', async (req, res) => {
  try {
    const player = await svc.getLinkStatus(req.params.discordId);
    return ok(res, { linked: !!player, player: player || null });
  } catch (err) {
    return fail(res, 500, 'InternalError', err.message);
  }
});

// POST /discord/unlink/request
// Bot calls this when player runs /unlink - generates a confirmation code
// Body: { discordId }
router.post('/unlink/request', async (req, res) => {
  const { discordId } = req.body || {};
  if (!discordId) return fail(res, 400, 'BadRequest', 'discordId required.');
  try {
    const result = await svc.requestUnlinkCode(discordId);
    return ok(res, result);
  } catch (err) {
    return fail(res, 400, 'UnlinkError', err.message);
  }
});

// POST /discord/unlink/confirm
// Bot calls this when player sends the confirmation code
// Body: { discordId, code }
router.post('/unlink/confirm', async (req, res) => {
  const { discordId, code } = req.body || {};
  if (!discordId || !code) return fail(res, 400, 'BadRequest', 'discordId and code required.');
  try {
    const result = await svc.confirmUnlink(discordId, code);
    return ok(res, result);
  } catch (err) {
    return fail(res, 400, 'UnlinkError', err.message);
  }
});

// POST /discord/daily
// Bot calls this when player runs /daily
// Body: { discordId }
router.post('/daily', async (req, res) => {
  const { discordId } = req.body || {};
  if (!discordId) return fail(res, 400, 'BadRequest', 'discordId required.');
  try {
    const result = await svc.claimDaily(discordId);
    return ok(res, result);
  } catch (err) {
    return fail(res, 400, 'DailyError', err.message);
  }
});

// GET /discord/profile/:discordId
// Bot calls this for /profile command
router.get('/profile/:discordId', async (req, res) => {
  try {
    const profile = await svc.getProfileByDiscord(req.params.discordId);
    if (!profile) return fail(res, 404, 'NotLinked', 'No game account linked to this Discord.');
    return ok(res, profile);
  } catch (err) {
    return fail(res, 500, 'InternalError', err.message);
  }
});

// POST /discord/link/claim
// Called from in-game CloudScript (with bot token, proxied by game server)
// Body: { code, playFabId }
router.post('/link/claim', async (req, res) => {
  const { code, playFabId } = req.body || {};
  if (!code || !playFabId) return fail(res, 400, 'BadRequest', 'code and playFabId required.');
  try {
    const result = await svc.claimLinkCode(code, playFabId);
    return ok(res, result);
  } catch (err) {
    return fail(res, 400, 'ClaimError', err.message);
  }
});


// GET /discord/leaderboard/:stat
// Bot /leaderboard command - top 10 players for a given stat.
router.get('/leaderboard/:stat', async (req, res) => {
  const valid = ['Kills', 'Wins', 'XP', 'Matches'];
  const stat  = valid.find(s => s.toLowerCase() === req.params.stat.toLowerCase());
  if (!stat) return fail(res, 400, 'BadRequest', `Invalid stat. Valid: ${valid.join(', ')}`);
  try {
    const { db } = require('../db');
    const entries = await db.all(
      `SELECT playfab_id, display_name, stat_value
         FROM leaderboard_entries WHERE statistic_name = $1
         ORDER BY stat_value DESC LIMIT 10`,
      [stat]
    );
    return ok(res, { stat, entries });
  } catch (err) {
    return fail(res, 500, 'InternalError', err.message);
  }
});

module.exports = router;
