'use strict';

const { db } = require('../db');
const { logAdminAction } = require('./adminOps');

const catalogSeed = require('../data/catalog.json');
const titleDataSeed = require('../data/title_data.json');
const storesSeed = require('../data/stores.json');

// helpers

function rowToCatalogItem(row) {
  if (!row) return null;
  return {
    ItemId: row.item_id,
    ItemClass: row.item_class,
    CatalogVersion: row.catalog_version,
    DisplayName: row.display_name,
    Description: row.description,
    VirtualCurrencyPrices: row.virtual_currency_prices || {},
    RealCurrencyPrices: row.real_currency_prices || {},
    Tags: row.tags || [],
    CustomData: row.custom_data,
    IsStackable: row.is_stackable,
    IsTradable: row.is_tradable,
    ItemImageUrl: row.item_image_url,
    BundleContents: row.bundle_contents || null,
    ...(row.consumable != null ? { Consumable: row.consumable } : {}),
    UpdatedAt: row.updated_at,
  };
}

function rowToStoreItem(row) {
  return {
    ItemId: row.item_id,
    VirtualCurrencyPrices: row.virtual_currency_prices || {},
    RealCurrencyPrices: row.real_currency_prices || {},
    CustomData: row.custom_data,
    SortOrder: row.sort_order,
  };
}

function rowToAsset(row) {
  return {
    id: row.id,
    bundleKey: row.bundle_key,
    platform: row.platform,
    version: row.version,
    url: row.url,
    checksum: row.checksum,
    sizeBytes: row.size_bytes,
    itemId: row.item_id,
    active: row.active,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// -- one-time seed from the legacy JSON files (idempotent: only runs the
//    first time each table is empty, e.g. right after this migration is
//    first applied to an existing deployment) ------------------------------

async function seedIfEmpty() {
  if (!Array.isArray(catalogSeed)) {
    throw new TypeError('src/data/catalog.json must contain a JSON array.');
  }
  const catalogIds = new Set();
  for (const item of catalogSeed) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.ItemId !== 'string' || !item.ItemId.trim()) {
      throw new TypeError('Every catalog entry must be an object with a non-empty ItemId.');
    }
    if (catalogIds.has(item.ItemId)) {
      throw new Error(`Duplicate catalog ItemId: ${item.ItemId}`);
    }
    catalogIds.add(item.ItemId);
  }
  const { count: catalogCount } = await db.one('SELECT COUNT(*)::int AS count FROM catalog_items');
  if (!catalogCount) {
    await db.tx(async (tx) => {
      for (const item of catalogSeed) {
        await tx.query(
          `INSERT INTO catalog_items
             (item_id, item_class, catalog_version, display_name, description,
              virtual_currency_prices, real_currency_prices, tags, custom_data,
              is_stackable, is_tradable, item_image_url, consumable)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (item_id) DO NOTHING`,
          [
            item.ItemId,
            item.ItemClass || null,
            item.CatalogVersion || '1',
            item.DisplayName || item.ItemId,
            item.Description || null,
            JSON.stringify(item.VirtualCurrencyPrices || {}),
            JSON.stringify(item.RealCurrencyPrices || {}),
            JSON.stringify(item.Tags || []),
            item.CustomData || null,
            !!item.IsStackable,
            !!item.IsTradable,
            item.ItemImageUrl || null,
            item.Consumable ? JSON.stringify(item.Consumable) : null,
          ]
        );
      }
    });
  }

  const { count: storeCount } = await db.one('SELECT COUNT(*)::int AS count FROM stores');
  if (!storeCount) {
    await db.tx(async (tx) => {
      for (const [storeId, items] of Object.entries(storesSeed)) {
        await tx.query('INSERT INTO stores (store_id, display_name) VALUES ($1,$1) ON CONFLICT DO NOTHING', [storeId]);
        let sort = 0;
        for (const item of items) {
          await tx.query(
            `INSERT INTO store_items (store_id, item_id, virtual_currency_prices, real_currency_prices, custom_data, sort_order)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (store_id, item_id) DO NOTHING`,
            [
              storeId,
              item.ItemId,
              JSON.stringify(item.VirtualCurrencyPrices || {}),
              JSON.stringify(item.RealCurrencyPrices || {}),
              item.CustomData || null,
              sort++,
            ]
          );
        }
      }
    });
  }

  const { count: titleDataCount } = await db.one('SELECT COUNT(*)::int AS count FROM title_data');
  if (!titleDataCount) {
    await db.tx(async (tx) => {
      for (const [key, value] of Object.entries(titleDataSeed)) {
        await tx.query(
          'INSERT INTO title_data (key, value) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [key, typeof value === 'string' ? value : JSON.stringify(value)]
        );
      }
    });
  }
}

