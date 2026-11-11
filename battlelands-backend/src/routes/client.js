const express = require('express');
const { randomUUID } = require('crypto');
const { db, redis } = require('../db');
const auth = require('../middleware/auth');
const { loginLimiter, apiLimiter } = require('../middleware/rateLimiter');
const { ok, stub, fail } = require('../helpers/response');
const { generatePlayFabId, createSession } = require('../services/auth');
const { initializeNewPlayer } = require('../services/player');
const { executeCloudScript } = require('../services/cloudscript');
const { getActiveBan } = require('../services/bans');
const { listAssets } = require('../services/economy');
const { getActiveEvents, getLootTable } = require('../services/lootEvents');
const { logCurrencyTx } = require('../services/analytics');
const { sendVerificationCode, verifyEmailCode, sendLoginOtp } = require('../services/emailService');

const router = express.Router();
const CURRENCY_COLUMNS = { GE: 'vc_ge', BB: 'vc_bb', DT: 'vc_dt', BP: 'vc_bp' };


function normalizeJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function ownCharacter(item) {
  const className = String(item.item_class || '').toLowerCase();
  const itemId = String(item.item_id || '');
  return className === 'character' || /character$/i.test(itemId) || /startercharacter/i.test(itemId);
}

async function getPlayerSnapshot(playFabId) {
  const [player, inventory, userDataRows, readonlyRows, statsRows, leaderboardRows] = await Promise.all([
    db.one(
      'SELECT playfab_id, display_name, vc_ge, vc_bb, vc_dt, vc_bp, created_at, last_login, origination, banned, banned_until, ban_reason, ban_ip, ban_device_id FROM players WHERE playfab_id = $1',
      [playFabId]
    ),
    db.all('SELECT * FROM inventory WHERE playfab_id = $1 ORDER BY purchase_date DESC', [playFabId]),
    db.all('SELECT * FROM user_data WHERE playfab_id = $1', [playFabId]),
    db.all('SELECT * FROM user_readonly_data WHERE playfab_id = $1', [playFabId]),
    db.all('SELECT * FROM player_statistics WHERE playfab_id = $1', [playFabId]),
    db.all('SELECT * FROM leaderboard_entries WHERE playfab_id = $1', [playFabId]),
  ]);
  return { player, inventory, userDataRows, readonlyRows, statsRows, leaderboardRows };
}

function buildDataMap(rows) {
  return Object.fromEntries(rows.map((row) => [
    row.key,
    { Value: normalizeJson(row.value, row.value), LastUpdated: row.last_updated, Permission: row.permission || 'Public' }
  ]));
}

function buildReadonlyMap(rows) {
  return Object.fromEntries(rows.map((row) => [
    row.key,
    { Value: normalizeJson(row.value, row.value), LastUpdated: row.last_updated, Permission: 'Private' }
  ]));
}

function buildCharacterList(inventory, readonlyRows) {
  const skinInventory = normalizeJson(readonlyRows.find((row) => row.key === 'SkinInventory')?.value, {});
  const characters = inventory.filter(ownCharacter).map((row) => {
    const skin = skinInventory?.[row.item_id] || {};
    return {
      CharacterId: row.item_id,
      CharacterName: row.display_name || row.item_id,
      CharacterType: row.item_class || 'Character',
      CatalogVersion: row.catalog_version,
      IsDefault: row.item_id === 'StarterCharacter',
      Level: skin.Level || 1,
      BattlePoints: skin.BattlePoints || 0,
      UnlockedAltSkins: Array.isArray(skin.UnlockedAltSkins) ? skin.UnlockedAltSkins : [],
      ItemInstanceId: row.instance_id,
      CreatedAt: row.purchase_date
    };
  });
  if (!characters.length) {
    characters.push({
      CharacterId: 'StarterCharacter',
      CharacterName: 'StarterCharacter',
      CharacterType: 'Character',
      CatalogVersion: '1',
      IsDefault: true,
      Level: 1,
      BattlePoints: 0,
      UnlockedAltSkins: [],
      ItemInstanceId: null,
      CreatedAt: null
    });
  }
  return characters;
}


const ONLINE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

function normalizeFriendRow(row) {
  const lastSeen = row.last_seen || row.last_login;
  const isOnline = lastSeen
    ? Date.now() - new Date(lastSeen).getTime() < ONLINE_THRESHOLD_MS
    : false;
  return {
    FriendPlayFabId:   row.playfab_id,
    DisplayName:       row.display_name || '',
    LastLogin:         row.last_login,
    LastSeen:          lastSeen,
    CurrentlyLoggedIn: isOnline,
    FriendshipStatus:  row.status,   // 'pending' | 'accepted'
  };
}

async function listFriends(playFabId, statusFilter = 'accepted') {
  return db.all(
    `SELECT f.friend_playfab_id AS playfab_id,
            f.status,
            f.sent_at,
            p.display_name,
            p.last_login,
            p.last_seen
       FROM player_friends f
       JOIN players p ON p.playfab_id = f.friend_playfab_id
      WHERE f.playfab_id = $1
        AND ($2::text IS NULL OR f.status = $2)
      ORDER BY p.display_name ASC`,
    [playFabId, statusFilter]
  ).catch(() => []);
}

// Pending requests sent TO this player (they need to accept/decline)
async function listIncomingRequests(playFabId) {
  return db.all(
    `SELECT f.playfab_id,
            f.status,
            f.sent_at,
            p.display_name,
            p.last_login,
            p.last_seen
       FROM player_friends f
       JOIN players p ON p.playfab_id = f.playfab_id
      WHERE f.friend_playfab_id = $1
        AND f.status = 'pending'
      ORDER BY f.sent_at DESC`,
    [playFabId]
  ).catch(() => []);
}

function buildLeaderboardView(rows, statisticName) {
  return rows
    .filter((row) => !statisticName || row.statistic_name === statisticName)
    .sort((a, b) => Number(b.stat_value || 0) - Number(a.stat_value || 0))
    .slice(0, 100)
    .map((row, index) => ({
      Position: index + 1,
      PlayFabId: row.playfab_id,
      DisplayName: row.display_name || '',
      StatisticName: row.statistic_name,
      Value: row.stat_value,
      UpdatedAt: row.updated_at
    }));
}
router.use(apiLimiter);

