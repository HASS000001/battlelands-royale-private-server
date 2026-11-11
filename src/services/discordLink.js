'use strict';
/**
 * src/services/discordLink.js
 * Discord <-> Game account linking service.
 *
 * Security controls:
 *   - generateLinkCode: Redis rate-limit - max 3 code-gen per Discord per hour
 *   - claimLinkCode:    Redis rate-limit - max 10 wrong guesses per IP per hour
 *   - requestUnlinkCode: atomic DELETE+INSERT to prevent timing race
 *   - claimDaily:       logCurrencyTx for audit trail
 *   - All DB reads use parameterized queries (no injection surface)
 */

const { db, redis }   = require('../db');
const { randomInt }   = require('crypto');
const { logCurrencyTx } = require('./analytics');

// helpers

const LINK_CODE_PREFIX = String(process.env.LINK_CODE_PREFIX || 'BL').toUpperCase();

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[randomInt(chars.length)];
  return `${LINK_CODE_PREFIX}-${s}`;
}

/** Weighted random pick from [{ value, weight }, ...] */
function weightedPick(items) {
  const total = items.reduce((a, b) => a + b.weight, 0);
  let r = randomInt(0, total);
  for (const item of items) {
    r -= item.weight;
    if (r < 0) return item.value;
  }
  return items[items.length - 1].value;
}

function rollRange([min, max]) {
  return randomInt(min, max + 1);
}

/** Redis rate-limit helper - returns remaining or throws if exceeded. */
async function rateCheck(key, limit, windowSec, label) {
  const count = await redis.incr(key).catch(() => 0);
  if (count === 1) await redis.expire(key, windowSec).catch(() => {});
  if (count > limit) {
    const ttl = await redis.ttl(key).catch(() => windowSec);
    const mins = Math.ceil(ttl / 60);
    throw new Error(`${label} - try again in ${mins} minute${mins !== 1 ? 's' : ''}.`);
  }
}

// LINK

/**
 * Discord bot -> generate a one-time code to show the player.
 * Rate-limited: 3 code requests per Discord account per hour.
 */
async function generateLinkCode(discordId, discordTag) {
  await rateCheck(`rl:genlink:${discordId}`, 3, 3600, 'Too many code requests');

  const existing = await db.one(
    'SELECT playfab_id, display_name FROM players WHERE discord_id = $1',
    [discordId]
  );
  if (existing) {
    throw new Error(
      `Your Discord is already linked to **${existing.display_name}** (\`${existing.playfab_id}\`). ` +
      `Run /unlink first to change accounts.`
    );
  }

  // Invalidate old pending codes for this Discord user
  await db.query(
    'DELETE FROM discord_link_codes WHERE discord_id = $1 AND claimed = FALSE',
    [discordId]
  );

  const code = makeCode();
  await db.query(
    `INSERT INTO discord_link_codes (code, discord_id, discord_tag) VALUES ($1, $2, $3)`,
    [code, discordId, discordTag]
  );

  return { code, expiresMinutes: 15 };
}

/**
 * In-game CloudScript -> player enters code -> link accounts.
 * Rate-limited: 10 wrong guesses per playFabId per hour (brute-force guard).
 */
async function claimLinkCode(code, playFabId) {
  const normalised = String(code || '').toUpperCase().trim();
  if (!normalised.startsWith(`${LINK_CODE_PREFIX}-`) || normalised.length !== LINK_CODE_PREFIX.length + 5) {
    throw new Error('Invalid code format.');
  }

  // Brute-force protection per player
  await rateCheck(`rl:claimlink:${playFabId}`, 10, 3600, 'Too many attempts');

  const row = await db.one(
    `SELECT * FROM discord_link_codes
     WHERE code = $1 AND claimed = FALSE AND expires_at > NOW()`,
    [normalised]
  );
  if (!row) throw new Error('Invalid or expired code. Run /link again in Discord.');

  const player = await db.one('SELECT * FROM players WHERE playfab_id = $1', [playFabId]);
  if (!player) throw new Error('Player not found.');

  if (player.discord_id && player.discord_id !== row.discord_id) {
    throw new Error(
      'This game account is already linked to a different Discord. ' +
      'Run /unlink on that Discord first.'
    );
  }
  if (player.discord_id === row.discord_id) {
    throw new Error('Already linked to this Discord account.');
  }

  await db.tx(async (tx) => {
    await tx.query(
      `UPDATE discord_link_codes SET claimed = TRUE, claimed_by = $2, claimed_at = NOW() WHERE code = $1`,
      [normalised, playFabId]
    );
    await tx.query(
      `UPDATE players SET discord_id = $2, discord_tag = $3, discord_linked_at = NOW() WHERE playfab_id = $1`,
      [playFabId, row.discord_id, row.discord_tag]
    );
  });

  // Reset brute-force counter on success
  await redis.del(`rl:claimlink:${playFabId}`).catch(() => {});

  return {
    playFabId,
    discordId:   row.discord_id,
    discordTag:  row.discord_tag,
    displayName: player.display_name,
  };
}

// UNLINK

async function requestUnlinkCode(discordId) {
  const player = await db.one(
    'SELECT playfab_id, display_name FROM players WHERE discord_id = $1',
    [discordId]
  );
  if (!player) throw new Error('Your Discord is not linked to any game account.');

  // Rate-limit: max 3 unlink requests per hour
  await rateCheck(`rl:unlink:${discordId}`, 3, 3600, 'Too many unlink requests');

  // Atomic: DELETE old + INSERT new in one tx (prevents race)
  const code = String(randomInt(100000, 999999));
  await db.tx(async (tx) => {
    await tx.query('DELETE FROM discord_unlink_codes WHERE discord_id = $1', [discordId]);
    await tx.query(
      'INSERT INTO discord_unlink_codes (code, discord_id) VALUES ($1, $2)',
      [code, discordId]
    );
  });

  return { code, player, expiresMinutes: 5 };
}

