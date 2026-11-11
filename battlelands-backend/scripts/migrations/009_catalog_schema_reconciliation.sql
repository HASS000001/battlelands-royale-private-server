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
