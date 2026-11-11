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
