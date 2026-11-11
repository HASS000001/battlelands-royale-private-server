/**
 * Server-side CloudScript handlers
 * PlayFab-compatible CloudScript handlers.
 *
 * Data keys used in user_data / user_readonly_data:
 *   readonly: SkinInventory, BattlePassState, ConsumableInventory
 *   data:     SeasonStatsHistory, SkinUsageCounts, MatchBoxTokenData,
 *             Inbox, MessageStates, TrophyRewardsData, DailyRewardState,
 *             PlayerFlags
 *
 */

'use strict';

const { randomUUID } = require('crypto');
const { db, redis } = require('../db');
const { logCurrencyTx } = require('./analytics');

// helpers

async function readUserData(playFabId, key) {
  const row = await db.one('SELECT value FROM user_data WHERE playfab_id = $1 AND key = $2', [playFabId, key]);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

async function writeUserData(playFabId, key, value) {
  const strVal = typeof value === 'string' ? value : JSON.stringify(value);
  await db.query(
    `INSERT INTO user_data (playfab_id, key, value, last_updated, permission)
     VALUES ($1, $2, $3, NOW(), 'Public')
     ON CONFLICT (playfab_id, key) DO UPDATE SET value = $3, last_updated = NOW()`,
    [playFabId, key, strVal]
  );
}

async function readReadonlyData(playFabId, key) {
  const row = await db.one('SELECT value FROM user_readonly_data WHERE playfab_id = $1 AND key = $2', [playFabId, key]);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

async function writeReadonlyData(playFabId, key, value) {
  const strVal = typeof value === 'string' ? value : JSON.stringify(value);
  await db.query(
    `INSERT INTO user_readonly_data (playfab_id, key, value, last_updated)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (playfab_id, key) DO UPDATE SET value = $3, last_updated = NOW()`,
    [playFabId, key, strVal]
  );
}

async function getPlayerCurrencies(playFabId) {
  const p = await db.one('SELECT vc_ge, vc_bb, vc_dt, vc_bp FROM players WHERE playfab_id = $1', [playFabId]);
  return { GE: p.vc_ge, BB: p.vc_bb, DT: p.vc_dt, BP: p.vc_bp };
}

async function addCurrency(playFabId, currency, amount) {
  const cols = { GE: 'vc_ge', BB: 'vc_bb', DT: 'vc_dt', BP: 'vc_bp' };
  const col = cols[currency];
  if (!col || !Number.isInteger(amount) || amount < 0) return null;
  const row = await db.one(
    `UPDATE players SET ${col} = ${col} + $1 WHERE playfab_id = $2 RETURNING ${col} AS balance`,
    [amount, playFabId]
  );
  // Log every in-game currency grant
  logCurrencyTx({ playFabId, currency, delta: amount, balanceAfter: row?.balance, source: 'game' }).catch(() => {});
  return row.balance;
}

async function getPlayerStats(playFabId) {
  const rows = await db.all('SELECT statistic_name, value FROM player_statistics WHERE playfab_id = $1', [playFabId]);
  return Object.fromEntries(rows.map(r => [r.statistic_name, r.value]));
}

async function updateStat(playFabId, name, value, displayName) {
  await db.query(
    `INSERT INTO player_statistics (playfab_id, statistic_name, value, version)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (playfab_id, statistic_name) DO UPDATE SET value = $3`,
    [playFabId, name, value]
  );
  // Always update leaderboard - even on reset (displayName may be null for season wipe).
  await db.query(
    `INSERT INTO leaderboard_entries (statistic_name, playfab_id, display_name, stat_value, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (statistic_name, playfab_id)
     DO UPDATE SET display_name = COALESCE($3, leaderboard_entries.display_name),
                   stat_value   = $4,
                   updated_at   = NOW()`,
    [name, playFabId, displayName, value]
  );
}

/**
 * Redis-based claim lock - prevents double-claiming in concurrent requests.
 * Returns true if the lock was acquired, false if already locked.
 * Caller MUST call releaseLock() in a finally block.
 */
async function acquireLock(key, ttlSeconds = 8) {
  const result = await redis.set(`lock:${key}`, '1', 'EX', ttlSeconds, 'NX').catch(() => null);
  return result === 'OK';
}

async function releaseLock(key) {
  await redis.del(`lock:${key}`).catch(() => {});
}

/** Fetch active economy events and return a multiplier map: { xp, vc: {GE, BB, DT, BP} } */
async function getActiveEventMultipliers() {
  const events = await db.all(
    `SELECT event_type, payload FROM economy_events
      WHERE active = true AND starts_at <= NOW() AND ends_at > NOW()`,
  ).catch(() => []);

  let xpMultiplier = 1;
  const vcMultiplier = { GE: 1, BB: 1, DT: 1, BP: 1 };

  for (const ev of events) {
    const payload = typeof ev.payload === 'object' ? ev.payload : JSON.parse(ev.payload || '{}');
    if (ev.event_type === 'double_xp') {
      xpMultiplier = Math.max(xpMultiplier, Number(payload.multiplier) || 2);
    } else if (ev.event_type === 'bonus_vc') {
      const cur = String(payload.currency || '').toUpperCase();
      if (vcMultiplier[cur] !== undefined) {
        vcMultiplier[cur] = Math.max(vcMultiplier[cur], Number(payload.multiplier) || 2);
      }
    }
  }
  return { xpMultiplier, vcMultiplier };
}

// Skin level thresholds (BP required to reach each level)
const SKIN_LEVEL_THRESHOLDS = [0, 100, 250, 500, 900, 1400, 2000, 2700, 3500, 4400, 5400];

function getSkinLevel(totalBP) {
  let level = 1;
  for (let i = 1; i < SKIN_LEVEL_THRESHOLDS.length; i++) {
    if (totalBP >= SKIN_LEVEL_THRESHOLDS[i]) level = i + 1;
    else break;
  }
  return Math.min(level, 10);
}

// HANDLERS

const HANDLERS = {

  // 1. OnRegister
  OnRegister: async ({ playFabId }) => {
    const player  = await db.one('SELECT * FROM players WHERE playfab_id = $1', [playFabId]);
    const items   = await db.all('SELECT * FROM inventory WHERE playfab_id = $1', [playFabId]);
    const skinInv = await readReadonlyData(playFabId, 'SkinInventory') || {};
    const bpState = await readReadonlyData(playFabId, 'BattlePassState') || {};
    return {
      Success:         true,
      PlayFabId:       playFabId,
      DisplayName:     player.display_name,
      CreatedAt:       player.created_at,
      Inventory:       items.map(i => ({ ItemId: i.item_id, ItemClass: i.item_class, InstanceId: i.instance_id })),
      VirtualCurrency: { GE: player.vc_ge, BB: player.vc_bb, DT: player.vc_dt, BP: player.vc_bp },
      SkinInventory:   skinInv,
      BattlePassState: bpState
    };
  },

  // 2. OnLogin
  OnLogin: async ({ playFabId }) => {
    await db.query('UPDATE players SET last_login = NOW() WHERE playfab_id = $1', [playFabId]);

    const dailyState = await readUserData(playFabId, 'DailyRewardState') || { LastClaimed: null, Streak: 0 };
    const last        = dailyState.LastClaimed ? new Date(dailyState.LastClaimed) : null;
    const now         = new Date();
    const hoursSince  = last ? (now - last) / 3_600_000 : 999;
    const available   = hoursSince >= 20;
    const streakValid = hoursSince < 48;

    return {
      Success:       true,
      ServerTime:    now.toISOString(),
      DailyReward: {
        Available:    available,
        Streak:       streakValid ? dailyState.Streak : 0,
        NextAvailableAt: last ? new Date(last.getTime() + 20 * 3_600_000).toISOString() : now.toISOString()
      }
    };
  },

  // 3. OnPlayerAdded
  OnPlayerAdded: async ({ playFabId, params }) => {
    const skin = params?.SelectedSkin || 'StarterCharacter';
    const counts = await readUserData(playFabId, 'SkinUsageCounts') || {};
    counts[skin] = (counts[skin] || 0) + 1;
    await writeUserData(playFabId, 'SkinUsageCounts', counts);
    return { Success: true, SelectedSkin: skin };
  },

  // 4. GetConfig
  GetConfig: async ({ titleData }) => titleData,

  // 5. GetShop
  GetShop: async ({ storesMap }) => ({
    StoreId:        'BattlePointsPacks',
    CatalogVersion: '1',
    Store:          storesMap.BattlePointsPacks || []
  }),

  // 6. GetBattlePass
  GetBattlePass: async ({ playFabId, titleData }) => {
    const state    = await readReadonlyData(playFabId, 'BattlePassState') || {};
    const config   = titleData?.BattlePassConfig ? JSON.parse(titleData.BattlePassConfig) : {};
    return {
      Season:               config.Season       || 1,
      Tier:                 state.Tier          || 0,
      XP:                   state.XP            || 0,
      HasPremium:           state.HasPremium    || false,
      MaxTier:              config.MaxTier      || 30,
      XPPerTier:            config.XPPerTier    || 1000,
      ClaimedFreeTiers:     state.ClaimedFreeTiers     || [],
      ClaimedPremiumTiers:  state.ClaimedPremiumTiers  || [],
      Rewards:              config.Rewards      || []
    };
  },

  // 7. GetPlayerInbox
  GetPlayerInbox: async ({ playFabId }) => {
    const inbox = await readUserData(playFabId, 'Inbox') || [];
    const now   = Date.now();
    const live  = inbox.filter(m => !m.ExpiryDate || new Date(m.ExpiryDate).getTime() > now);
    return { Items: live, HasMore: false, TotalCount: live.length };
  },

  // 8. ReportMatch
  // FIX: applies active economy event multipliers (double_xp, bonus_vc).
  ReportMatch: async ({ playFabId, params }) => {
    const { Placement = 1, Kills = 0, MatchDuration = 120, SelectedSkin = 'StarterCharacter' } = params || {};
    const player   = await db.one('SELECT * FROM players WHERE playfab_id = $1', [playFabId]);
    const stats    = await getPlayerStats(playFabId);

    const isWin    = Placement === 1;

    // Apply active economy event multipliers
    const { xpMultiplier, vcMultiplier } = await getActiveEventMultipliers();

    const baseXP   = 50 + (Kills * 10) + (isWin ? 100 : Math.max(0, 50 - Placement));
    const xpGained = Math.round(baseXP * xpMultiplier);
    const baseBB   = isWin ? 20 : 5;
    const bbGained = Math.round(baseBB * vcMultiplier.BB);

    const newKills   = (stats.Kills   || 0) + Kills;
    const newWins    = (stats.Wins    || 0) + (isWin ? 1 : 0);
    const newXP      = (stats.XP     || 0) + xpGained;
    const newMatches = (stats.Matches || 0) + 1;
    const displayName = player.display_name;

    await updateStat(playFabId, 'Kills',   newKills,   displayName);
    await updateStat(playFabId, 'Wins',    newWins,    displayName);
    await updateStat(playFabId, 'XP',      newXP,      displayName);
    await updateStat(playFabId, 'Matches', newMatches, null);

    // Invalidate leaderboard cache
    await Promise.all(['Kills','Wins','XP'].map(async (stat) => {
      const keys = await redis.keys(`cache:leaderboard:${stat}:*`).catch(() => []);
      if (keys.length) await redis.del(...keys).catch(() => {});
    }));

    // Award BB (already uses addCurrency which logs to currency_tx)
    await addCurrency(playFabId, 'BB', bbGained);

    // Award BattlePoints to skin
    const bpForSkin    = 20 + (Kills * 5) + (isWin ? 30 : 0);
    const skinInv      = await readReadonlyData(playFabId, 'SkinInventory') || {};
    const entry        = skinInv[SelectedSkin] || { BattlePoints: 0, Level: 1, UnlockedAltSkins: [] };
    entry.BattlePoints = (entry.BattlePoints || 0) + bpForSkin;
    entry.Level        = getSkinLevel(entry.BattlePoints);
    skinInv[SelectedSkin] = entry;
    await writeReadonlyData(playFabId, 'SkinInventory', skinInv);

    // Match box token
    const mbData       = await readUserData(playFabId, 'MatchBoxTokenData') || { Tokens: 0, MaxTokens: 5, OpenedBoxes: 0 };
    const tokensToAdd  = isWin ? 2 : 1;
    mbData.Tokens      = Math.min((mbData.Tokens || 0) + tokensToAdd, mbData.MaxTokens || 5);
    mbData.LastTokenGrantTime = new Date().toISOString();
    await writeUserData(playFabId, 'MatchBoxTokenData', mbData);

    // Battle pass XP
    const bpState      = await readReadonlyData(playFabId, 'BattlePassState') || { Season: 1, Tier: 0, XP: 0, HasPremium: false, ClaimedFreeTiers: [], ClaimedPremiumTiers: [] };
    bpState.XP         = (bpState.XP || 0) + xpGained;
    const xpPerTier    = 1000;
    const newTier      = Math.min(Math.floor(bpState.XP / xpPerTier), 30);
    const tierUp       = newTier > (bpState.Tier || 0);
    bpState.Tier       = newTier;
    await writeReadonlyData(playFabId, 'BattlePassState', bpState);

    return {
      Success:    true,
      EventBonus: { XPMultiplier: xpMultiplier, BBMultiplier: vcMultiplier.BB },
      Rewards: {
        XP:              xpGained,
        BB:              bbGained,
        SkinBP:        { Skin: SelectedSkin, Amount: bpForSkin },
        MatchBoxTokens:  tokensToAdd,
        SkinLevelUp:     tierUp ? { NewLevel: entry.Level } : null
      },
      Stats: { Kills: newKills, Wins: newWins, XP: newXP, Matches: newMatches },
      BattlePass: { Tier: bpState.Tier, XP: bpState.XP, TierUp: tierUp }
    };
  },

  // 9. GetPlayerData
  GetPlayerData: async ({ playFabId }) => {
    const rows = await db.all('SELECT key, value, last_updated FROM user_data WHERE playfab_id = $1', [playFabId]);
    return { Data: Object.fromEntries(rows.map(r => [r.key, { Value: r.value, LastUpdated: r.last_updated }])) };
  },

  // 10. GetSkinInventory
  GetSkinInventory: async ({ playFabId }) => {
    const skinInv = await readReadonlyData(playFabId, 'SkinInventory') || {};
    return { SkinInventory: skinInv };
  },

  // 11. UpdateSkinBattlePoints
  UpdateSkinBattlePoints: async ({ playFabId, params }) => {
    const { SkinId, Amount = 0 } = params || {};
    if (!SkinId) return { Success: false, Error: 'SkinId required' };
    const skinInv  = await readReadonlyData(playFabId, 'SkinInventory') || {};
    const entry    = skinInv[SkinId] || { BattlePoints: 0, Level: 1, UnlockedAltSkins: [] };
    entry.BattlePoints = Math.max(0, (entry.BattlePoints || 0) + Number(Amount));
    const oldLevel     = entry.Level || 1;
    entry.Level        = getSkinLevel(entry.BattlePoints);
    skinInv[SkinId]    = entry;
    await writeReadonlyData(playFabId, 'SkinInventory', skinInv);
    return {
      Success:     true,
      SkinId,
      BattlePoints: entry.BattlePoints,
      Level:        entry.Level,
      LevelUp:      entry.Level > oldLevel
    };
  },

  // 12. UnlockSkinAlt
  // FIX: atomic UPDATE with WHERE balance >= Cost (was SELECT->check->UPDATE race).
  UnlockSkinAlt: async ({ playFabId, params }) => {
    const { SkinId, AltSkinId, Cost = 0, CostCurrency = 'BB' } = params || {};
    if (!SkinId || !AltSkinId) return { Success: false, Error: 'SkinId and AltSkinId required' };
    const skinInv = await readReadonlyData(playFabId, 'SkinInventory') || {};
    const entry   = skinInv[SkinId];
    if (!entry) return { Success: false, Error: 'Skin not found in inventory' };
    if ((entry.UnlockedAltSkins || []).includes(AltSkinId)) return { Success: false, Error: 'Already unlocked' };

    if (Cost > 0) {
      const cols = { GE: 'vc_ge', BB: 'vc_bb', DT: 'vc_dt', BP: 'vc_bp' };
      const col  = cols[CostCurrency];
      if (!col) return { Success: false, Error: 'Invalid currency' };

      // Atomic: deduct only if balance is sufficient - no race condition
      const updated = await db.one(
        `UPDATE players SET ${col} = ${col} - $1
          WHERE playfab_id = $2 AND ${col} >= $1
          RETURNING ${col} AS balance`,
        [Cost, playFabId]
      );
      if (!updated) return { Success: false, Error: 'InsufficientFunds' };

      logCurrencyTx({ playFabId, currency: CostCurrency, delta: -Cost, balanceAfter: updated.balance, source: 'game', reason: `UnlockSkinAlt:${SkinId}:${AltSkinId}` }).catch(() => {});
    }

    entry.UnlockedAltSkins = [...(entry.UnlockedAltSkins || []), AltSkinId];
    skinInv[SkinId] = entry;
    await writeReadonlyData(playFabId, 'SkinInventory', skinInv);
    return { Success: true, SkinId, AltSkinId, UnlockedAltSkins: entry.UnlockedAltSkins };
  },

  // 13. ClaimBattlePassReward
  // FIX: Redis lock prevents double-claiming the same tier concurrently.
  ClaimBattlePassReward: async ({ playFabId, params, titleData }) => {
    const { Tier, IsPremium = false } = params || {};
    if (Tier == null) return { Success: false, Error: 'Tier required' };

    const lockKey = `battlepass:claim:${playFabId}:${Tier}:${IsPremium ? 'p' : 'f'}`;
    const locked  = await acquireLock(lockKey);
    if (!locked) return { Success: false, Error: 'ClaimInProgress' };

    try {
      const bpState = await readReadonlyData(playFabId, 'BattlePassState') || {};
      if ((bpState.Tier || 0) < Tier) return { Success: false, Error: 'Tier not reached yet' };
      const key     = IsPremium ? 'ClaimedPremiumTiers' : 'ClaimedFreeTiers';
      const claimed = bpState[key] || [];
      if (claimed.includes(Tier)) return { Success: false, Error: 'Already claimed' };
      if (IsPremium && !bpState.HasPremium) return { Success: false, Error: 'Premium pass not owned' };

      const config     = titleData?.BattlePassConfig ? JSON.parse(titleData.BattlePassConfig) : {};
      const rewards    = config.Rewards || [];
      const tierReward = rewards.find(r => r.Tier === Tier);
      const reward     = tierReward ? (IsPremium ? tierReward.Premium : tierReward.Free) : null;

      if (reward?.Currency && reward?.Amount) {
        await addCurrency(playFabId, reward.Currency, reward.Amount);
      }

      bpState[key] = [...claimed, Tier];
      await writeReadonlyData(playFabId, 'BattlePassState', bpState);
      return { Success: true, Tier, IsPremium, Reward: reward };
    } finally {
      await releaseLock(lockKey);
    }
  },

  // 14. PurchaseBattlePass
  // FIX: atomic UPDATE with WHERE vc_bb >= price (was SELECT->check->UPDATE race).
  PurchaseBattlePass: async ({ playFabId, params, titleData }) => {
    const config  = titleData?.BattlePassConfig ? JSON.parse(titleData.BattlePassConfig) : {};
    const price   = config.PremiumPrice || 950;

    const updated = await db.one(
      `UPDATE players SET vc_bb = vc_bb - $1
        WHERE playfab_id = $2 AND vc_bb >= $1
        RETURNING vc_bb AS balance`,
      [price, playFabId]
    );
    if (!updated) {
      const p = await db.one('SELECT vc_bb FROM players WHERE playfab_id = $1', [playFabId]);
      return { Success: false, Error: 'InsufficientFunds', Required: price, Have: p?.vc_bb ?? 0 };
    }

    logCurrencyTx({ playFabId, currency: 'BB', delta: -price, balanceAfter: updated.balance, source: 'game', reason: 'PurchaseBattlePass' }).catch(() => {});

    const bpState = await readReadonlyData(playFabId, 'BattlePassState') || {};
    bpState.HasPremium = true;
    await writeReadonlyData(playFabId, 'BattlePassState', bpState);
    return { Success: true, HasPremium: true, BBSpent: price };
  },

  // 15. GetTrophyRewards
  GetTrophyRewards: async ({ playFabId, titleData }) => {
    const stats    = await getPlayerStats(playFabId);
    const trophies = stats.Wins || 0;
    const data     = await readUserData(playFabId, 'TrophyRewardsData') || { LastClaimedTier: -1, ClaimedTiers: [] };
    const config   = titleData?.TrophyRoadConfig ? JSON.parse(titleData.TrophyRoadConfig) : {};
    return {
      TrophyCount:      trophies,
      LastClaimedTier:  data.LastClaimedTier,
      ClaimedTiers:     data.ClaimedTiers || [],
      Tiers:            config.Tiers || []
    };
  },

  // 16. ClaimTrophyReward
  ClaimTrophyReward: async ({ playFabId, params, titleData }) => {
    const { TierIndex } = params || {};
    if (TierIndex == null) return { Success: false, Error: 'TierIndex required' };
    const config   = titleData?.TrophyRoadConfig ? JSON.parse(titleData.TrophyRoadConfig) : {};
    const tier     = (config.Tiers || [])[TierIndex];
    if (!tier) return { Success: false, Error: 'Tier not found' };
    const stats    = await getPlayerStats(playFabId);
    const trophies = stats.Wins || 0;
    if (trophies < tier.RequiredTrophies) return { Success: false, Error: 'Not enough trophies' };
    const data     = await readUserData(playFabId, 'TrophyRewardsData') || { LastClaimedTier: -1, ClaimedTiers: [] };
    if ((data.ClaimedTiers || []).includes(TierIndex)) return { Success: false, Error: 'Already claimed' };
    if (tier.Reward?.Currency && tier.Reward?.Amount) {
      await addCurrency(playFabId, tier.Reward.Currency, tier.Reward.Amount);
    }
    data.ClaimedTiers    = [...(data.ClaimedTiers || []), TierIndex];
    data.LastClaimedTier = TierIndex;
    await writeUserData(playFabId, 'TrophyRewardsData', data);
    return { Success: true, TierIndex, Reward: tier.Reward };
  },

  // 17. GetMatchBoxData
  GetMatchBoxData: async ({ playFabId, titleData }) => {
    const data   = await readUserData(playFabId, 'MatchBoxTokenData') || { Tokens: 0, MaxTokens: 5, OpenedBoxes: 0 };
    const config = titleData?.MatchBoxConfig ? JSON.parse(titleData.MatchBoxConfig) : { Tiers: [] };
    return {
      Tokens:            data.Tokens      || 0,
      MaxTokens:         data.MaxTokens   || 5,
      OpenedBoxes:       data.OpenedBoxes || 0,
      LastTokenGrantTime: data.LastTokenGrantTime || null,
      BoxTiers:          config.Tiers     || []
    };
  },

  // 18. OpenMatchBox
  // FIX: item rewards now actually granted (was currency-only despite code stub).
  OpenMatchBox: async ({ playFabId, params, titleData }) => {
    const cost = Number(params?.TokenCost) || 1;
    const data = await readUserData(playFabId, 'MatchBoxTokenData') || { Tokens: 0, MaxTokens: 5, OpenedBoxes: 0 };
    if ((data.Tokens || 0) < cost) return { Success: false, Error: 'Not enough tokens', Have: data.Tokens || 0, Need: cost };

    data.Tokens      = (data.Tokens || 0) - cost;
    data.OpenedBoxes = (data.OpenedBoxes || 0) + 1;

    // Loot table: 5% GE gem, 20% 100BB, 30% 50BB, 45% 25BB
    // If MatchBoxConfig has LootItems, use those instead
    const config     = titleData?.MatchBoxConfig ? JSON.parse(titleData.MatchBoxConfig) : {};
    const lootItems  = config.LootItems || [];

    let reward;
    if (lootItems.length) {
      const totalWeight = lootItems.reduce((s, it) => s + (it.Weight || 1), 0);
      let rand = Math.random() * totalWeight;
      for (const it of lootItems) {
        rand -= (it.Weight || 1);
        if (rand <= 0) { reward = it; break; }
      }
      reward = reward || lootItems[lootItems.length - 1];
    } else {
      // Built-in fallback table
      const roll = Math.random();
      if      (roll < 0.05) reward = { Type: 'Currency', Currency: 'GE', Amount: 1 };
      else if (roll < 0.25) reward = { Type: 'Currency', Currency: 'BB', Amount: 100 };
      else if (roll < 0.55) reward = { Type: 'Currency', Currency: 'BB', Amount: 50 };
      else                  reward = { Type: 'Currency', Currency: 'BB', Amount: 25 };
    }

    if (reward.Type === 'Currency') {
      await addCurrency(playFabId, reward.Currency, reward.Amount);
    } else if (reward.Type === 'Item' && reward.ItemId) {
      // Grant catalog item to inventory
      await db.query(
        `INSERT INTO inventory
           (instance_id, playfab_id, item_id, item_class, catalog_version,
            display_name, unit_price, remaining_uses, purchase_date)
         VALUES ($1, $2, $3, $4, '1', $3, 0, $5, NOW())`,
        [randomUUID(), playFabId, reward.ItemId, reward.ItemClass || 'BoxReward', reward.Quantity > 1 ? reward.Quantity : null]
      ).catch(() => {});
    }

    await writeUserData(playFabId, 'MatchBoxTokenData', data);
    return {
      Success:      true,
      TokensSpent:  cost,
      TokensLeft:   data.Tokens,
      OpenedBoxes:  data.OpenedBoxes,
      Reward:       reward
    };
  },

  // 19. AddMatchBoxTokens
  AddMatchBoxTokens: async ({ playFabId, params }) => {
    const amount = Number(params?.Amount) || 1;
    const data   = await readUserData(playFabId, 'MatchBoxTokenData') || { Tokens: 0, MaxTokens: 5, OpenedBoxes: 0 };
    data.Tokens  = Math.min((data.Tokens || 0) + amount, data.MaxTokens || 5);
    data.LastTokenGrantTime = new Date().toISOString();
    await writeUserData(playFabId, 'MatchBoxTokenData', data);
    return { Success: true, Tokens: data.Tokens, MaxTokens: data.MaxTokens };
  },

  // 20. GetMessageStates
  GetMessageStates: async ({ playFabId }) => {
    const states = await readUserData(playFabId, 'MessageStates') || {};
    return { MessageStates: states };
  },

  // 21. UpdateMessageStates
  UpdateMessageStates: async ({ playFabId, params }) => {
    const { MessageId, Read = false, Claimed = false } = params || {};
    if (!MessageId) return { Success: false, Error: 'MessageId required' };
    const states = await readUserData(playFabId, 'MessageStates') || {};
    states[MessageId] = { ...(states[MessageId] || {}), Read, Claimed };
    await writeUserData(playFabId, 'MessageStates', states);
    return { Success: true, MessageId, State: states[MessageId] };
  },

  // 22. ClaimInboxReward
  // FIX: Redis lock prevents double-claiming the same message concurrently.
  ClaimInboxReward: async ({ playFabId, params }) => {
    const { MessageId } = params || {};
    if (!MessageId) return { Success: false, Error: 'MessageId required' };

    const lockKey = `inbox:claim:${playFabId}:${MessageId}`;
    const locked  = await acquireLock(lockKey);
    if (!locked) return { Success: false, Error: 'ClaimInProgress' };

    try {
      const inbox = await readUserData(playFabId, 'Inbox') || [];
      const idx   = inbox.findIndex(m => m.Id === MessageId);
      if (idx === -1)         return { Success: false, Error: 'Message not found' };
      if (inbox[idx].Claimed) return { Success: false, Error: 'Already claimed' };

      const { Reward } = inbox[idx];
      if (Reward?.Currency && Reward?.Amount) await addCurrency(playFabId, Reward.Currency, Reward.Amount);
      if (Reward?.ItemId) {
        await db.query(
          `INSERT INTO inventory (instance_id, playfab_id, item_id, item_class, catalog_version, display_name)
           VALUES ($1, $2, $3, $4, '1', $3)`,
          [randomUUID(), playFabId, Reward.ItemId, Reward.ItemClass || 'Item']
        );
      }

      inbox[idx].Claimed   = true;
      inbox[idx].ClaimedAt = new Date().toISOString();
      await writeUserData(playFabId, 'Inbox', inbox);

      const states = await readUserData(playFabId, 'MessageStates') || {};
      states[MessageId] = { ...states[MessageId], Read: true, Claimed: true };
      await writeUserData(playFabId, 'MessageStates', states);

      return { Success: true, MessageId, Reward };
    } finally {
      await releaseLock(lockKey);
    }
  },

  // 23. DismissInboxItem
  DismissInboxItem: async ({ playFabId, params }) => {
    const { MessageId } = params || {};
    if (!MessageId) return { Success: false, Error: 'MessageId required' };
    const inbox    = await readUserData(playFabId, 'Inbox') || [];
    const filtered = inbox.filter(m => m.Id !== MessageId);
    await writeUserData(playFabId, 'Inbox', filtered);
    return { Success: true, MessageId, RemainingCount: filtered.length };
  },

  // 24. UseConsumable
  UseConsumable: async ({ playFabId, params }) => {
    const { ItemId } = params || {};
    if (!ItemId) return { Success: false, Error: 'ItemId required' };
    const inv  = await readReadonlyData(playFabId, 'ConsumableInventory') || {};
    const have = inv[ItemId] || 0;
    if (have <= 0) return { Success: false, Error: 'Consumable not available', ItemId };
    inv[ItemId] = have - 1;
    if (inv[ItemId] <= 0) delete inv[ItemId];
    await writeReadonlyData(playFabId, 'ConsumableInventory', inv);
    return { Success: true, ItemId, Remaining: inv[ItemId] || 0 };
  },

  // 25. GrantConsumable
  GrantConsumable: async ({ playFabId, params }) => {
    const { ItemId, Amount = 1 } = params || {};
    if (!ItemId) return { Success: false, Error: 'ItemId required' };
    const inv   = await readReadonlyData(playFabId, 'ConsumableInventory') || {};
    inv[ItemId] = (inv[ItemId] || 0) + Number(Amount);
    await writeReadonlyData(playFabId, 'ConsumableInventory', inv);
    return { Success: true, ItemId, Total: inv[ItemId] };
  },

  // 26. GetSeasonHistory
  GetSeasonHistory: async ({ playFabId }) => {
    const history = await readUserData(playFabId, 'SeasonStatsHistory') || [];
    return { History: history };
  },

  // 27. ArchiveSeason
  // FIX: leaderboard_entries now reset to 0 alongside player_statistics.
  //      Previously updateStat(null) silently skipped the leaderboard update.
  ArchiveSeason: async ({ playFabId, params, titleData }) => {
    const config  = titleData?.BattlePassConfig ? JSON.parse(titleData.BattlePassConfig) : {};
    const season  = config.Season || 1;
    const stats   = await getPlayerStats(playFabId);
    const history = await readUserData(playFabId, 'SeasonStatsHistory') || [];

    history.push({
      Season:    season,
      Kills:     stats.Kills   || 0,
      Wins:      stats.Wins    || 0,
      XP:        stats.XP      || 0,
      Matches:   stats.Matches || 0,
      ArchivedAt: new Date().toISOString()
    });
    await writeUserData(playFabId, 'SeasonStatsHistory', history);

    // Reset current stats AND leaderboard entries to 0
    const player = await db.one('SELECT display_name FROM players WHERE playfab_id = $1', [playFabId]);
    for (const name of ['Kills', 'Wins', 'XP', 'Matches']) {
      await updateStat(playFabId, name, 0, player.display_name);
    }

    // Reset battle pass
    await writeReadonlyData(playFabId, 'BattlePassState', {
      Season: season + 1, Tier: 0, XP: 0,
      HasPremium: false, ClaimedFreeTiers: [], ClaimedPremiumTiers: []
    });

    // Invalidate leaderboard caches
    const keys = await redis.keys('cache:leaderboard:*').catch(() => []);
    if (keys.length) await redis.del(...keys).catch(() => {});

    return { Success: true, ArchivedSeason: season, History: history };
  },

  // 28. UpdateSkinUsageCounts
  UpdateSkinUsageCounts: async ({ playFabId, params }) => {
    const updates = params?.Updates || {};
    if (!Object.keys(updates).length) return { Success: false, Error: 'Updates required' };
    const counts  = await readUserData(playFabId, 'SkinUsageCounts') || {};
    for (const [skinId, amount] of Object.entries(updates)) {
      counts[skinId] = (counts[skinId] || 0) + Number(amount);
    }
    await writeUserData(playFabId, 'SkinUsageCounts', counts);
    return { Success: true, SkinUsageCounts: counts };
  },

  // 29. GetLeaderboardData
  GetLeaderboardData: async ({ playFabId, params }) => {
    const statName = params?.StatisticName || 'Wins';
    const limit    = Math.min(Number(params?.MaxResults) || 10, 100);
    const cacheKey = `cache:leaderboard:${statName}:0:${limit}`;
    const cached   = await redis.get(cacheKey).catch(() => null);
    const entries  = cached ? JSON.parse(cached) : await db.all(
      `SELECT playfab_id, display_name, stat_value
         FROM leaderboard_entries WHERE statistic_name = $1
         ORDER BY stat_value DESC LIMIT $2`,
      [statName, limit]
    );
    if (!cached) await redis.setex(cacheKey, 30, JSON.stringify(entries)).catch(() => {});
    const ownStat = await db.one(
      'SELECT stat_value FROM leaderboard_entries WHERE statistic_name = $1 AND playfab_id = $2',
      [statName, playFabId]
    );
    return {
      StatisticName: statName,
      Leaderboard:   entries.map((r, i) => ({ Position: i, PlayFabId: r.playfab_id, DisplayName: r.display_name, Value: r.stat_value })),
      PlayerRank:    ownStat ? entries.findIndex(e => e.playfab_id === playFabId) : -1,
      PlayerValue:   ownStat?.stat_value || 0
    };
  },

  // 30. GetDailyReward
  GetDailyReward: async ({ playFabId, titleData }) => {
    const state    = await readUserData(playFabId, 'DailyRewardState') || { LastClaimed: null, Streak: 0 };
    const last     = state.LastClaimed ? new Date(state.LastClaimed) : null;
    const hoursSince = last ? (Date.now() - last.getTime()) / 3_600_000 : 999;
    const available  = hoursSince >= 20;
    const config     = titleData?.DailyRewardConfig ? JSON.parse(titleData.DailyRewardConfig) : {};
    const rewards    = config.Rewards || [{ Day: 1, Currency: 'BB', Amount: 50 }];
    const streak     = (hoursSince < 48 ? state.Streak : 0);
    const dayIndex   = Math.min(streak, rewards.length - 1);
    return {
      Available:       available,
      Streak:          streak,
      NextReward:      rewards[dayIndex],
      NextAvailableAt: last ? new Date(last.getTime() + 20 * 3_600_000).toISOString() : new Date().toISOString(),
      AllRewards:      rewards
    };
  },

  // 31. ClaimDailyReward
  // FIX: Redis lock prevents double-claiming (was read->check->write race).
  ClaimDailyReward: async ({ playFabId, titleData }) => {
    const lockKey = `daily:claim:${playFabId}`;
    const locked  = await acquireLock(lockKey);
    if (!locked) return { Success: false, Error: 'ClaimInProgress' };

    try {
      const state      = await readUserData(playFabId, 'DailyRewardState') || { LastClaimed: null, Streak: 0 };
      const last       = state.LastClaimed ? new Date(state.LastClaimed) : null;
      const hoursSince = last ? (Date.now() - last.getTime()) / 3_600_000 : 999;
      if (hoursSince < 20) return { Success: false, Error: 'Not available yet', HoursRemaining: (20 - hoursSince).toFixed(1) };

      const config   = titleData?.DailyRewardConfig ? JSON.parse(titleData.DailyRewardConfig) : {};
      const rewards  = config.Rewards || [{ Day: 1, Currency: 'BB', Amount: 50 }];
      const streak   = hoursSince < 48 ? (state.Streak || 0) : 0;
      const dayIndex = Math.min(streak, rewards.length - 1);
      const reward   = rewards[dayIndex];

      if (reward?.Currency && reward?.Amount) await addCurrency(playFabId, reward.Currency, reward.Amount);

      const newStreak = streak + 1;
      await writeUserData(playFabId, 'DailyRewardState', { LastClaimed: new Date().toISOString(), Streak: newStreak });
      return { Success: true, Reward: reward, NewStreak: newStreak };
    } finally {
      await releaseLock(lockKey);
    }
  },

  // 32. ReportPlayer
  // FIX: writes to player_reports table (was incorrectly using requests_log).
  ReportPlayer: async ({ playFabId, params }) => {
    const { ReportedPlayFabId, Reason = 'Unknown', Comment = '', MatchContext = null } = params || {};
    if (!ReportedPlayFabId) return { Success: false, Error: 'ReportedPlayFabId required' };

    const reportId = randomUUID();
    await db.query(
      `INSERT INTO player_reports
         (id, reporter_playfab_id, reported_playfab_id, reason, comment, match_context)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [reportId, playFabId, ReportedPlayFabId, Reason, Comment || null,
       MatchContext ? JSON.stringify(MatchContext) : null]
    ).catch((err) => console.error('[ReportPlayer] DB insert failed:', err.message));

    return { Success: true, ReportId: reportId, Message: 'Report received' };
  },

  // 33. SetPlayerFlags
  SetPlayerFlags: async ({ playFabId, params }) => {
    const flags   = params?.Flags || {};
    if (!Object.keys(flags).length) return { Success: false, Error: 'Flags required' };
    const current = await readUserData(playFabId, 'PlayerFlags') || {};
    const merged  = { ...current, ...flags };
    await writeUserData(playFabId, 'PlayerFlags', merged);
    return { Success: true, Flags: merged };
  },

  // 34. GetPlayerFlags
  // NEW: read flags set by SetPlayerFlags (was missing - asymmetric API).
  GetPlayerFlags: async ({ playFabId, params }) => {
    const flags = await readUserData(playFabId, 'PlayerFlags') || {};
    const keys  = params?.Keys;
    const result = keys?.length
      ? Object.fromEntries(Object.entries(flags).filter(([k]) => keys.includes(k)))
      : flags;
    return { Success: true, Flags: result };
  },

  // 35. LinkDiscordAccount
  // Called from in-game Settings -> "Link Discord Account".
  // Uses direct service call (no HTTP round-trip) - faster, no token exposure.
  LinkDiscordAccount: async ({ playFabId, params }) => {
    const code = String(params?.Code || '').toUpperCase().trim();
    if (!code) return { Success: false, Error: 'Code is required.' };
    const svc = require('./discordLink');
    try {
      const result = await svc.claimLinkCode(code, playFabId);
      return {
        Success:     true,
        DiscordTag:  result.discordTag,
        DisplayName: result.displayName,
        Message:     `Discord ${result.discordTag} linked successfully!`,
      };
    } catch (err) {
      return { Success: false, Error: err.message };
    }
  },
};

// dispatcher

async function executeCloudScript(req) {
  const functionName = req.body?.FunctionName || 'Unknown';
  const params       = req.body?.FunctionParameter || {};
  const t0           = Date.now();

  const ctx = {
    playFabId: req.playFabId,
    params,
    titleData: req.app.locals.titleData,
    storesMap: req.app.locals.stores
  };

  let result = null;
  let logs   = [];

  if (HANDLERS[functionName]) {
    try {
      result = await HANDLERS[functionName](ctx);
    } catch (err) {
      console.error(`[CloudScript] ${functionName}: ${err.message}`);
      logs.push({ Level: 'Error', Data: {}, Message: `${functionName} threw: ${err.message}` });
      result = { success: false, error: err.message };
    }
  } else {
    logs.push({
      Level:   'Warning',
      Data:    {},
      Message: `CloudScript function '${functionName}' is not implemented on this private server.`
    });
    result = { success: true };
  }

  const durationMs = Date.now() - t0;
  const success = !(result && result.success === false);

  db.query(
    `INSERT INTO cloudscript_calls (function_name, player_id, admin_email, source, parameters, result, success, error_message, duration_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      functionName,
      req.playFabId || null,
      req.adminEmail || null,
      req.adminEmail ? 'admin' : 'client',
      JSON.stringify(params || {}),
      JSON.stringify(result || {}),
      success,
      success ? null : (result && result.error) || null,
      durationMs,
    ]
  ).catch((err) => console.error(`[CloudScript] history log failed: ${err.message}`));

  return {
    FunctionName:           functionName,
    Revision:               1,
    ExecutionTimeSeconds:   durationMs / 1000,
    Logs:                   logs,
    FunctionResult:         result,
    FunctionResultTooLarge: false,
    LogsTooLarge:           false
  };
}

module.exports = {
  executeCloudScript,
  implementedFunctions: Object.keys(HANDLERS)
};