function itemView(row) {
  return {
    ItemInstanceId: row.instance_id,
    ItemId: row.item_id,
    ItemClass: row.item_class,
    CatalogVersion: row.catalog_version,
    DisplayName: row.display_name,
    UnitPrice: row.unit_price,
    PurchaseDate: row.purchase_date,
    RemainingUses: row.remaining_uses,
    CustomData: row.custom_data || {}
  };
}

function titleDataView(rows, keys) {
  const selected = keys?.length
    ? Object.fromEntries(keys.map((key) => [key, rows[key]]).filter(([, value]) => value != null))
    : rows;
  return { Data: selected };
}

function loginHandler(identifierField, dbField, origination) {
  return async (req, res) => {
    try {
      const { TitleId, CreateAccount } = req.body || {};
      const identifier = req.body?.[identifierField];
      if (TitleId !== req.app.locals.titleId) {
        return fail(res, 400, 'TitleNotFound', 'Title not found.');
      }
      if (!identifier || typeof identifier !== 'string') {
        return fail(res, 400, 'InvalidParams', `${identifierField} is required.`);
      }

      let player = await db.one(`SELECT * FROM players WHERE ${dbField} = $1`, [identifier]);
      let newlyCreated = false;
      if (!player) {
        if (!CreateAccount) return fail(res, 400, 'AccountNotFound', 'Account not found.');
        const playFabId = generatePlayFabId();
        await initializeNewPlayer(playFabId, origination, req.app.locals.catalog);
        await db.query(`UPDATE players SET ${dbField} = $1 WHERE playfab_id = $2`, [identifier, playFabId]);
        player = await db.one('SELECT * FROM players WHERE playfab_id = $1', [playFabId]);
        newlyCreated = true;
      }
      const ban = await getActiveBan({
        playFabId: player.playfab_id,
        ipAddress: req.ip,
        deviceId: req.body?.AndroidDeviceId || req.body?.DeviceId || req.body?.CustomId || req.body?.Email || null
      });
      if (player.banned || player.banned_until || ban) return fail(res, 400, 'AccountBanned', 'Account is banned.');

      const ticket = await createSession(player.playfab_id);
      return ok(res, {
        SessionTicket: ticket,
        PlayFabId: player.playfab_id,
        NewlyCreated: newlyCreated,
        DiscordLinked: player.discord_id !== null && player.discord_id !== undefined,
        DiscordTag: player.discord_tag || null,
        LastLoginTime: player.last_login,
        SettingsForUser: { IsNewsEnabled: true, IsPushNotificationEnabled: false }
      });
    } catch (error) {
      return fail(res, 500, 'InternalServerError', error.message);
    }
  };
}

// Authentication does not require a session ticket.
router.post('/LoginWithCustomID', loginLimiter, loginHandler('CustomId', 'custom_id', 'Custom'));
router.post('/LoginWithAndroidDeviceID', loginLimiter, loginHandler('AndroidDeviceId', 'android_id', 'Android'));
router.post('/LoginWithIOSDeviceID', loginLimiter, loginHandler('DeviceId', 'ios_id', 'IOS'));
router.post('/LoginWithEmailAddress', loginLimiter, loginHandler('Email', 'email', 'Email'));

router.post('/RegisterPlayFabUser', loginLimiter, async (req, res) => {
  try {
    const { TitleId, Email, DisplayName, Username } = req.body || {};
    if (TitleId !== req.app.locals.titleId) return fail(res, 400, 'TitleNotFound', 'Title not found.');
    const playFabId = generatePlayFabId();
    await initializeNewPlayer(playFabId, 'Custom', req.app.locals.catalog);
    await db.query(
      'UPDATE players SET email = COALESCE($1, email), display_name = COALESCE($2, display_name) WHERE playfab_id = $3',
      [Email || null, DisplayName || null, playFabId]
    );
    const ticket = await createSession(playFabId);
    return ok(res, { SessionTicket: ticket, PlayFabId: playFabId, Username: Username || playFabId });
  } catch (error) {
    return fail(res, 500, 'InternalServerError', error.message);
  }
});

router.use(auth);

router.post('/LinkCustomID', async (req, res) => {
  await db.query('UPDATE players SET custom_id = $1 WHERE playfab_id = $2', [req.body?.CustomId, req.playFabId]);
  return ok(res, {});
});

router.post('/GetTitleData', (req, res) => ok(res, titleDataView(req.app.locals.titleData, req.body?.Keys)));
router.post('/GetTitleNews', (req, res) => ok(res, {
  News: [{ NewsId: '1', Timestamp: new Date().toISOString(), Title: 'Server News', Body: '', Tags: [] }]
}));
router.post('/GetPublisherData', (req, res) => ok(res, { Data: {} }));
router.post('/GetCatalogItems', (req, res) => ok(res, { Catalog: req.app.locals.catalog }));
router.post('/GetStoreItems', (req, res) => {
  const storeId = req.body?.StoreId;
  const store = req.app.locals.stores[storeId];
  if (!store) return fail(res, 400, 'StoreNotFound', `Store not found: ${storeId || ''}`);
  return ok(res, { StoreId: storeId, CatalogVersion: '1', Store: store, MarketingData: {} });
});

// PlayFab-shaped content/asset-bundle endpoints, backed by the asset_bundles
// table that the admin dashboard's "Asset Bundles" tab manages. A bundle
// added or updated in the dashboard is fetchable here immediately.
router.post('/GetContentList', async (req, res) => {
  const platform = req.body?.PublicKey || req.body?.Platform || 'all';
  const all = await listAssets({ activeOnly: true });
  const items = all.filter((a) => a.platform === 'all' || a.platform === platform || platform === 'all');
  return ok(res, {
    Contents: items.map((a) => ({
      Key: a.bundleKey,
      LastModified: a.updatedAt,
      Size: a.sizeBytes || 0,
    })),
  });
});

router.post('/GetContentDownloadUrl', async (req, res) => {
  const key = req.body?.Key;
  if (!key) return fail(res, 400, 'InvalidParams', 'Key is required.');
  const all = await listAssets({ activeOnly: true });
  const asset = all.find((a) => a.bundleKey === key);
  if (!asset) return fail(res, 404, 'ContentNotFound', `No asset bundle found for key: ${key}`);
  return ok(res, { URL: asset.url });
});

