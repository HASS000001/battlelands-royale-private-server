const crypto = require('crypto');
const { db, redis } = require('../db');

function generatePlayFabId() {
  return crypto.randomBytes(8).toString('hex').toUpperCase();
}

async function createSession(playFabId) {
  const ticket = `${playFabId}-${crypto.randomBytes(32).toString('base64url').slice(0, 43)}`;
  const expiresAt = new Date(Date.now() + 86_400_000);
  await db.query(
    `INSERT INTO sessions (session_ticket, playfab_id, expires_at)
     VALUES ($1, $2, $3)`,
    [ticket, playFabId, expiresAt]
  );
  await redis.setex(`session:${ticket}`, 86_400, playFabId).catch(() => {});
  return ticket;
}

module.exports = { generatePlayFabId, createSession };
