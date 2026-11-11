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