router.post('/GetEconomyEvents', async (req, res) => {
  const events = await getActiveEvents();
  return ok(res, {
    Events: events.map((e) => ({
      EventKey:    e.event_key,
      DisplayName: e.display_name,
      EventType:   e.event_type,
      StartsAt:    e.starts_at,
      EndsAt:      e.ends_at,
      Payload:     e.payload || {},
    })),
  });
});

router.post('/OpenLootCrate', async (req, res) => {
  const tableKey = req.body?.TableKey || req.body?.LootTableId;
  if (!tableKey) return fail(res, 400, 'InvalidParams', 'TableKey is required.');

  const table = await getLootTable(tableKey);
  if (!table) return fail(res, 404, 'LootTableNotFound', `Loot table not found: ${tableKey}`);
  if (!table.active) return fail(res, 400, 'LootTableDisabled', 'This loot table is not active.');

  const items = table.items || [];
  if (!items.length) return ok(res, { GrantedItems: [], TableKey: tableKey });

  // Weighted random selection - one roll per table.roll_count
  const totalWeight = items.reduce((s, it) => s + it.weight, 0);
  const granted = [];

  for (let roll = 0; roll < (table.roll_count || 1); roll++) {
    let rand = Math.random() * totalWeight;
    for (const item of items) {
      rand -= item.weight;
      if (rand <= 0) {
        const qty = item.min_quantity === item.max_quantity
          ? item.min_quantity
          : item.min_quantity + Math.floor(Math.random() * (item.max_quantity - item.min_quantity + 1));
        granted.push({ ItemId: item.item_id, Quantity: qty });
        break;
      }
    }
  }

  // Grant items to player inventory
  // Uses purchase_date (the actual column name in the schema, not acquired_at).
  if (req.playFabId && granted.length) {
    await Promise.all(granted.map(({ ItemId, Quantity }) =>
      db.query(
        `INSERT INTO inventory
           (instance_id, playfab_id, item_id, item_class, catalog_version,
            display_name, unit_price, remaining_uses, purchase_date)
         VALUES ($1, $2, $3, 'LootReward', '1', $3, 0, $4, NOW())`,
        [randomUUID(), req.playFabId, ItemId, Quantity > 1 ? Quantity : null]
      ).catch(() => {})
    ));
  }

  return ok(res, {
    TableKey: tableKey,
    GrantedItems: granted,
    RollCount: table.roll_count || 1,
  });
});

router.post('/GetAccountInfo', async (req, res) => {
  const player = await db.one('SELECT * FROM players WHERE playfab_id = $1', [req.playFabId]);
  if (!player) return fail(res, 401, 'InvalidSessionTicket', 'Player not found.');
  return ok(res, {
    AccountInfo: {
      PlayFabId: player.playfab_id,
      Created: player.created_at,
      TitleInfo: {
        DisplayName: player.display_name,
        Created: player.created_at,
        LastLogin: player.last_login,
        Origination: player.origination,
        IsBanned: player.banned
      },
      PrivateInfo: { Email: player.email || '' }
    }
  });
});

router.post('/GetPlayerProfile', async (req, res) => {
  const player = await db.one('SELECT * FROM players WHERE playfab_id = $1', [req.playFabId]);
  return ok(res, {
    PlayerProfile: {
      PublisherId: req.app.locals.titleId,
      TitleId: req.app.locals.titleId,
      PlayerId: player.playfab_id,
      DisplayName: player.display_name,
      Created: player.created_at,
      LastLogin: player.last_login,
      Origination: player.origination,
      IsBanned: player.banned
    }
  });
});

// PlayFab-shaped compatibility endpoints backed by local player data.
router.post('/GetUserVirtualCurrency', async (req, res) => {
  const player = await db.one('SELECT vc_ge, vc_bb, vc_dt, vc_bp FROM players WHERE playfab_id = $1', [req.playFabId]);
  return ok(res, {
    VirtualCurrency: {
      GE: player?.vc_ge || 0,
      BB: player?.vc_bb || 0,
      DT: player?.vc_dt || 0,
      BP: player?.vc_bp || 0,
    },
    VirtualCurrencyRechargeTimes: {}
  });
});

router.post('/GetPlayerDisplayName', async (req, res) => {
  const player = await db.one('SELECT display_name FROM players WHERE playfab_id = $1', [req.playFabId]);
  return ok(res, { DisplayName: player?.display_name || '' });
});

router.post('/GetCharacterList', async (req, res) => {
  const { inventory, readonlyRows } = await getPlayerSnapshot(req.playFabId);
  const characters = buildCharacterList(inventory, readonlyRows);
  return ok(res, {
    Characters: characters,
    CharacterCount: characters.length
  });
});

router.post('/GetAllUsersCharacters', async (req, res) => {
  const { player, inventory, readonlyRows } = await getPlayerSnapshot(req.playFabId);
  const characters = buildCharacterList(inventory, readonlyRows);
  return ok(res, {
    PlayFabId: req.playFabId,
    DisplayName: player?.display_name || '',
    Characters: characters
  });
});

router.post('/GetCharacterInventory', async (req, res) => {
  const { inventory } = await getPlayerSnapshot(req.playFabId);
  const grouped = inventory.reduce((acc, row) => {
    const key = row.item_class || 'Unknown';
    acc[key] = acc[key] || [];
    acc[key].push(itemView(row));
    return acc;
  }, {});
  return ok(res, {
    Inventory: inventory.map(itemView),
    InventoryByClass: grouped,
    CharacterInventory: inventory.filter(ownCharacter).map(itemView)
  });
});

router.post('/GetCharacterData', async (req, res) => {
  const { player, userDataRows, readonlyRows, statsRows } = await getPlayerSnapshot(req.playFabId);
  return ok(res, {
    CharacterId: req.body?.CharacterId || null,
    CharacterName: player?.display_name || '',
    DataVersion: 1,
    Data: buildDataMap(userDataRows),
    ReadOnlyData: buildReadonlyMap(readonlyRows),
    Statistics: Object.fromEntries(statsRows.map((row) => [row.statistic_name, row.value])),
    VirtualCurrency: {
      GE: player?.vc_ge || 0,
      BB: player?.vc_bb || 0,
      DT: player?.vc_dt || 0,
      BP: player?.vc_bp || 0,
    }
  });
});

router.post('/GetCharacterReadOnlyData', async (req, res) => {
  const { readonlyRows } = await getPlayerSnapshot(req.playFabId);
  return ok(res, {
    CharacterId: req.body?.CharacterId || null,
    Data: buildReadonlyMap(readonlyRows)
  });
});

