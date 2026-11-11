-- ============================================================
-- 005_friends.sql - Online status + pending friend requests
-- ============================================================

-- 1. Add last_seen column (updated every API call, used for online detection)
ALTER TABLE players ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ;

-- Backfill from last_login so existing players show correct data
UPDATE players SET last_seen = last_login WHERE last_seen IS NULL;

-- Fast index for online queries (< 5 minutes)
CREATE INDEX IF NOT EXISTS idx_players_last_seen ON players(last_seen DESC);

-- 2. Allow status 'pending' / 'accepted' / 'declined' in player_friends
--    (column is already TEXT with no constraint - no ALTER needed)

-- 3. Add sent_at column so we can order pending requests by age
ALTER TABLE player_friends ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Backfill from created_at
UPDATE player_friends SET sent_at = created_at WHERE sent_at = NOW() AND created_at < NOW();

COMMENT ON COLUMN players.last_seen      IS 'Updated by auth middleware on every authenticated request. Used for online detection (< 5 min = online).';
COMMENT ON COLUMN player_friends.status  IS 'pending = request sent, not yet answered; accepted = both sides confirmed friends; declined = receiver rejected';
COMMENT ON COLUMN player_friends.sent_at IS 'When the friend request was originally sent';

-- 4. Clean up expired sessions (they accumulate forever without this)
--    This removes sessions that expired more than 1 day ago.
--    The server's periodic cleanup (server.js setInterval) handles live cleanup.
DELETE FROM sessions WHERE expires_at < NOW() - INTERVAL '1 day';
