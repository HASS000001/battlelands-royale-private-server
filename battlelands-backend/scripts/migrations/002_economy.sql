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