router.post('/GetCharacterLeaderboard', async (req, res) => {
  const statisticName = String(req.body?.StatisticName || req.body?.LeaderboardName || 'Wins');
  const rows = await db.all('SELECT * FROM leaderboard_entries WHERE statistic_name = $1 ORDER BY stat_value DESC, updated_at DESC', [statisticName]);
  return ok(res, {
    StatisticName: statisticName,
    Leaderboard: buildLeaderboardView(rows, statisticName),
  });
});

router.post('/GetLeaderboardForUsersCharacters', async (req, res) => {
  const statisticName = String(req.body?.StatisticName || req.body?.LeaderboardName || 'Wins');
  const rows = await db.all(
    'SELECT * FROM leaderboard_entries WHERE statistic_name = $1 AND playfab_id = $2 ORDER BY stat_value DESC, updated_at DESC',
    [statisticName, req.playFabId]
  );
  return ok(res, {
    StatisticName: statisticName,
    Leaderboard: buildLeaderboardView(rows, statisticName),
  });
});

router.post('/GetFriendList', async (req, res) => {
  // IncludeSteamFriends / IncludeFacebookFriends not applicable - reuse the
  // boolean to optionally include pending outgoing requests in one call.
  const includePending = req.body?.IncludePendingStatus === true;
  const friends = await listFriends(req.playFabId, includePending ? null : 'accepted');
  const incoming = includePending ? await listIncomingRequests(req.playFabId) : [];
  return ok(res, {
    Friends: friends.map(normalizeFriendRow),
    IncomingRequests: incoming.map((r) => ({
      FromPlayFabId:   r.playfab_id,
      DisplayName:     r.display_name || '',
      SentAt:          r.sent_at,
    })),
  });
});

router.post('/GetPlayerCombinedInfo', async (req, res) => {
  try {
    const params = req.body?.InfoRequestParameters || {};
    const output = {};
    if (params.GetUserAccountInfo) {
      const player = await db.one('SELECT * FROM players WHERE playfab_id = $1', [req.playFabId]);
      output.AccountInfo = {
        PlayFabId: player.playfab_id,
        Created: player.created_at,
        TitleInfo: { DisplayName: player.display_name, LastLogin: player.last_login, Origination: player.origination }
      };
    }
    if (params.GetUserInventory || params.GetUserVirtualCurrency) {
      const player = await db.one('SELECT vc_ge, vc_bb, vc_dt, vc_bp FROM players WHERE playfab_id = $1', [req.playFabId]);
      if (params.GetUserInventory) {
        output.UserInventory = (await db.all('SELECT * FROM inventory WHERE playfab_id = $1', [req.playFabId])).map(itemView);
      }
      output.UserVirtualCurrency = { GE: player.vc_ge, BB: player.vc_bb, DT: player.vc_dt, BP: player.vc_bp };
      output.UserVirtualCurrencyRechargeTimes = {};
    }
    if (params.GetUserData) {
      const rows = await db.all('SELECT * FROM user_data WHERE playfab_id = $1', [req.playFabId]);
      output.UserData = Object.fromEntries(rows.map((row) => [
        row.key,
        { Value: row.value, LastUpdated: row.last_updated, Permission: row.permission }
      ]));
    }
    if (params.GetUserReadOnlyData) {
      const rows = await db.all('SELECT * FROM user_readonly_data WHERE playfab_id = $1', [req.playFabId]);
      output.UserReadOnlyData = Object.fromEntries(rows.map((row) => [
        row.key,
        { Value: row.value, LastUpdated: row.last_updated, Permission: 'Private' }
      ]));
    }
    if (params.GetPlayerStatistics) {
      const rows = await db.all('SELECT * FROM player_statistics WHERE playfab_id = $1', [req.playFabId]);
      output.PlayerStatistics = rows.map((row) => ({
        StatisticName: row.statistic_name, Value: row.value, Version: row.version
      }));
    }
    if (params.GetTitleData) output.TitleData = req.app.locals.titleData;
    return ok(res, { InfoResultPayload: output });
  } catch (error) {
    return fail(res, 500, 'InternalServerError', error.message);
  }
});

router.post('/GetPlayerTags', (req, res) => ok(res, { Tags: [] }));
router.post('/UpdateUserTitleDisplayName', async (req, res) => {
  const displayName = req.body?.DisplayName;
  if (!displayName) return fail(res, 400, 'InvalidParams', 'DisplayName is required.');
  await db.query('UPDATE players SET display_name = $1 WHERE playfab_id = $2', [displayName, req.playFabId]);
  // Keep leaderboard_entries in sync - otherwise the old name stays on the
  // leaderboard forever even after the player renames themselves.
  await db.query(
    'UPDATE leaderboard_entries SET display_name = $1 WHERE playfab_id = $2',
    [displayName, req.playFabId]
  ).catch(() => {});
  await db.query(
    `INSERT INTO player_statistics (playfab_id, statistic_name, value, version)
     VALUES ($1, 'NameChanges', 1, 0)
     ON CONFLICT (playfab_id, statistic_name)
     DO UPDATE SET value = player_statistics.value + 1`,
    [req.playFabId]
  );
  return ok(res, { DisplayName: displayName });
});

router.post('/GetUserInventory', async (req, res) => {
  const items = await db.all('SELECT * FROM inventory WHERE playfab_id = $1', [req.playFabId]);
  const player = await db.one('SELECT vc_ge, vc_bb, vc_dt, vc_bp FROM players WHERE playfab_id = $1', [req.playFabId]);
  return ok(res, {
    Inventory: items.map(itemView),
    VirtualCurrency: { GE: player.vc_ge, BB: player.vc_bb, DT: player.vc_dt, BP: player.vc_bp },
    VirtualCurrencyRechargeTimes: {}
  });
});

async function readKeyValue(req, table, permission) {
  const keys = req.body?.Keys;
  const rows = keys?.length
    ? await db.all(`SELECT * FROM ${table} WHERE playfab_id = $1 AND key = ANY($2)`, [req.playFabId, keys])
    : await db.all(`SELECT * FROM ${table} WHERE playfab_id = $1`, [req.playFabId]);
  return Object.fromEntries(rows.map((row) => [
    row.key,
    { Value: row.value, LastUpdated: row.last_updated, Permission: permission || row.permission }
  ]));
}

