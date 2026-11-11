const { randomUUID } = require('crypto');
const { db } = require('../db');

const DEFAULT_ITEMS = [
  { itemId: 'StarterCharacter', itemClass: 'Character' },
  { itemId: 'StarterParachute', itemClass: 'Parachute' },
  { itemId: 'StarterFootstep', itemClass: 'Footstep' },
  { itemId: 'StarterMelee', itemClass: 'Melee' },
  { itemId: 'StarterAnimation', itemClass: 'Animation' },
  { itemId: 'StarterFlag', itemClass: 'BattleFlag' }
];

const DEFAULT_STATS = ['Wins', 'XP', 'Kills', 'Matches'];

async function initializeNewPlayer(playFabId, origination, catalog) {
  const displayName = `Player${playFabId.slice(0, 6)}`;
  await db.query(
    `INSERT INTO players (playfab_id, display_name, origination)
     VALUES ($1, $2, $3)`,
    [playFabId, displayName, origination]
  );

  const now = new Date().toISOString();
  for (const item of DEFAULT_ITEMS) {
    const catalogEntry = catalog.find((entry) => entry.ItemId === item.itemId) || {};
    await db.query(
      `INSERT INTO inventory
        (instance_id, playfab_id, item_id, item_class, catalog_version, display_name, purchase_date)
       VALUES ($1, $2, $3, $4, '1', $5, $6)`,
      [randomUUID(), playFabId, item.itemId, item.itemClass, catalogEntry.DisplayName || item.itemId, now]
    );
  }

  for (const statisticName of DEFAULT_STATS) {
    await db.query(
      `INSERT INTO player_statistics (playfab_id, statistic_name, value, version)
       VALUES ($1, $2, 0, 0)`,
      [playFabId, statisticName]
    );
  }

  const skinInventory = Object.fromEntries(
    DEFAULT_ITEMS.map(({ itemId }) => [itemId, { BattlePoints: 0, Level: 1, UnlockedAltSkins: [] }])
  );
  await db.query(
    `INSERT INTO user_readonly_data (playfab_id, key, value, last_updated)
     VALUES
       ($1, 'SkinInventory', $2, $3),
       ($1, 'BattlePassState', '{}', $3),
       ($1, 'ConsumableInventory', '{}', $3)`,
    [playFabId, JSON.stringify(skinInventory), now]
  );
}

module.exports = { initializeNewPlayer, DEFAULT_ITEMS };
