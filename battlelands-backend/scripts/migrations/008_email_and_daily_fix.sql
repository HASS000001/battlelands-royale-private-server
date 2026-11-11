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