router.post('/GetUserData', async (req, res) => ok(res, {
  Data: await readKeyValue(req, 'user_data'),
  DataVersion: 0
}));
router.post('/GetUserReadOnlyData', async (req, res) => ok(res, {
  Data: await readKeyValue(req, 'user_readonly_data', 'Private'),
  DataVersion: 0
}));
router.post('/GetUserPublisherData', (req, res) => ok(res, { Data: {} }));
router.post('/GetUserPublisherReadOnlyData', (req, res) => ok(res, { Data: {} }));

router.post('/UpdateUserData', async (req, res) => {
  const permission = req.body?.Permission || 'Public';
  const now = new Date().toISOString();
  for (const [key, value] of Object.entries(req.body?.Data || {})) {
    await db.query(
      `INSERT INTO user_data (playfab_id, key, value, last_updated, permission)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (playfab_id, key)
       DO UPDATE SET value = $3, last_updated = $4, permission = $5`,
      [req.playFabId, key, String(value), now, permission]
    );
  }
  if (req.body?.KeysToDelete?.length) {
    await db.query('DELETE FROM user_data WHERE playfab_id = $1 AND key = ANY($2)', [
      req.playFabId, req.body.KeysToDelete
    ]);
  }
  return ok(res, { DataVersion: 1 });
});

router.post('/GetPlayerStatistics', async (req, res) => {
  const names = req.body?.StatisticNames;
  const rows = names?.length
    ? await db.all('SELECT * FROM player_statistics WHERE playfab_id = $1 AND statistic_name = ANY($2)', [req.playFabId, names])
    : await db.all('SELECT * FROM player_statistics WHERE playfab_id = $1', [req.playFabId]);
  return ok(res, {
    Statistics: rows.map((row) => ({ StatisticName: row.statistic_name, Value: row.value, Version: row.version }))
  });
});
router.post('/GetPlayerStatisticVersions', (req, res) => ok(res, { StatisticVersions: [] }));

router.post('/UpdatePlayerStatistics', async (req, res) => {
  try {
    const player = await db.one('SELECT display_name FROM players WHERE playfab_id = $1', [req.playFabId]);
    for (const statistic of req.body?.Statistics || []) {
      await db.query(
        `INSERT INTO player_statistics (playfab_id, statistic_name, value, version)
         VALUES ($1, $2, $3, 0)
         ON CONFLICT (playfab_id, statistic_name) DO UPDATE SET value = $3`,
        [req.playFabId, statistic.StatisticName, statistic.Value]
      );
      await db.query(
        `INSERT INTO leaderboard_entries
          (statistic_name, playfab_id, display_name, stat_value, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (statistic_name, playfab_id)
         DO UPDATE SET display_name = $3, stat_value = $4, updated_at = NOW()`,
        [statistic.StatisticName, req.playFabId, player.display_name, statistic.Value]
      );
    }
    // Flush all leaderboard cache keys (ioredis doesn't support wildcard in del)
    redis.keys('cache:leaderboard:*').then((keys) => { if (keys.length) redis.del(...keys); }).catch(() => {});
    return ok(res, {});
  } catch (error) {
    return fail(res, 500, 'InternalServerError', error.message);
  }
});

