CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- The init script is executed against the battlelands database. PostgreSQL's
-- psql meta-command switches back after creating the separate Metabase store.
SELECT 'CREATE DATABASE metabase'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'metabase')\gexec

CREATE TABLE IF NOT EXISTS players (
  playfab_id CHAR(16) PRIMARY KEY,
  custom_id TEXT UNIQUE,
  android_id TEXT UNIQUE,
  ios_id TEXT UNIQUE,
  email TEXT UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  origination TEXT NOT NULL DEFAULT 'Custom',
  banned BOOLEAN NOT NULL DEFAULT FALSE,
  banned_until TIMESTAMPTZ,
  ban_reason TEXT,
  ban_ip INET,
  ban_device_id TEXT,
  vc_ge INTEGER NOT NULL DEFAULT 0,
  vc_bb INTEGER NOT NULL DEFAULT 0,
  vc_dt INTEGER NOT NULL DEFAULT 0,
  vc_bp INTEGER NOT NULL DEFAULT 0
);


CREATE INDEX IF NOT EXISTS idx_players_display_name_trgm ON players USING GIN (display_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_players_last_login ON players(last_login DESC);
CREATE INDEX IF NOT EXISTS idx_players_created_at ON players(created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  session_ticket TEXT PRIMARY KEY,
  playfab_id CHAR(16) NOT NULL REFERENCES players(playfab_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  valid BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_sessions_playfab ON sessions(playfab_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS inventory (
  instance_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  playfab_id CHAR(16) NOT NULL REFERENCES players(playfab_id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  item_class TEXT,
  catalog_version TEXT NOT NULL DEFAULT '1',
  display_name TEXT,
  purchase_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unit_price INTEGER NOT NULL DEFAULT 0,
  remaining_uses INTEGER,
  custom_data JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_inventory_playfab ON inventory(playfab_id);

CREATE TABLE IF NOT EXISTS user_data (
  playfab_id CHAR(16) NOT NULL REFERENCES players(playfab_id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  permission TEXT NOT NULL DEFAULT 'Public',
  PRIMARY KEY (playfab_id, key)
);

CREATE TABLE IF NOT EXISTS user_readonly_data (
  playfab_id CHAR(16) NOT NULL REFERENCES players(playfab_id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (playfab_id, key)
);

CREATE TABLE IF NOT EXISTS player_statistics (
  playfab_id CHAR(16) NOT NULL REFERENCES players(playfab_id) ON DELETE CASCADE,
  statistic_name TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (playfab_id, statistic_name)
);

CREATE TABLE IF NOT EXISTS leaderboard_entries (
  statistic_name TEXT NOT NULL,
  playfab_id CHAR(16) NOT NULL REFERENCES players(playfab_id) ON DELETE CASCADE,
  display_name TEXT,
  stat_value INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (statistic_name, playfab_id)
);
CREATE INDEX IF NOT EXISTS idx_leaderboard_stat ON leaderboard_entries(statistic_name, stat_value DESC);

CREATE TABLE IF NOT EXISTS player_friends (
  playfab_id CHAR(16) NOT NULL REFERENCES players(playfab_id) ON DELETE CASCADE,
  friend_playfab_id CHAR(16) NOT NULL REFERENCES players(playfab_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'accepted',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (playfab_id, friend_playfab_id)
);
CREATE INDEX IF NOT EXISTS idx_player_friends_friend ON player_friends(friend_playfab_id);
CREATE INDEX IF NOT EXISTS idx_player_friends_pair ON player_friends(playfab_id, friend_playfab_id, status);

CREATE TABLE IF NOT EXISTS requests_log (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  method VARCHAR(10),
  path VARCHAR(255),
  playfab_id CHAR(16),
  duration_ms INTEGER,
  status_code INTEGER,
  ip_address INET
);
CREATE INDEX IF NOT EXISTS idx_requests_log_ts ON requests_log(ts DESC);

CREATE TABLE IF NOT EXISTS admin_users (
  email TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  totp_secret TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'superadmin',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login TIMESTAMPTZ,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS admin_refresh_tokens (
  jti TEXT PRIMARY KEY,
  email TEXT NOT NULL REFERENCES admin_users(email) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_admin_refresh_email ON admin_refresh_tokens(email);

CREATE TABLE IF NOT EXISTS admin_bans (
  id UUID PRIMARY KEY,
  playfab_id CHAR(16),
  ip_address INET,
  device_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  banned_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_admin_bans_playfab ON admin_bans(playfab_id);
CREATE INDEX IF NOT EXISTS idx_admin_bans_ip ON admin_bans(ip_address);
CREATE INDEX IF NOT EXISTS idx_admin_bans_device ON admin_bans(device_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  admin_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  before_state JSONB,
  after_state JSONB,
  metadata JSONB,
  ip_address INET,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_admin ON audit_log(admin_email, ts DESC);


-- Application tables and schema updates.


-- 001_feature_flags.sql

CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT,
  description TEXT
);

-- 002_economy.sql

-- Economy management: catalog, stores, title data, and asset bundles
-- become DB-backed and editable from the admin dashboard instead of
-- static JSON files baked into the image.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS catalog_items (
  item_id TEXT PRIMARY KEY,
  item_class TEXT,
  catalog_version TEXT NOT NULL DEFAULT '1',
  display_name TEXT,
  description TEXT,
  virtual_currency_prices JSONB NOT NULL DEFAULT '{}'::jsonb,
  real_currency_prices JSONB NOT NULL DEFAULT '{}'::jsonb,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  custom_data TEXT,
  is_stackable BOOLEAN NOT NULL DEFAULT false,
  is_tradable BOOLEAN NOT NULL DEFAULT false,
  item_image_url TEXT,
  bundle_contents JSONB,
  consumable JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_catalog_items_class ON catalog_items(item_class);
CREATE INDEX IF NOT EXISTS idx_catalog_items_version ON catalog_items(catalog_version);
CREATE INDEX IF NOT EXISTS idx_catalog_items_name_trgm ON catalog_items USING gin (display_name gin_trgm_ops);

CREATE TABLE IF NOT EXISTS stores (
  store_id TEXT PRIMARY KEY,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS store_items (
  id BIGSERIAL PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  virtual_currency_prices JSONB NOT NULL DEFAULT '{}'::jsonb,
  real_currency_prices JSONB NOT NULL DEFAULT '{}'::jsonb,
  custom_data TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  UNIQUE(store_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_store_items_store ON store_items(store_id, sort_order);

CREATE TABLE IF NOT EXISTS title_data (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Asset bundle references (AssetBundle-equivalent): downloadable content
-- packages (skins packs, new tournaments/seasons, maps, etc.) that the
-- client fetches by key. Optionally linked to a catalog item so granting
-- the item implies unlocking the bundle content.
CREATE TABLE IF NOT EXISTS asset_bundles (
  id BIGSERIAL PRIMARY KEY,
  bundle_key TEXT UNIQUE NOT NULL,
  platform TEXT NOT NULL DEFAULT 'all',
  version TEXT,
  url TEXT NOT NULL,
  checksum TEXT,
  size_bytes BIGINT,
  item_id TEXT REFERENCES catalog_items(item_id) ON DELETE SET NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_asset_bundles_item ON asset_bundles(item_id);
CREATE INDEX IF NOT EXISTS idx_asset_bundles_active ON asset_bundles(active);

-- CloudScript call history: every ExecuteCloudScript / admin console
-- test call, so the console can show real recent-calls / success-rate
-- stats instead of nothing.
CREATE TABLE IF NOT EXISTS cloudscript_calls (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  function_name TEXT NOT NULL,
  player_id TEXT,
  admin_email TEXT,
  source TEXT NOT NULL DEFAULT 'client',
  parameters JSONB,
  result JSONB,
  success BOOLEAN NOT NULL,
  error_message TEXT,
  duration_ms INT
);
CREATE INDEX IF NOT EXISTS idx_cloudscript_calls_ts ON cloudscript_calls(ts DESC);
CREATE INDEX IF NOT EXISTS idx_cloudscript_calls_fn ON cloudscript_calls(function_name, ts DESC);

-- 003_loot_and_events.sql

-- Loot Tables
-- A loot table is a named container of weighted items. When "opened" by a
-- client (or triggered by a CloudScript / event), the engine rolls once per
-- roll-count and returns items to the player's inventory.

CREATE TABLE IF NOT EXISTS loot_tables (
  id           BIGSERIAL   PRIMARY KEY,
  table_key    TEXT        UNIQUE NOT NULL,
  display_name TEXT        NOT NULL,
  roll_count   INT         NOT NULL DEFAULT 1,   -- rolls per open
  notes        TEXT,
  active       BOOLEAN     NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loot_items (
  id           BIGSERIAL   PRIMARY KEY,
  table_key    TEXT        NOT NULL REFERENCES loot_tables(table_key) ON DELETE CASCADE,
  item_id      TEXT        NOT NULL REFERENCES catalog_items(item_id) ON DELETE CASCADE,
  weight       INT         NOT NULL DEFAULT 100, -- relative probability weight
  min_quantity INT         NOT NULL DEFAULT 1,
  max_quantity INT         NOT NULL DEFAULT 1,
  UNIQUE (table_key, item_id)
);
CREATE INDEX IF NOT EXISTS idx_loot_items_table ON loot_items(table_key);

-- Economy Events (Sales / Boosts / Bonus windows)
-- An economy event can modify catalog item prices or grant bonus virtual
-- currency for a time window. The game client queries active events and applies
-- the modifiers in the UI / on purchase.

CREATE TABLE IF NOT EXISTS economy_events (
  id           BIGSERIAL   PRIMARY KEY,
  event_key    TEXT        UNIQUE NOT NULL,
  display_name TEXT        NOT NULL,
  event_type   TEXT        NOT NULL DEFAULT 'sale',  -- sale | bonus_vc | double_xp | custom
  starts_at    TIMESTAMPTZ NOT NULL,
  ends_at      TIMESTAMPTZ NOT NULL,
  -- JSON payload: depends on type.
  -- sale:     { "items": {"ItemId": discountPct}, "stores": ["StoreId"] }
  -- bonus_vc: { "currency": "GE", "multiplier": 2 }
  -- custom:   free-form JSON shown to client via GetTitleData
  payload      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  active       BOOLEAN     NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_economy_events_window ON economy_events(starts_at, ends_at, active);

-- Async Job Log
-- Every queued job (bulk-currency, bulk-item, backup, wipe-all, etc.) writes
-- here so admins can see status, progress, and errors without polling.

CREATE TABLE IF NOT EXISTS job_log (
  id           BIGSERIAL   PRIMARY KEY,
  job_id       TEXT        UNIQUE NOT NULL,
  job_type     TEXT        NOT NULL,   -- bulk_currency | bulk_item | backup | restore | wipe_all
  status       TEXT        NOT NULL DEFAULT 'queued',  -- queued | running | done | failed
  queued_by    TEXT,                   -- admin email
  payload      JSONB,                  -- input params (no passwords)
  result       JSONB,                  -- { processed, failed, errors[] }
  error        TEXT,
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_job_log_status ON job_log(status, created_at DESC);

-- 004_analytics.sql

-- Currency Transaction Log
-- Every admin-side and game-side currency change is logged here.
-- Powers the Analytics -> Revenue page without re-reading audit_log JSON.

CREATE TABLE IF NOT EXISTS currency_tx (
  id          BIGSERIAL   PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  playfab_id  TEXT        NOT NULL,
  currency    TEXT        NOT NULL,
  delta       INT         NOT NULL,
  balance_after INT,
  source      TEXT        NOT NULL DEFAULT 'admin', -- admin | game | purchase | event
  reason      TEXT
);
CREATE INDEX IF NOT EXISTS idx_ctx_ts       ON currency_tx(ts DESC);
CREATE INDEX IF NOT EXISTS idx_ctx_player   ON currency_tx(playfab_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_ctx_currency ON currency_tx(currency, ts DESC);

-- Player Registration Stats View
-- Pre-built daily aggregates (refreshed by query, no materialized view needed)
-- Analytics page queries this directly.

-- nothing to CREATE here; we'll query players table by date in the service.

-- 005_friends.sql

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

-- 006_reports.sql

-- ============================================================
-- 006_reports.sql - Dedicated player reports table
-- ============================================================

-- Previously ReportPlayer wrote into requests_log (wrong table,
-- unqueryable from Admin UI). This migration adds the correct table.

CREATE TABLE IF NOT EXISTS player_reports (
  id                  BIGSERIAL   PRIMARY KEY,
  ts                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reporter_playfab_id TEXT        NOT NULL,
  reported_playfab_id TEXT        NOT NULL,
  reason              TEXT        NOT NULL DEFAULT 'Unknown',
  comment             TEXT,
  match_context       JSONB,      -- optional: placement, kills, skin used
  status              TEXT        NOT NULL DEFAULT 'open',   -- open | reviewed | dismissed
  reviewed_by         TEXT,       -- admin email
  reviewed_at         TIMESTAMPTZ,
  review_notes        TEXT
);

CREATE INDEX IF NOT EXISTS idx_reports_reported  ON player_reports(reported_playfab_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_reports_reporter  ON player_reports(reporter_playfab_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_reports_status    ON player_reports(status, ts DESC);
CREATE INDEX IF NOT EXISTS idx_reports_ts        ON player_reports(ts DESC);

COMMENT ON TABLE player_reports IS
  'Player-submitted reports (cheating, abuse, etc.). Replaces the incorrect use of requests_log in ReportPlayer CloudScript handler.';

-- 007_discord_link.sql

-- Migration 007 - Discord Account Linking

-- 1. Add discord columns to players
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS discord_id      TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS discord_tag     TEXT,
  ADD COLUMN IF NOT EXISTS discord_linked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_players_discord ON players(discord_id);

-- 2. Temporary link codes (player runs /link in Discord -> gets a code -> enters in-game)
CREATE TABLE IF NOT EXISTS discord_link_codes (
  code          TEXT         PRIMARY KEY,           -- e.g. "BL-A3F7"
  discord_id    TEXT         NOT NULL,
  discord_tag   TEXT         NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW() + INTERVAL '15 minutes',
  claimed       BOOLEAN      NOT NULL DEFAULT FALSE,
  claimed_by    CHAR(16),                           -- playfab_id that claimed it
  claimed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_discord_link_codes_discord ON discord_link_codes(discord_id);

-- 3. Unlink confirmation codes
CREATE TABLE IF NOT EXISTS discord_unlink_codes (
  code          TEXT         PRIMARY KEY,
  discord_id    TEXT         NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW() + INTERVAL '5 minutes',
  used          BOOLEAN      NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_discord_unlink_discord ON discord_unlink_codes(discord_id);

-- 4. Daily reward claim tracking
CREATE TABLE IF NOT EXISTS discord_daily_claims (
  discord_id    TEXT         NOT NULL,
  claim_date    DATE         NOT NULL DEFAULT CURRENT_DATE,
  ge_awarded    INTEGER      NOT NULL DEFAULT 0,
  bb_awarded    INTEGER      NOT NULL DEFAULT 0,
  dt_awarded    INTEGER      NOT NULL DEFAULT 0,
  bp_awarded    INTEGER      NOT NULL DEFAULT 0,
  item_awarded  TEXT,
  claimed_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (discord_id, claim_date)
);

-- 008_email_and_daily_fix.sql

-- Migration 008: Email verification, anti-alt system, daily fix

-- Email verification columns on players
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS email_normalized   TEXT   UNIQUE,
  ADD COLUMN IF NOT EXISTS email_verified     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS setup_complete     BOOLEAN NOT NULL DEFAULT FALSE;

-- Email verification codes (OTP)
CREATE TABLE IF NOT EXISTS email_verify_codes (
  id          SERIAL PRIMARY KEY,
  playfab_id  TEXT NOT NULL REFERENCES players(playfab_id) ON DELETE CASCADE,
  code        CHAR(6) NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes',
  used        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_evc_playfab ON email_verify_codes(playfab_id);

-- Fix daily: change cooldown from date-based to 12h per playfab_id
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS last_daily_at  TIMESTAMPTZ;

-- Mark existing linked players as setup_complete
UPDATE players
  SET setup_complete = TRUE
  WHERE discord_id IS NOT NULL AND email IS NOT NULL;


CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- 009_catalog_schema_reconciliation.sql
-- Bring older catalog tables up to the columns used by the current application.
CREATE TABLE IF NOT EXISTS catalog_items (
  item_id TEXT PRIMARY KEY,
  item_class TEXT,
  catalog_version TEXT NOT NULL DEFAULT '1',
  display_name TEXT,
  description TEXT,
  virtual_currency_prices JSONB NOT NULL DEFAULT '{}'::jsonb,
  real_currency_prices JSONB NOT NULL DEFAULT '{}'::jsonb,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  custom_data TEXT,
  is_stackable BOOLEAN NOT NULL DEFAULT FALSE,
  is_tradable BOOLEAN NOT NULL DEFAULT FALSE,
  item_image_url TEXT,
  bundle_contents JSONB,
  consumable JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS item_class TEXT;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS catalog_version TEXT NOT NULL DEFAULT '1';
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS virtual_currency_prices JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS real_currency_prices JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS custom_data TEXT;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS is_stackable BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS is_tradable BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS item_image_url TEXT;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS bundle_contents JSONB;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS consumable JSONB;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_catalog_items_class ON catalog_items(item_class);
CREATE INDEX IF NOT EXISTS idx_catalog_items_version ON catalog_items(catalog_version);
CREATE INDEX IF NOT EXISTS idx_catalog_items_name_trgm ON catalog_items USING GIN (display_name gin_trgm_ops);

INSERT INTO schema_migrations (filename)
VALUES
  ('001_feature_flags.sql'),
  ('002_economy.sql'),
  ('003_loot_and_events.sql'),
  ('004_analytics.sql'),
  ('005_friends.sql'),
  ('006_reports.sql'),
  ('007_discord_link.sql'),
  ('008_email_and_daily_fix.sql'),
  ('009_catalog_schema_reconciliation.sql')
ON CONFLICT (filename) DO NOTHING;
