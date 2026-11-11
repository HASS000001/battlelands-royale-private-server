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