router.post('/GetLeaderboard', async (req, res) => {
  const statisticName = req.body?.StatisticName;
  const limit = Math.min(Math.max(Number(req.body?.MaxResultsCount) || 10, 1), 100);
  const offset = Math.max(Number(req.body?.StartPosition) || 0, 0);
  const cacheKey = `cache:leaderboard:${statisticName}:${offset}:${limit}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return ok(res, { Leaderboard: JSON.parse(cached) });
  const rows = await db.all(
    `SELECT playfab_id, display_name, stat_value
       FROM leaderboard_entries
      WHERE statistic_name = $1
      ORDER BY stat_value DESC, playfab_id ASC
      LIMIT $2 OFFSET $3`,
    [statisticName, limit, offset]
  );
  const leaderboard = rows.map((row, index) => ({
    PlayFabId: row.playfab_id,
    DisplayName: row.display_name,
    StatValue: row.stat_value,
    Position: offset + index
  }));
  await redis.setex(cacheKey, 30, JSON.stringify(leaderboard)).catch(() => {});
  return ok(res, { Leaderboard: leaderboard });
});

router.post('/GetLeaderboardAroundPlayer', async (req, res) => {
  const statisticName = req.body?.StatisticName;
  const limit = Math.min(Math.max(Number(req.body?.MaxResultsCount) || 10, 1), 100);
  const own = await db.one(
    'SELECT stat_value FROM leaderboard_entries WHERE statistic_name = $1 AND playfab_id = $2',
    [statisticName, req.playFabId]
  );
  const ownValue = own?.stat_value ?? 0;
  const above = await db.all(
    `SELECT playfab_id, display_name, stat_value FROM leaderboard_entries
      WHERE statistic_name = $1 AND stat_value > $2
      ORDER BY stat_value ASC LIMIT $3`,
    [statisticName, ownValue, Math.floor(limit / 2)]
  );
  const below = await db.all(
    `SELECT playfab_id, display_name, stat_value FROM leaderboard_entries
      WHERE statistic_name = $1 AND stat_value <= $2
      ORDER BY stat_value DESC LIMIT $3`,
    [statisticName, ownValue, Math.ceil(limit / 2)]
  );
  return ok(res, {
    Leaderboard: [...above.reverse(), ...below].map((row, index) => ({
      PlayFabId: row.playfab_id, DisplayName: row.display_name,
      StatValue: row.stat_value, Position: index
    }))
  });
});

router.post('/GetFriendsList', async (req, res) => {
  const includePending = req.body?.IncludePendingStatus === true;
  const friends = await listFriends(req.playFabId, includePending ? null : 'accepted');
  const incoming = includePending ? await listIncomingRequests(req.playFabId) : [];
  return ok(res, {
    Friends: friends.map(normalizeFriendRow),
    IncomingRequests: incoming.map((r) => ({
      FromPlayFabId: r.playfab_id,
      DisplayName:   r.display_name || '',
      SentAt:        r.sent_at,
    })),
  });
});

// AddFriend
// Accepts: FriendPlayFabId  - exact ID
//          FriendTitleDisplayName / FriendUsername - display-name search (ILIKE)
//          FriendEmail       - registered email
// Sends a PENDING request. If the target already sent one to us, auto-accepts.
router.post('/AddFriend', async (req, res) => {
  const byId          = String(req.body?.FriendPlayFabId || req.body?.PlayFabId || '').trim();
  const byDisplayName = String(req.body?.FriendTitleDisplayName || req.body?.FriendUsername || '').trim();
  const byEmail       = String(req.body?.FriendEmail || '').trim();

  if (!byId && !byDisplayName && !byEmail) {
    return fail(res, 400, 'InvalidParams', 'Provide FriendPlayFabId, FriendTitleDisplayName, or FriendEmail.');
  }

  // Resolve target player
  let friend = null;
  if (byId) {
    friend = await db.one(
      'SELECT playfab_id, display_name FROM players WHERE playfab_id = $1', [byId]
    ).catch(() => null);
  } else if (byEmail) {
    friend = await db.one(
      'SELECT playfab_id, display_name FROM players WHERE email = $1', [byEmail]
    ).catch(() => null);
  } else {
    friend = await db.one(
      `SELECT playfab_id, display_name
         FROM players
        WHERE display_name ILIKE $1
        ORDER BY created_at ASC
        LIMIT 1`,
      [byDisplayName]
    ).catch(() => null);
  }

  if (!friend)                          return fail(res, 404, 'AccountNotFound',   'Player not found.');
  if (friend.playfab_id === req.playFabId) return fail(res, 400, 'InvalidParams', 'Cannot add yourself.');

  const targetId = friend.playfab_id;

  // Check existing outgoing row
  const outgoing = await db.one(
    'SELECT status FROM player_friends WHERE playfab_id = $1 AND friend_playfab_id = $2',
    [req.playFabId, targetId]
  ).catch(() => null);

  if (outgoing?.status === 'accepted') return fail(res, 400, 'AlreadyFriend',       'Already friends.');
  if (outgoing?.status === 'pending')  return fail(res, 400, 'AlreadySentRequest',  'Friend request already sent.');

  // Check if target already sent us a request -> auto-accept (mutual)
  const incoming = await db.one(
    'SELECT status FROM player_friends WHERE playfab_id = $1 AND friend_playfab_id = $2',
    [targetId, req.playFabId]
  ).catch(() => null);

  if (incoming?.status === 'pending') {
    // Accept their request and create our side
    await db.query(
      `UPDATE player_friends SET status = 'accepted'
        WHERE playfab_id = $1 AND friend_playfab_id = $2`,
      [targetId, req.playFabId]
    );
    await db.query(
      `INSERT INTO player_friends (playfab_id, friend_playfab_id, status)
       VALUES ($1, $2, 'accepted')
       ON CONFLICT (playfab_id, friend_playfab_id) DO UPDATE SET status = 'accepted'`,
      [req.playFabId, targetId]
    );
    return ok(res, {
      Created: true, FriendPlayFabId: targetId, Status: 'accepted',
      Message: 'Mutual request - friendship accepted automatically.',
    });
  }

  // Send pending request (one-sided)
  await db.query(
    `INSERT INTO player_friends (playfab_id, friend_playfab_id, status, sent_at)
     VALUES ($1, $2, 'pending', NOW())
     ON CONFLICT (playfab_id, friend_playfab_id)
     DO UPDATE SET status = 'pending', sent_at = NOW()`,
    [req.playFabId, targetId]
  );
  return ok(res, { Created: true, FriendPlayFabId: targetId, Status: 'pending' });
});

// AcceptFriend
// The caller is accepting a pending request that came FROM FriendPlayFabId.
router.post('/AcceptFriend', async (req, res) => {
  const friendId = String(req.body?.FriendPlayFabId || '').trim();
  if (!friendId) return fail(res, 400, 'InvalidParams', 'FriendPlayFabId is required.');

  const request = await db.one(
    'SELECT status FROM player_friends WHERE playfab_id = $1 AND friend_playfab_id = $2',
    [friendId, req.playFabId]
  ).catch(() => null);

  if (!request)                        return fail(res, 404, 'FriendRequestNotFound', 'No pending request from that player.');
  if (request.status === 'accepted')   return fail(res, 400, 'AlreadyFriend',         'Already friends.');
  if (request.status !== 'pending')    return fail(res, 400, 'InvalidState',           `Request status is '${request.status}', expected 'pending'.`);

  // Mark their outgoing as accepted
  await db.query(
    `UPDATE player_friends SET status = 'accepted'
      WHERE playfab_id = $1 AND friend_playfab_id = $2`,
    [friendId, req.playFabId]
  );
  // Create our side (accepted)
  await db.query(
    `INSERT INTO player_friends (playfab_id, friend_playfab_id, status)
     VALUES ($1, $2, 'accepted')
     ON CONFLICT (playfab_id, friend_playfab_id) DO UPDATE SET status = 'accepted'`,
    [req.playFabId, friendId]
  );
  return ok(res, { Accepted: true, FriendPlayFabId: friendId });
});

// DeclineFriend
// Reject an incoming pending request without adding the sender.
router.post('/DeclineFriend', async (req, res) => {
  const friendId = String(req.body?.FriendPlayFabId || '').trim();
  if (!friendId) return fail(res, 400, 'InvalidParams', 'FriendPlayFabId is required.');

  await db.query(
    `DELETE FROM player_friends
      WHERE playfab_id = $1 AND friend_playfab_id = $2 AND status = 'pending'`,
    [friendId, req.playFabId]
  );
  return ok(res, { Declined: true, FriendPlayFabId: friendId });
});

// RemoveFriend
// Remove accepted friendship OR cancel an outgoing pending request.
router.post('/RemoveFriend', async (req, res) => {
  const friendId = String(req.body?.FriendPlayFabId || req.body?.PlayFabId || '').trim();
  if (!friendId) return fail(res, 400, 'InvalidParams', 'FriendPlayFabId is required.');
  await db.query(
    `DELETE FROM player_friends
      WHERE (playfab_id = $1 AND friend_playfab_id = $2)
         OR (playfab_id = $2 AND friend_playfab_id = $1)`,
    [req.playFabId, friendId]
  );
  return ok(res, { Removed: true, FriendPlayFabId: friendId });
});

// GetPendingFriendRequests
// Returns incoming (received) and outgoing (sent) pending requests.
router.post('/GetPendingFriendRequests', async (req, res) => {
  const incoming = await listIncomingRequests(req.playFabId);
  const outgoing = await listFriends(req.playFabId, 'pending');
  return ok(res, {
    Incoming: incoming.map((r) => ({
      FromPlayFabId: r.playfab_id,
      DisplayName:   r.display_name || '',
      SentAt:        r.sent_at,
    })),
    Outgoing: outgoing.map((r) => ({
      ToPlayFabId:  r.playfab_id,
      DisplayName:  r.display_name || '',
      SentAt:       r.sent_at,
    })),
  });
});

router.post('/GrantCharacterToUser', async (req, res) => {
  const itemId = req.body?.ItemId;
  const catalogEntry = req.app.locals.catalog.find((entry) => entry.ItemId === itemId) || {};
  const id = randomUUID();
  await db.query(
    `INSERT INTO inventory
      (instance_id, playfab_id, item_id, item_class, catalog_version, display_name, unit_price)
     VALUES ($1, $2, $3, 'Character', '1', $4, 0)`,
    [id, req.playFabId, itemId, req.body?.CharacterName || catalogEntry.DisplayName || itemId]
  );
  return ok(res, { CharacterId: id, CharacterType: req.body?.CharacterType || 'Character' });
});

router.post('/UpdateCharacterData', async (req, res) => {
  const key = `Character_${req.body?.CharacterId}`;
  await db.query(
    `INSERT INTO user_data (playfab_id, key, value, last_updated, permission)
     VALUES ($1, $2, $3, NOW(), 'Public')
     ON CONFLICT (playfab_id, key)
     DO UPDATE SET value = $3, last_updated = NOW()`,
    [req.playFabId, key, JSON.stringify(req.body?.Data || {})]
  );
  return ok(res, { DataVersion: 1 });
});

router.post('/GetTime', (req, res) => ok(res, { Time: new Date().toISOString() }));

router.post('/AddUserVirtualCurrency', async (req, res) => {
  const currency = String(req.body?.VirtualCurrency || '').toUpperCase();
  const column = CURRENCY_COLUMNS[currency];
  const amount = Number(req.body?.Amount);
  if (!column || !Number.isInteger(amount) || amount < 0) {
    return fail(res, 400, 'InvalidCurrency', 'A supported currency and non-negative integer amount are required.');
  }
  const player = await db.one(
    `UPDATE players SET ${column} = ${column} + $1 WHERE playfab_id = $2
     RETURNING ${column} AS balance`,
    [amount, req.playFabId]
  );
  logCurrencyTx({ playFabId: req.playFabId, currency, delta: amount, balanceAfter: player?.balance, source: 'game', reason: 'AddUserVirtualCurrency' }).catch(() => {});
  return ok(res, { VirtualCurrency: currency, Balance: player.balance });
});

router.post('/SubtractUserVirtualCurrency', async (req, res) => {
  const currency = String(req.body?.VirtualCurrency || '').toUpperCase();
  const column = CURRENCY_COLUMNS[currency];
  const amount = Number(req.body?.Amount);
  if (!column || !Number.isInteger(amount) || amount < 0) {
    return fail(res, 400, 'InvalidCurrency', 'A supported currency and non-negative integer amount are required.');
  }
  // Atomic check-and-subtract: the WHERE clause prevents going negative even
  // under concurrent requests (no SELECT-then-UPDATE race condition).
  const player = await db.one(
    `UPDATE players
        SET ${column} = ${column} - $1
      WHERE playfab_id = $2
        AND ${column} >= $1
      RETURNING ${column} AS balance`,
    [amount, req.playFabId]
  );
  if (!player) return fail(res, 400, 'InsufficientFunds', 'Not enough currency.');
  logCurrencyTx({ playFabId: req.playFabId, currency, delta: -amount, balanceAfter: player?.balance, source: 'game', reason: 'SubtractUserVirtualCurrency' }).catch(() => {});
  return ok(res, { VirtualCurrency: currency, Balance: player.balance });
});

router.post('/PurchaseItem', async (req, res) => {
  const itemId = req.body?.ItemId;
  const currency = String(req.body?.VirtualCurrency || '').toUpperCase();
  const column = CURRENCY_COLUMNS[currency];
  const price = Number(req.body?.Price);
  const catalogEntry = req.app.locals.catalog.find((entry) => entry.ItemId === itemId);
  if (!catalogEntry) return fail(res, 400, 'ItemNotFound', 'Item not found in catalog.');
  if (!column || !Number.isInteger(price) || price < 0) return fail(res, 400, 'InvalidPurchase', 'Invalid currency or price.');
  const instanceId = randomUUID();
  try {
    await db.tx(async (client) => {
      // Atomic: deduct only if balance is sufficient - no race condition
      const updated = await client.one(
        `UPDATE players SET ${column} = ${column} - $1
          WHERE playfab_id = $2 AND ${column} >= $1
          RETURNING ${column} AS balance`,
        [price, req.playFabId]
      );
      if (!updated) throw new Error('InsufficientFunds');
      await client.query(
        `INSERT INTO inventory
          (instance_id, playfab_id, item_id, item_class, catalog_version, display_name, unit_price)
         VALUES ($1, $2, $3, $4, '1', $5, $6)`,
        [instanceId, req.playFabId, itemId, catalogEntry.ItemClass || 'Item', catalogEntry.DisplayName || itemId, price]
      );
      // Log currency deduction
      const { logCurrencyTx } = require('../services/analytics');
      logCurrencyTx({ playFabId: req.playFabId, currency, delta: -price, balanceAfter: updated.balance, source: 'game', reason: `PurchaseItem:${itemId}` }).catch(() => {});
    });
  } catch (error) {
    if (error.message === 'InsufficientFunds') return fail(res, 400, 'InsufficientFunds', 'Not enough currency.');
    return fail(res, 500, 'PurchaseFailed', error.message);
  }
  const item = await db.one('SELECT * FROM inventory WHERE instance_id = $1', [instanceId]);
  return ok(res, { Items: [itemView(item)] });
});

router.post('/ConsumeItem', async (req, res) => {
  const item = await db.one(
    'SELECT * FROM inventory WHERE playfab_id = $1 AND instance_id = $2',
    [req.playFabId, req.body?.ItemInstanceId]
  );
  if (!item) return fail(res, 400, 'ItemNotFound', 'Item not found.');
  if (item.remaining_uses !== null) {
    const remaining = item.remaining_uses - (Number(req.body?.ConsumeCount) || 1);
    if (remaining <= 0) {
      await db.query('DELETE FROM inventory WHERE instance_id = $1', [req.body.ItemInstanceId]);
      return ok(res, { ItemInstanceId: req.body.ItemInstanceId, RemainingUses: 0 });
    }
    await db.query('UPDATE inventory SET remaining_uses = $1 WHERE instance_id = $2', [remaining, req.body.ItemInstanceId]);
    return ok(res, { ItemInstanceId: req.body.ItemInstanceId, RemainingUses: remaining });
  }
  return ok(res, { ItemInstanceId: req.body.ItemInstanceId, RemainingUses: null });
});

router.post('/UnlockContainerItem', async (req, res) => {
  await db.query(
    'DELETE FROM inventory WHERE playfab_id = $1 AND instance_id = $2',
    [req.playFabId, req.body?.ContainerItemInstanceId]
  );
  return ok(res, {
    UnlockedItemInstanceId: req.body?.ContainerItemInstanceId,
    GrantedItems: [],
    VirtualCurrency: {}
  });
});

router.post('/ExecuteCloudScript', async (req, res) => {
  return ok(res, await executeCloudScript(req));
});




// POST /LoginWithEmailAddress
// Step 1: player enters email -> backend sends OTP, returns { OtpSent: true }
router.post('/LoginWithEmailAddress', loginLimiter, async (req, res) => {
  try {
    const { Email } = req.body;
    if (!Email) return fail(res, 400, 'InvalidParams', 'Email required.');
    const { normalizeEmail } = require('../services/emailService');
    const norm = normalizeEmail(Email);
    if (!norm) return fail(res, 400, 'InvalidEmail', 'Invalid email address.');

    const player = await db.one(
      'SELECT playfab_id, email_verified FROM players WHERE email_normalized = $1',
      [norm]
    );
    if (!player)        return fail(res, 404, 'AccountNotFound', 'No account found for this email.');
    if (!player.email_verified) return fail(res, 400, 'EmailNotVerified', 'Email not verified. Use your original device or contact support.');

    // Reuse sendVerificationCode as login OTP (same table, same 10-min TTL)
    await sendLoginOtp(player.playfab_id, Email);
    return ok(res, { OtpSent: true });
  } catch (err) {
    if (err.code === 'EMAIL_TAKEN') return fail(res, 400, 'EmailError', err.message);
    return fail(res, 500, 'InternalServerError', err.message);
  }
});

// POST /ConfirmEmailLogin
// Step 2: player enters OTP -> backend returns full session (same shape as DeviceID login)
router.post('/ConfirmEmailLogin', loginLimiter, async (req, res) => {
  try {
    const { Email, Code } = req.body;
    if (!Email || !Code) return fail(res, 400, 'InvalidParams', 'Email and Code required.');
    const { normalizeEmail } = require('../services/emailService');
    const norm = normalizeEmail(Email);

    const player = await db.one(
      'SELECT playfab_id, display_name, discord_id, discord_tag, last_login FROM players WHERE email_normalized = $1',
      [norm]
    );
    if (!player) return fail(res, 404, 'AccountNotFound', 'No account found.');

    // Validate OTP
    const row = await db.one(
      `SELECT id FROM email_verify_codes
       WHERE playfab_id = $1 AND code = $2
         AND used = FALSE AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [player.playfab_id, String(Code).trim()]
    );
    if (!row) return fail(res, 400, 'InvalidCode', 'Invalid or expired code. Request a new one.');

    await db.query('UPDATE email_verify_codes SET used = TRUE WHERE id = $1', [row.id]);
    await db.query('UPDATE players SET last_login = NOW(), last_seen = NOW() WHERE playfab_id = $1', [player.playfab_id]);

    const ticket = await createSession(player.playfab_id);
    return ok(res, {
      SessionTicket:  ticket,
      PlayFabId:      player.playfab_id,
      NewlyCreated:   false,
      DiscordLinked:  !!player.discord_id,
      DiscordTag:     player.discord_tag || null,
      LastLoginTime:  player.last_login,
      SettingsForUser: { IsNewsEnabled: true, IsPushNotificationEnabled: false }
    });
  } catch (err) {
    return fail(res, 500, 'InternalServerError', err.message);
  }
});

