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
