'use strict';

const { db } = require('../db');
const { logAdminAction } = require('./adminOps');

// Loot Tables

async function listLootTables() {
  const tables = await db.all(
    `SELECT lt.*, COUNT(li.id)::int AS item_count
     FROM loot_tables lt
     LEFT JOIN loot_items li ON li.table_key = lt.table_key
     GROUP BY lt.id ORDER BY lt.table_key`
  );
  return tables;
}

async function getLootTable(tableKey) {
  const table = await db.one('SELECT * FROM loot_tables WHERE table_key = $1', [tableKey]);
  if (!table) return null;
  const items = await db.all(
    `SELECT li.*, ci.display_name
     FROM loot_items li
     JOIN catalog_items ci ON ci.item_id = li.item_id
     WHERE li.table_key = $1
     ORDER BY li.weight DESC, li.item_id`,
    [tableKey]
  );
  const totalWeight = items.reduce((s, i) => s + i.weight, 0);
  return {
    ...table,
    items: items.map((i) => ({ ...i, chance: totalWeight ? ((i.weight / totalWeight) * 100).toFixed(1) + '%' : '0%' })),
    totalWeight,
  };
}

async function upsertLootTable({ tableKey, displayName, rollCount = 1, notes = null, active = true }, { adminEmail, actorIp, userAgent } = {}) {
  const key = String(tableKey || '').trim();
  if (!key) throw new Error('tableKey is required');
  const existing = await db.one('SELECT id FROM loot_tables WHERE table_key = $1', [key]);
  await db.query(
    `INSERT INTO loot_tables (table_key, display_name, roll_count, notes, active, updated_at)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (table_key) DO UPDATE SET
       display_name=$2, roll_count=$3, notes=$4, active=$5, updated_at=NOW()`,
    [key, displayName || key, rollCount, notes, active !== false]
  );
  await logAdminAction({ adminEmail, action: existing ? 'loot_table.update' : 'loot_table.create', targetType: 'loot_table', targetId: key, ipAddress: actorIp, userAgent });
  return getLootTable(key);
}

async function deleteLootTable(tableKey, { adminEmail, actorIp, userAgent } = {}) {
  const existing = await db.one('SELECT id FROM loot_tables WHERE table_key = $1', [tableKey]);
  if (!existing) throw new Error('Loot table not found');
  await db.query('DELETE FROM loot_tables WHERE table_key = $1', [tableKey]);
  await logAdminAction({ adminEmail, action: 'loot_table.delete', targetType: 'loot_table', targetId: tableKey, ipAddress: actorIp, userAgent });
  return { deleted: true, tableKey };
}

async function upsertLootItem({ tableKey, itemId, weight = 100, minQuantity = 1, maxQuantity = 1 }, { adminEmail, actorIp, userAgent } = {}) {
  if (!tableKey || !itemId) throw new Error('tableKey and itemId are required');
  const tableExists = await db.one('SELECT id FROM loot_tables WHERE table_key = $1', [tableKey]);
  if (!tableExists) throw new Error('Loot table not found');
  const itemExists = await db.one('SELECT item_id FROM catalog_items WHERE item_id = $1', [itemId]);
  if (!itemExists) throw new Error(`Catalog item "${itemId}" not found`);
  await db.query(
    `INSERT INTO loot_items (table_key, item_id, weight, min_quantity, max_quantity)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (table_key, item_id) DO UPDATE SET weight=$3, min_quantity=$4, max_quantity=$5`,
    [tableKey, itemId, Math.max(1, Number(weight) || 100), Math.max(1, Number(minQuantity) || 1), Math.max(1, Number(maxQuantity) || 1)]
  );
  await logAdminAction({ adminEmail, action: 'loot_item.upsert', targetType: 'loot_item', targetId: `${tableKey}/${itemId}`, ipAddress: actorIp, userAgent });
  return getLootTable(tableKey);
}

async function deleteLootItem(tableKey, itemId, { adminEmail, actorIp, userAgent } = {}) {
  await db.query('DELETE FROM loot_items WHERE table_key=$1 AND item_id=$2', [tableKey, itemId]);
  await logAdminAction({ adminEmail, action: 'loot_item.delete', targetType: 'loot_item', targetId: `${tableKey}/${itemId}`, ipAddress: actorIp, userAgent });
  return getLootTable(tableKey);
}

// Economy Events

async function listEvents({ activeOnly = false } = {}) {
  const where = activeOnly ? `WHERE active = true AND ends_at > NOW()` : '';
  return db.all(`SELECT * FROM economy_events ${where} ORDER BY starts_at DESC`);
}

async function getEvent(eventKey) {
  return db.one('SELECT * FROM economy_events WHERE event_key = $1', [eventKey]);
}

async function upsertEvent({ eventKey, displayName, eventType = 'sale', startsAt, endsAt, payload = {}, active = true }, { adminEmail, actorIp, userAgent } = {}) {
  const key = String(eventKey || '').trim();
  if (!key) throw new Error('eventKey is required');
  if (!startsAt || !endsAt) throw new Error('startsAt and endsAt are required');
  if (new Date(endsAt) <= new Date(startsAt)) throw new Error('endsAt must be after startsAt');
  const existing = await db.one('SELECT id FROM economy_events WHERE event_key=$1', [key]);
  const row = await db.one(
    `INSERT INTO economy_events (event_key, display_name, event_type, starts_at, ends_at, payload, active, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (event_key) DO UPDATE SET
       display_name=$2, event_type=$3, starts_at=$4, ends_at=$5, payload=$6, active=$7, updated_at=NOW()
     RETURNING *`,
    [key, displayName || key, eventType, startsAt, endsAt, JSON.stringify(payload), active !== false]
  );
  await logAdminAction({ adminEmail, action: existing ? 'event.update' : 'event.create', targetType: 'economy_event', targetId: key, ipAddress: actorIp, userAgent });
  return row;
}

async function deleteEvent(eventKey, { adminEmail, actorIp, userAgent } = {}) {
  const existing = await db.one('SELECT id FROM economy_events WHERE event_key=$1', [eventKey]);
  if (!existing) throw new Error('Event not found');
  await db.query('DELETE FROM economy_events WHERE event_key=$1', [eventKey]);
  await logAdminAction({ adminEmail, action: 'event.delete', targetType: 'economy_event', targetId: eventKey, ipAddress: actorIp, userAgent });
  return { deleted: true, eventKey };
}

async function getActiveEvents() {
  return db.all(
    `SELECT event_key, display_name, event_type, starts_at, ends_at, payload
     FROM economy_events
     WHERE active = true AND starts_at <= NOW() AND ends_at >= NOW()
     ORDER BY starts_at`
  );
}

module.exports = {
  listLootTables, getLootTable, upsertLootTable, deleteLootTable,
  upsertLootItem, deleteLootItem,
  listEvents, getEvent, upsertEvent, deleteEvent, getActiveEvents,
};