// POST /RegisterEmail
// Step 1 of account setup: save email + send OTP.
router.post('/RegisterEmail', async (req, res) => {
  try {
    const { Email } = req.body;
    if (!Email) return fail(res, 400, 'InvalidParams', 'Email required.');
    await sendVerificationCode(req.playFabId, Email);
    return ok(res, { Sent: true });
  } catch (err) {
    return fail(res, 400, err.code || 'EmailError', err.message);
  }
});

// POST /VerifyEmail
// Step 2: verify OTP, mark email_verified + setup_complete = true.
router.post('/VerifyEmail', async (req, res) => {
  try {
    const { Code } = req.body;
    if (!Code) return fail(res, 400, 'InvalidParams', 'Code required.');
    await verifyEmailCode(req.playFabId, Code);
    return ok(res, { Verified: true });
  } catch (err) {
    return fail(res, 400, err.code || 'VerifyError', err.message);
  }
});

// POST /GetAccountStatus
// Game calls this right after login to decide what setup steps to show.
router.post('/GetAccountStatus', async (req, res) => {
  try {
    const p = await db.one(
      `SELECT email, email_verified, setup_complete,
              discord_id, discord_tag
         FROM players WHERE playfab_id = $1`,
      [req.playFabId]
    );
    return ok(res, {
      EmailSet:        !!p?.email,
      EmailVerified:   p?.email_verified  ?? false,
      SetupComplete:   p?.setup_complete  ?? false,
      DiscordLinked:   !!p?.discord_id,
      DiscordTag:      p?.discord_tag || null,
    });
  } catch (err) {
    return fail(res, 500, 'InternalServerError', err.message);
  }
});

// GET /GetDiscordStatus
// Called by game client after login to check if Discord is linked.
// Returns: { Linked: bool, DiscordTag: string|null }
router.post('/GetDiscordStatus', async (req, res) => {
  try {
    const player = await db.one(
      'SELECT discord_id, discord_tag FROM players WHERE playfab_id = $1',
      [req.playFabId]
    );
    return ok(res, {
      Linked: player.discord_id !== null && player.discord_id !== undefined,
      DiscordTag: player.discord_tag || null,
    });
  } catch (err) {
    return fail(res, 500, 'InternalServerError', err.message);
  }
});

module.exports = router;