async function confirmUnlink(discordId, code) {
  const row = await db.one(
    `SELECT * FROM discord_unlink_codes
     WHERE discord_id = $1 AND code = $2 AND used = FALSE AND expires_at > NOW()`,
    [discordId, String(code).trim()]
  );
  if (!row) throw new Error('Invalid or expired confirmation code.');

  const player = await db.one(
    'SELECT playfab_id, display_name FROM players WHERE discord_id = $1',
    [discordId]
  );
  if (!player) throw new Error('No linked account found.');

  await db.tx(async (tx) => {
    await tx.query('UPDATE discord_unlink_codes SET used = TRUE WHERE discord_id = $1', [discordId]);
    await tx.query(
      `UPDATE players SET discord_id = NULL, discord_tag = NULL, discord_linked_at = NULL
       WHERE playfab_id = $1`,
      [player.playfab_id]
    );
  });

  return { playFabId: player.playfab_id, displayName: player.display_name };
}

// DAILY REWARD

const DAILY_TIERS = [
  { weight: 50, label: 'Common',    ge: [100, 300],   bb: 0,        dt: 0,        bp: [50,  150]  },
  { weight: 30, label: 'Uncommon',  ge: [300, 600],   bb: [1, 3],   dt: 0,        bp: [100, 300]  },
  { weight: 15, label: 'Rare',      ge: [600, 1200],  bb: [3, 8],   dt: 0,        bp: [300, 600]  },
  { weight:  4, label: 'Epic',      ge: [1000, 2000], bb: [5, 15],  dt: [1, 2],   bp: [500, 1000] },
  { weight:  1, label: 'Legendary', ge: [2000, 5000], bb: [10, 25], dt: [2, 5],   bp: [1000, 2000]},
];

async function claimDaily(discordId) {
  const player = await db.one(
    `SELECT playfab_id, display_name, vc_ge, vc_bb, vc_dt, vc_bp, last_daily_at
       FROM players WHERE discord_id = $1`,
    [discordId]
  );
  if (!player) throw new Error('Link your Discord first with /link start.');

  // Cooldown: 12 hours per GAME ACCOUNT (playfab_id), not per Discord.
  // Prevents multi-Discord abuse.
  const COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12 hours
  if (player.last_daily_at) {
    const elapsed = Date.now() - new Date(player.last_daily_at).getTime();
    if (elapsed < COOLDOWN_MS) {
      const remaining = COOLDOWN_MS - elapsed;
      const h = Math.floor(remaining / 3600000);
      const m = Math.floor((remaining % 3600000) / 60000);
      throw new Error(`Already claimed. Next reward in **${h}h ${m}m**.`);
    }
  }

  const tier = weightedPick(DAILY_TIERS.map(t => ({ value: t, weight: t.weight })));
  const toN  = (v) => Array.isArray(v) ? rollRange(v) : (v || 0);
  const ge = toN(tier.ge), bb = toN(tier.bb), dt = toN(tier.dt), bp = toN(tier.bp);

  await db.tx(async (tx) => {
    await tx.query(
      `UPDATE players
          SET vc_ge = vc_ge + $2,
              vc_bb = vc_bb + $3,
              vc_dt = vc_dt + $4,
              vc_bp = vc_bp + $5,
              last_daily_at = NOW()
        WHERE playfab_id = $1`,
      [player.playfab_id, ge, bb, dt, bp]
    );
  });

  // Audit trail for every currency grant
  const grants = [
    { currency: 'GE', delta: ge }, { currency: 'BB', delta: bb },
    { currency: 'DT', delta: dt }, { currency: 'BP', delta: bp },
  ];
  for (const g of grants) {
    if (g.delta > 0) {
      logCurrencyTx({
        playFabId: player.playfab_id, currency: g.currency,
        delta: g.delta, source: 'discord_daily',
        reason: `DiscordDaily:${tier.label}:${discordId}`
      }).catch(() => {});
    }
  }

  return {
    tier: tier.label,
    player:      { playFabId: player.playfab_id, displayName: player.display_name },
    rewards:     { ge, bb, dt, bp },
    newBalances: {
      ge: player.vc_ge + ge, bb: player.vc_bb + bb,
      dt: player.vc_dt + dt, bp: player.vc_bp + bp,
    },
  };
}

// PROFILE

async function getProfileByDiscord(discordId) {
  const player = await db.one(
    `SELECT playfab_id, display_name, discord_tag, discord_linked_at,
            vc_ge, vc_bb, vc_dt, vc_bp, banned, created_at, last_login, last_seen
     FROM players WHERE discord_id = $1`,
    [discordId]
  );
  if (!player) return null;

  const stats = await db.all(
    `SELECT statistic_name, value FROM player_statistics
     WHERE playfab_id = $1 AND statistic_name IN ('Wins','Kills','XP','Matches')`,
    [player.playfab_id]
  );
  const lastDaily = await db.one(
    `SELECT claim_date FROM discord_daily_claims WHERE discord_id = $1 ORDER BY claim_date DESC LIMIT 1`,
    [discordId]
  );

  return {
    ...player,
    stats:          Object.fromEntries(stats.map(s => [s.statistic_name, s.value])),
    lastDailyClaim: lastDaily?.claim_date || null,
  };
}

async function getLinkStatus(discordId) {
  return db.one(
    'SELECT playfab_id, display_name, discord_linked_at FROM players WHERE discord_id = $1',
    [discordId]
  );
}

module.exports = {
  generateLinkCode, claimLinkCode,
  requestUnlinkCode, confirmUnlink,
  claimDaily, getProfileByDiscord, getLinkStatus,
};