// live views used by the game-client-facing /Client routes

async function loadCatalog() {
  const rows = await db.all('SELECT * FROM catalog_items ORDER BY item_id');
  return rows.map(rowToCatalogItem);
}

async function loadStores() {
  const storeRows = await db.all('SELECT store_id FROM stores ORDER BY store_id');
  const itemRows = await db.all('SELECT * FROM store_items ORDER BY store_id, sort_order, item_id');
  const grouped = {};
  for (const s of storeRows) grouped[s.store_id] = [];
  for (const it of itemRows) {
    if (!grouped[it.store_id]) grouped[it.store_id] = [];
    grouped[it.store_id].push(rowToStoreItem(it));
  }
  return grouped;
}

async function loadTitleData() {
  const rows = await db.all('SELECT key, value FROM title_data');
  const out = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

async function refreshAppLocals(app) {
  const [catalog, stores, titleDataRows] = await Promise.all([loadCatalog(), loadStores(), loadTitleData()]);
  app.locals.catalog = catalog;
  app.locals.stores = stores;
  const photonAppId = titleDataRows.PhotonAppId || process.env.PHOTON_APP_ID || null;
  app.locals.titleData = photonAppId ? { ...titleDataRows, PhotonAppId: photonAppId } : titleDataRows;
}

// Catalog CRUD

async function listCatalogItems({ search = '', itemClass = '', limit = 100, offset = 0 } = {}) {
  const clauses = [];
  const params = [];
  if (search) {
    params.push(`%${search}%`);
    clauses.push(`(item_id ILIKE $${params.length} OR display_name ILIKE $${params.length})`);
  }
  if (itemClass) {
    params.push(itemClass);
    clauses.push(`item_class = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const countRow = await db.one(`SELECT COUNT(*)::int AS count FROM catalog_items ${where}`, params);
  const pageParams = [...params, limit, offset];
  const rows = await db.all(
    `SELECT * FROM catalog_items ${where} ORDER BY item_id LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
    pageParams
  );
  return { rows: rows.map(rowToCatalogItem), total: countRow.count };
}

async function getCatalogItem(itemId) {
  const row = await db.one('SELECT * FROM catalog_items WHERE item_id = $1', [itemId]);
  return rowToCatalogItem(row);
}

async function listItemClasses() {
  const rows = await db.all('SELECT DISTINCT item_class FROM catalog_items WHERE item_class IS NOT NULL ORDER BY item_class');
  return rows.map((r) => r.item_class);
}

async function upsertCatalogItem(payload, { adminEmail, actorIp, userAgent } = {}) {
  const itemId = String(payload.ItemId || '').trim();
  if (!itemId) throw new Error('ItemId is required');
  const existing = await db.one('SELECT * FROM catalog_items WHERE item_id = $1', [itemId]);
  const row = await db.one(
    `INSERT INTO catalog_items
       (item_id, item_class, catalog_version, display_name, description,
        virtual_currency_prices, real_currency_prices, tags, custom_data,
        is_stackable, is_tradable, item_image_url, bundle_contents, consumable, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
     ON CONFLICT (item_id) DO UPDATE SET
       item_class = EXCLUDED.item_class,
       catalog_version = EXCLUDED.catalog_version,
       display_name = EXCLUDED.display_name,
       description = EXCLUDED.description,
       virtual_currency_prices = EXCLUDED.virtual_currency_prices,
       real_currency_prices = EXCLUDED.real_currency_prices,
       tags = EXCLUDED.tags,
       custom_data = EXCLUDED.custom_data,
       is_stackable = EXCLUDED.is_stackable,
       is_tradable = EXCLUDED.is_tradable,
       item_image_url = EXCLUDED.item_image_url,
       bundle_contents = EXCLUDED.bundle_contents,
       consumable = EXCLUDED.consumable,
       updated_at = NOW()
     RETURNING *`,
    [
      itemId,
      payload.ItemClass || null,
      payload.CatalogVersion || '1',
      payload.DisplayName || itemId,
      payload.Description || null,
      JSON.stringify(payload.VirtualCurrencyPrices || {}),
      JSON.stringify(payload.RealCurrencyPrices || {}),
      JSON.stringify(payload.Tags || []),
      payload.CustomData || null,
      !!payload.IsStackable,
      !!payload.IsTradable,
      payload.ItemImageUrl || null,
      payload.BundleContents ? JSON.stringify(payload.BundleContents) : null,
      payload.Consumable ? JSON.stringify(payload.Consumable) : null,
    ]
  );
  await logAdminAction({
    adminEmail,
    action: existing ? 'catalog.update' : 'catalog.create',
    targetType: 'catalog_item',
    targetId: itemId,
    beforeState: rowToCatalogItem(existing),
    afterState: rowToCatalogItem(row),
    ipAddress: actorIp,
    userAgent,
  });
  return rowToCatalogItem(row);
}

async function deleteCatalogItem(itemId, { adminEmail, actorIp, userAgent } = {}) {
  const existing = await db.one('SELECT * FROM catalog_items WHERE item_id = $1', [itemId]);
  if (!existing) throw new Error('Item not found');
  await db.query('DELETE FROM catalog_items WHERE item_id = $1', [itemId]);
  await logAdminAction({
    adminEmail,
    action: 'catalog.delete',
    targetType: 'catalog_item',
    targetId: itemId,
    beforeState: rowToCatalogItem(existing),
    ipAddress: actorIp,
    userAgent,
  });
  return { deleted: true, itemId };
}

// Stores + Bundles CRUD

async function listStoresSummary() {
  const rows = await db.all(
    `SELECT s.store_id, s.display_name, s.updated_at, COUNT(si.id)::int AS item_count
     FROM stores s LEFT JOIN store_items si ON si.store_id = s.store_id
     GROUP BY s.store_id, s.display_name, s.updated_at
     ORDER BY s.store_id`
  );
  return rows;
}

async function getStore(storeId) {
  const store = await db.one('SELECT * FROM stores WHERE store_id = $1', [storeId]);
  if (!store) return null;
  const items = await db.all('SELECT * FROM store_items WHERE store_id = $1 ORDER BY sort_order, item_id', [storeId]);
  return { storeId: store.store_id, displayName: store.display_name, items: items.map(rowToStoreItem) };
}

async function upsertStore({ storeId, displayName }, { adminEmail, actorIp, userAgent } = {}) {
  const id = String(storeId || '').trim();
  if (!id) throw new Error('storeId is required');
  const existing = await db.one('SELECT * FROM stores WHERE store_id = $1', [id]);
  await db.query(
    `INSERT INTO stores (store_id, display_name, updated_at) VALUES ($1,$2,NOW())
     ON CONFLICT (store_id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = NOW()`,
    [id, displayName || id]
  );
  await logAdminAction({
    adminEmail,
    action: existing ? 'store.update' : 'store.create',
    targetType: 'store',
    targetId: id,
    ipAddress: actorIp,
    userAgent,
  });
  return getStore(id);
}

async function deleteStore(storeId, { adminEmail, actorIp, userAgent } = {}) {
  const existing = await db.one('SELECT * FROM stores WHERE store_id = $1', [storeId]);
  if (!existing) throw new Error('Store not found');
  await db.query('DELETE FROM stores WHERE store_id = $1', [storeId]);
  await logAdminAction({ adminEmail, action: 'store.delete', targetType: 'store', targetId: storeId, ipAddress: actorIp, userAgent });
  return { deleted: true, storeId };
}

async function upsertStoreItem({ storeId, itemId, virtualCurrencyPrices, realCurrencyPrices, customData, sortOrder }, { adminEmail, actorIp, userAgent } = {}) {
  if (!storeId || !itemId) throw new Error('storeId and itemId are required');
  const storeExists = await db.one('SELECT 1 FROM stores WHERE store_id = $1', [storeId]);
  if (!storeExists) throw new Error('Store not found - create the store first');
  await db.query(
    `INSERT INTO store_items (store_id, item_id, virtual_currency_prices, real_currency_prices, custom_data, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (store_id, item_id) DO UPDATE SET
       virtual_currency_prices = EXCLUDED.virtual_currency_prices,
       real_currency_prices = EXCLUDED.real_currency_prices,
       custom_data = EXCLUDED.custom_data,
       sort_order = EXCLUDED.sort_order`,
    [storeId, itemId, JSON.stringify(virtualCurrencyPrices || {}), JSON.stringify(realCurrencyPrices || {}), customData || null, sortOrder || 0]
  );
  await logAdminAction({ adminEmail, action: 'store.item.upsert', targetType: 'store_item', targetId: `${storeId}/${itemId}`, ipAddress: actorIp, userAgent });
  return getStore(storeId);
}

async function deleteStoreItem(storeId, itemId, { adminEmail, actorIp, userAgent } = {}) {
  await db.query('DELETE FROM store_items WHERE store_id = $1 AND item_id = $2', [storeId, itemId]);
  await logAdminAction({ adminEmail, action: 'store.item.delete', targetType: 'store_item', targetId: `${storeId}/${itemId}`, ipAddress: actorIp, userAgent });
  return getStore(storeId);
}

// Title Data CRUD

async function listTitleDataEntries() {
  const rows = await db.all('SELECT * FROM title_data ORDER BY key');
  return rows.map((r) => ({ key: r.key, value: r.value, updatedAt: r.updated_at }));
}

async function setTitleDataKey({ key, value }, { adminEmail, actorIp, userAgent } = {}) {
  const k = String(key || '').trim();
  if (!k) throw new Error('key is required');
  const existing = await db.one('SELECT value FROM title_data WHERE key = $1', [k]);
  await db.query(
    `INSERT INTO title_data (key, value, updated_at) VALUES ($1,$2,NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [k, value == null ? null : String(value)]
  );
  await logAdminAction({
    adminEmail,
    action: existing ? 'titledata.update' : 'titledata.create',
    targetType: 'title_data',
    targetId: k,
    beforeState: existing ? { value: existing.value } : null,
    afterState: { value },
    ipAddress: actorIp,
    userAgent,
  });
  return { key: k, value };
}

async function deleteTitleDataKey(key, { adminEmail, actorIp, userAgent } = {}) {
  const existing = await db.one('SELECT value FROM title_data WHERE key = $1', [key]);
  if (!existing) throw new Error('Key not found');
  await db.query('DELETE FROM title_data WHERE key = $1', [key]);
  await logAdminAction({ adminEmail, action: 'titledata.delete', targetType: 'title_data', targetId: key, beforeState: existing, ipAddress: actorIp, userAgent });
  return { deleted: true, key };
}

// Asset Bundles CRUD

async function listAssets({ itemId = '', activeOnly = false } = {}) {
  const clauses = [];
  const params = [];
  if (itemId) { params.push(itemId); clauses.push(`item_id = $${params.length}`); }
  if (activeOnly) clauses.push('active = true');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await db.all(`SELECT * FROM asset_bundles ${where} ORDER BY bundle_key`, params);
  return rows.map(rowToAsset);
}

async function upsertAsset(payload, { adminEmail, actorIp, userAgent } = {}) {
  const bundleKey = String(payload.bundleKey || '').trim();
  if (!bundleKey) throw new Error('bundleKey is required');
  if (!payload.url) throw new Error('url is required');
  const existing = await db.one('SELECT * FROM asset_bundles WHERE bundle_key = $1', [bundleKey]);
  const row = await db.one(
    `INSERT INTO asset_bundles (bundle_key, platform, version, url, checksum, size_bytes, item_id, active, notes, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
     ON CONFLICT (bundle_key) DO UPDATE SET
       platform = EXCLUDED.platform, version = EXCLUDED.version, url = EXCLUDED.url,
       checksum = EXCLUDED.checksum, size_bytes = EXCLUDED.size_bytes, item_id = EXCLUDED.item_id,
       active = EXCLUDED.active, notes = EXCLUDED.notes, updated_at = NOW()
     RETURNING *`,
    [
      bundleKey,
      payload.platform || 'all',
      payload.version || null,
      payload.url,
      payload.checksum || null,
      payload.sizeBytes || null,
      payload.itemId || null,
      payload.active !== false,
      payload.notes || null,
    ]
  );
  await logAdminAction({
    adminEmail,
    action: existing ? 'asset.update' : 'asset.create',
    targetType: 'asset_bundle',
    targetId: bundleKey,
    beforeState: existing ? rowToAsset(existing) : null,
    afterState: rowToAsset(row),
    ipAddress: actorIp,
    userAgent,
  });
  return rowToAsset(row);
}

async function deleteAsset(bundleKey, { adminEmail, actorIp, userAgent } = {}) {
  const existing = await db.one('SELECT * FROM asset_bundles WHERE bundle_key = $1', [bundleKey]);
  if (!existing) throw new Error('Asset bundle not found');
  await db.query('DELETE FROM asset_bundles WHERE bundle_key = $1', [bundleKey]);
  await logAdminAction({ adminEmail, action: 'asset.delete', targetType: 'asset_bundle', targetId: bundleKey, beforeState: rowToAsset(existing), ipAddress: actorIp, userAgent });
  return { deleted: true, bundleKey };
}

module.exports = {
  seedIfEmpty,
  refreshAppLocals,
  loadCatalog,
  loadStores,
  loadTitleData,
  listCatalogItems,
  getCatalogItem,
  listItemClasses,
  upsertCatalogItem,
  deleteCatalogItem,
  listStoresSummary,
  getStore,
  upsertStore,
  deleteStore,
  upsertStoreItem,
  deleteStoreItem,
  listTitleDataEntries,
  setTitleDataKey,
  deleteTitleDataKey,
  listAssets,
  upsertAsset,
  deleteAsset,
};
