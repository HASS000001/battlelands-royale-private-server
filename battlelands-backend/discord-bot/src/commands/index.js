'use strict';
/**
 * Discord commands for moderator tools and player self-service.
 */

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { apiCall } = require('../api');
const { hasMod, hasAdmin } = require('../perms');

// SECTION 1 - helpers & admin/mod commands

// helper

function E(color, title, desc, fields = []) {
  const e = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(desc)
    .setTimestamp();
  if (fields.length) e.addFields(fields);
  return e;
}

const OK  = 0x10b981; // green
const ERR = 0xef4444; // red
const INF = 0x3b82f6; // blue
const WRN = 0xf59e0b; // yellow

async function deny(i) {
  return i.reply({ embeds: [E(ERR, 'Access denied', 'You need the Moderator or Admin role to use this command.')], ephemeral: true });
}

async function wrap(i, fn) {
  await i.deferReply({ ephemeral: true });
  try {
    await fn();
  } catch (err) {
    await i.editReply({ embeds: [E(ERR, 'Error', err.message)] });
  }
}

// /playerinfo

const playerinfo = {
  data: new SlashCommandBuilder()
    .setName('playerinfo')
    .setDescription('Look up a player by PlayFabId or display name')
    .addStringOption(o => o.setName('query').setDescription('PlayFabId, DisplayName, or CustomId').setRequired(true)),

  async execute(i) {
    if (!hasMod(i.member)) return deny(i);
    await wrap(i, async () => {
      const q = i.options.getString('query');
      const d = await apiCall('GET', `/api/players?search=${encodeURIComponent(q)}&limit=5`);
      const rows = d.rows || [];
      if (!rows.length) return i.editReply({ embeds: [E(WRN, 'Not found', `No player found for \`${q}\``)] });
      const fields = rows.map(p => ({
        name: `${p.display_name} (${p.playfab_id})`,
        value: `GE: ${p.vc_ge} | BB: ${p.vc_bb} | Last login: ${String(p.last_login || '-').slice(0,10)}${p.banned ? ' |  BANNED' : ''}`,
      }));
      await i.editReply({ embeds: [E(INF, ` Search: ${q}`, `Found ${rows.length} result(s)`, fields)] });
    });
  },
};

// /balance

const balance = {
  data: new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Show a player\'s currency balances')
    .addStringOption(o => o.setName('player').setDescription('PlayFabId').setRequired(true)),

  async execute(i) {
    if (!hasMod(i.member)) return deny(i);
    await wrap(i, async () => {
      const id = i.options.getString('player');
      const d = await apiCall('GET', `/api/player/${encodeURIComponent(id)}`);
      const p = d.player || {};
      await i.editReply({
        embeds: [E(INF, ` ${p.display_name || id}`, `PlayFabId: \`${id}\``, [
          { name: 'GE (Gold)',        value: String(p.vc_ge ?? 0), inline: true },
          { name: 'BB (BattlePass)',  value: String(p.vc_bb ?? 0), inline: true },
          { name: 'DT (Diamond)',     value: String(p.vc_dt ?? 0), inline: true },
          { name: 'BP (BattlePoint)', value: String(p.vc_bp ?? 0), inline: true },
        ])],
      });
    });
  },
};

// /addcurrency

const addcurrency = {
  data: new SlashCommandBuilder()
    .setName('addcurrency')
    .setDescription('Add or subtract currency from a player')
    .addStringOption(o => o.setName('player').setDescription('PlayFabId').setRequired(true))
    .addStringOption(o => o.setName('currency').setDescription('GE / BB / DT / BP').setRequired(true)
      .addChoices({ name: 'GE (Gold)', value: 'GE' }, { name: 'BB (BattlePass)', value: 'BB' }, { name: 'DT (Diamond)', value: 'DT' }, { name: 'BP (BattlePoint)', value: 'BP' }))
    .addIntegerOption(o => o.setName('amount').setDescription('Amount (negative to remove)').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason for the adjustment').setRequired(false)),

  async execute(i) {
    if (!hasMod(i.member)) return deny(i);
    await wrap(i, async () => {
      const id       = i.options.getString('player');
      const currency = i.options.getString('currency');
      const amount   = i.options.getInteger('amount');
      const reason   = i.options.getString('reason') || `Discord: ${i.user.tag}`;
      await apiCall('POST', `/api/player/${encodeURIComponent(id)}/currency`, { currency, amount, reason });
      const sign = amount >= 0 ? '+' : '';
      await i.editReply({
        embeds: [E(OK, 'Currency updated', `Player \`${id}\`\n**${currency}** ${sign}${amount}\nReason: ${reason}`)],
      });
    });
  },
};

// /grantitem

const grantitem = {
  data: new SlashCommandBuilder()
    .setName('grantitem')
    .setDescription('Grant a catalog item to a player')
    .addStringOption(o => o.setName('player').setDescription('PlayFabId').setRequired(true))
    .addStringOption(o => o.setName('itemid').setDescription('ItemId from the catalog').setRequired(true))
    .addStringOption(o => o.setName('class').setDescription('ItemClass (optional)').setRequired(false))
    .addIntegerOption(o => o.setName('uses').setDescription('Remaining uses (blank = unlimited)').setRequired(false)),

  async execute(i) {
    if (!hasMod(i.member)) return deny(i);
    await wrap(i, async () => {
      const id     = i.options.getString('player');
      const itemId = i.options.getString('itemid');
      const cls    = i.options.getString('class') || null;
      const uses   = i.options.getInteger('uses') ?? null;
      await apiCall('POST', `/api/player/${encodeURIComponent(id)}/inventory`, { itemId, itemClass: cls, remainingUses: uses });
      await i.editReply({ embeds: [E(OK, 'Item granted', `\`${itemId}\` -> \`${id}\``)] });
    });
  },
};

// /setstats

const setstats = {
  data: new SlashCommandBuilder()
    .setName('setstats')
    .setDescription('Set a player statistic (Wins, Kills, XP, ...)')
    .addStringOption(o => o.setName('player').setDescription('PlayFabId').setRequired(true))
    .addStringOption(o => o.setName('stat').setDescription('Statistic name').setRequired(true))
    .addIntegerOption(o => o.setName('value').setDescription('New value').setRequired(true)),

  async execute(i) {
    if (!hasAdmin(i.member)) return deny(i);
    await wrap(i, async () => {
      const id   = i.options.getString('player');
      const stat = i.options.getString('stat');
      const val  = i.options.getInteger('value');
      await apiCall('POST', `/api/player/${encodeURIComponent(id)}/stats`, { statisticName: stat, value: val });
      await i.editReply({ embeds: [E(OK, 'Stat updated', `\`${stat}\` = **${val}** for \`${id}\``)] });
    });
  },
};

// /ban

const ban = {
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a player')
    .addStringOption(o => o.setName('player').setDescription('PlayFabId').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Ban reason (shown to player)').setRequired(true))
    .addIntegerOption(o => o.setName('minutes').setDescription('Duration in minutes (blank = permanent)').setRequired(false)),

  async execute(i) {
    if (!hasAdmin(i.member)) return deny(i);
    await wrap(i, async () => {
      const id      = i.options.getString('player');
      const reason  = i.options.getString('reason');
      const minutes = i.options.getInteger('minutes') ?? null;
      await apiCall('POST', `/api/player/${encodeURIComponent(id)}/ban`, { reason, durationMinutes: minutes });
      const dur = minutes ? `${minutes} minutes` : 'permanent';
      await i.editReply({ embeds: [E(WRN, 'Player banned', `\`${id}\` - ${dur}\nReason: ${reason}`)] });
    });
  },
};

// /unban

const unban = {
  data: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Remove ban from a player')
    .addStringOption(o => o.setName('player').setDescription('PlayFabId').setRequired(true)),

  async execute(i) {
    if (!hasAdmin(i.member)) return deny(i);
    await wrap(i, async () => {
      const id = i.options.getString('player');
      await apiCall('POST', `/api/player/${encodeURIComponent(id)}/unban`, {});
      await i.editReply({ embeds: [E(OK, 'Unbanned', `\`${id}\` is now free to play.`)] });
    });
  },
};

// /wipe

const wipe = {
  data: new SlashCommandBuilder()
    .setName('wipe')
    .setDescription('Wipe all data for a player (irreversible)')
    .addStringOption(o => o.setName('player').setDescription('PlayFabId').setRequired(true))
    .addStringOption(o => o.setName('confirm').setDescription('Type CONFIRM to proceed').setRequired(true)),

  async execute(i) {
    if (!hasAdmin(i.member)) return deny(i);
    await wrap(i, async () => {
      const id      = i.options.getString('player');
      const confirm = i.options.getString('confirm');
      if (confirm !== 'CONFIRM') return i.editReply({ embeds: [E(ERR, 'Cancelled', 'You must type `CONFIRM` exactly.')] });
      await apiCall('POST', `/api/player/${encodeURIComponent(id)}/wipe`, {});
      await i.editReply({ embeds: [E(WRN, 'Account wiped', `\`${id}\` has been reset.`)] });
    });
  },
};

// /jobstatus

const jobstatus = {
  data: new SlashCommandBuilder()
    .setName('jobstatus')
    .setDescription('Check the status of a queued job')
    .addStringOption(o => o.setName('jobid').setDescription('Job ID returned by a bulk command').setRequired(true)),

  async execute(i) {
    if (!hasMod(i.member)) return deny(i);
    await wrap(i, async () => {
      const jobId = i.options.getString('jobid');
      const job = await apiCall('GET', `/api/jobs/${encodeURIComponent(jobId)}`);
      const statusColor = { done: OK, failed: ERR, running: WRN, queued: INF }[job.status] ?? INF;
      const result = job.result ? `\nProcessed: ${job.result.processed ?? '?'} | Failed: ${job.result.failed ?? 0}` : '';
      const error  = job.error ? `\nError: ${job.error}` : '';
      await i.editReply({
        embeds: [E(statusColor, ` Job: ${job.job_type}`, `Status: **${job.status}**${result}${error}\nQueued by: ${job.queued_by || '?'}`)],
      });
    });
  },
};

// /bulkcurrency

const bulkcurrency = {
  data: new SlashCommandBuilder()
    .setName('bulkcurrency')
    .setDescription('Add/remove currency for multiple players (queued job)')
    .addStringOption(o => o.setName('currency').setDescription('GE / BB / DT / BP').setRequired(true)
      .addChoices({ name: 'GE', value: 'GE' }, { name: 'BB', value: 'BB' }, { name: 'DT', value: 'DT' }, { name: 'BP', value: 'BP' }))
    .addIntegerOption(o => o.setName('amount').setDescription('Amount per player (negative to remove)').setRequired(true))
    .addStringOption(o => o.setName('playerids').setDescription('PlayFabIds separated by spaces or commas').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),

  async execute(i) {
    if (!hasAdmin(i.member)) return deny(i);
    await wrap(i, async () => {
      const currency  = i.options.getString('currency');
      const amount    = i.options.getInteger('amount');
      const raw       = i.options.getString('playerids');
      const reason    = i.options.getString('reason') || `Bulk from Discord: ${i.user.tag}`;
      const playFabIds = raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
      if (!playFabIds.length) throw new Error('No valid IDs provided');
      const d = await apiCall('POST', '/api/bulk/currency', { playFabIds, currency, amount, reason });
      await i.editReply({
        embeds: [E(OK, 'Bulk job queued', `**${playFabIds.length}** players | ${currency} ${amount >= 0 ? '+' : ''}${amount}\nJob ID: \`${d.jobId}\`\nUse \`/jobstatus\` to check progress.`)],
      });
    });
  },
};

// export

// Base mod/admin commands
const baseCmds = [playerinfo, balance, addcurrency, grantitem, setstats, ban, unban, wipe, jobstatus, bulkcurrency];
// Self-service player commands (link, unlink, daily, profile, stats, leaderboard)

// SECTION 2 - player self-service commands (from linking.js)


// embed colours
const C = {
  OK:        0x10b981, // green
  ERR:       0xef4444, // red
  INFO:      0x3b82f6, // blue
  WARN:      0xf59e0b, // amber  <- warning / neutral
  COMMON:    0x95a5a6, // silver
  UNCOMMON:  0x2ecc71, // green
  RARE:      0x3498db, // blue
  EPIC:      0x9b59b6, // purple
  LEGENDARY: 0xf39c12, // gold   <- NOT the same as WARN
};

/** Tier label -> embed colour */
function tierColour(label = '') {
  if (label.includes('Legendary')) return C.LEGENDARY;
  if (label.includes('Epic'))      return C.EPIC;
  if (label.includes('Rare'))      return C.RARE;
  if (label.includes('Uncommon'))  return C.UNCOMMON;
  return C.COMMON;
}

// helpers

/** Build an EmbedBuilder quickly */
function E(color, title, desc = '', fields = []) {
  const e = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setTimestamp();
  if (desc) e.setDescription(desc);
  if (fields.length) e.addFields(fields);
  return e;
}

/** Format a number with commas */
const fmt = (n) => (n ?? 0).toLocaleString();

/** Format a date to locale string safely */
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-GB') : '-';

/** Sanitise error message before showing in Discord (trim internal paths/stack) */
function safeErr(err) {
  const msg = typeof err === 'string' ? err : (err?.message || 'Unknown error');
  // Trim anything after a newline (stack traces, file paths)
  return msg.split('\n')[0].slice(0, 300);
}

/**
 * Defer + run fn with a 12-second timeout guard.
 * Discord's interaction token expires at 15 s - this fires an error embed
 * instead of silently hanging.
 */
async function wrap(i, fn) {
  await i.deferReply({ ephemeral: true });
  const timeout = setTimeout(async () => {
    try {
      await i.editReply({ embeds: [E(C.ERR, 'Timeout', 'The server took too long to respond. Try again in a moment.')] });
    } catch {}
  }, 12_000);

  try {
    await fn();
  } catch (err) {
    try {
      await i.editReply({ embeds: [E(C.ERR, 'Error', safeErr(err))] });
    } catch {}
  } finally {
    clearTimeout(timeout);
  }
}

/** Check if a guild member has mod/admin permissions */
function isModerator(member) {
  if (!member) return false;
  if (member.permissions.has('Administrator')) return true;
  if (process.env.DISCORD_MOD_ROLE   && member.roles.cache.has(process.env.DISCORD_MOD_ROLE))   return true;
  if (process.env.DISCORD_ADMIN_ROLE && member.roles.cache.has(process.env.DISCORD_ADMIN_ROLE)) return true;
  return false;
}

// /link

const link = {
  data: new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link or check your Discord-to-game account connection')
    .addSubcommand(s => s
      .setName('start')
      .setDescription('Generate a one-time code to enter in-game'))
    .addSubcommand(s => s
      .setName('status')
      .setDescription('Check whether your Discord is currently linked')),

  async execute(i) {
    const sub = i.options.getSubcommand();

    // /link status
    if (sub === 'status') {
      await wrap(i, async () => {
        const d = await apiCall('GET', `/discord/link/status/${i.user.id}`);
        if (!d.linked) {
          return i.editReply({ embeds: [E(C.WARN, 'Not Linked',
            'Your Discord is not linked to a game account.\nRun `/link start` to get a code.'
          )] });
        }
        return i.editReply({ embeds: [E(C.OK, 'Linked',
          `Your Discord is linked to **${d.player.display_name}**.`,
          [
            { name: 'PlayFab ID',   value: `\`${d.player.playfab_id}\``, inline: true },
            { name: 'Linked since', value: fmtDate(d.player.discord_linked_at), inline: true },
          ]
        )] });
      });
      return;
    }

    // /link start
    // FIX: check status first - give a friendly message if already linked.
    await wrap(i, async () => {
      const status = await apiCall('GET', `/discord/link/status/${i.user.id}`);
      if (status.linked) {
        return i.editReply({ embeds: [E(C.WARN, 'Already Linked',
          `Your Discord is already linked to **${status.player.display_name}**.\n\n` +
          `To switch accounts, run \`/unlink request\` first.`
        )] });
      }

      const d = await apiCall('POST', '/discord/link/generate', {
        discordId:  i.user.id,
        discordTag: i.user.tag,
      });

      return i.editReply({ embeds: [
        E(C.INFO, 'Link Your Account',
          [
            '**Your one-time code:**',
            `\`\`\`\n${d.code}\n\`\`\``,
            '**Steps:**',
            '1. Open **the game**',
            '2. Go to **Settings -> Account -> Link Discord**',
            '3. Enter the code above',
            '',
            ` Expires in **${d.expiresMinutes} minutes** - don't share it.`,
            'Run `/link status` after to confirm.',
          ].join('\n')
        ).setFooter({ text: 'Code is case-insensitive' })
      ] });
    });
  },
};

// /unlink

const unlink = {
  data: new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Unlink your Discord from your game account')
    .addSubcommand(s => s
      .setName('request')
      .setDescription('Start the unlink process - a confirmation code will be sent to your DMs'))
    .addSubcommand(s => s
      .setName('confirm')
      .setDescription('Confirm the unlink with your confirmation code')
      .addStringOption(o => o
        .setName('code')
        .setDescription('The 6-digit code from your DMs')
        .setMinLength(6)
        .setMaxLength(6)
        .setRequired(true))),

  async execute(i) {
    const sub = i.options.getSubcommand();

    // /unlink request
    if (sub === 'request') {
      await wrap(i, async () => {
        const d = await apiCall('POST', '/discord/unlink/request', { discordId: i.user.id });
        const accountName = d.player?.display_name ?? 'your account';

        const dmText =
          ` **Game Account - Unlink Confirmation**\n\n` +
          `Code: \`${d.code}\`\n\n` +
          `This will unlink **${accountName}** from your Discord.\n` +
          `Run \`/unlink confirm ${d.code}\` within **${d.expiresMinutes} minutes**.\n\n` +
          `If you didn't request this, ignore this message - the code expires automatically.`;

        let sentToDM = false;
        try {
          const dm = await i.user.createDM();
          await dm.send(dmText);
          sentToDM = true;
        } catch {
          // DMs closed - fall through to show code in ephemeral
        }

        if (sentToDM) {
          await i.editReply({ embeds: [E(C.WARN, 'Confirmation Required',
            ` Confirmation code sent to your **DMs**.\n\n` +
            `Run \`/unlink confirm <code>\` within **${d.expiresMinutes} minutes**.\n` +
            `This will unlink **${accountName}** from your Discord.`
          )] });
        } else {
          // Safe to show code in ephemeral - only the user sees this
          await i.editReply({ embeds: [E(C.WARN, 'Confirmation Required',
            `Your DMs are closed, so your code is shown here (only you can see this):\n` +
            `\`\`\`\n${d.code}\n\`\`\`\n` +
            `Run \`/unlink confirm ${d.code}\` within **${d.expiresMinutes} minutes**.\n` +
            `This will unlink **${accountName}**.`
          )] });
        }
      });
      return;
    }

    // /unlink confirm
    await wrap(i, async () => {
      const code = i.options.getString('code').trim().replace(/\D/g, ''); // digits only
      if (code.length !== 6) {
        return i.editReply({ embeds: [E(C.ERR, 'Invalid Code', 'The confirmation code must be exactly 6 digits.')] });
      }

      const d = await apiCall('POST', '/discord/unlink/confirm', {
        discordId: i.user.id,
        code,
      });

      await i.editReply({ embeds: [E(C.OK, 'Unlinked',
        `**${d.displayName}** has been unlinked from your Discord.\n\n` +
        `You can link a different account with \`/link start\`.`
      )] });
    });
  },
};

// /daily

const TIER_ODDS = { Common: '50%', Uncommon: '30%', Rare: '15%', Epic: '4%', Legendary: '1%' };

const daily = {
  data: new SlashCommandBuilder()
    .setName('daily')
    .setDescription('Claim your daily Discord reward (resets at midnight UTC)'),

  async execute(i) {
    await wrap(i, async () => {
      const d = await apiCall('POST', '/discord/daily', { discordId: i.user.id });
      const { tier, player, rewards, newBalances } = d;

      // Colour based on rarity
      const colour = tierColour(tier);

      // Reward lines - use > 0 not truthy (avoids hiding legitimate 0 values)
      const rewardLines = [];
      if (rewards.ge > 0) rewardLines.push(` **${fmt(rewards.ge)} GE**`);
      if (rewards.bb > 0) rewardLines.push(` **${rewards.bb} BB**`);
      if (rewards.dt > 0) rewardLines.push(` **${rewards.dt} DT**`);
      if (rewards.bp > 0) rewardLines.push(` **${fmt(rewards.bp)} BP**`);
      const rewardDesc = rewardLines.length ? rewardLines.join('  -  ') : '*(nothing this time)*';

      // Extract tier name without the emoji prefix for odds lookup
      const tierName = tier.replace(/^[\p{Emoji}\s]+/u, '').trim(); // e.g. "Legendary"
      const odds     = TIER_ODDS[tierName] ?? '?';

      await i.editReply({ embeds: [
        E(colour, `${tier} Daily Reward`,
          `${player.displayName} rolled **${tier}** *(${odds} chance)*\n\n${rewardDesc}`,
          [
            { name: 'GE',  value: fmt(newBalances.ge), inline: true },
            { name: 'BB',  value: String(newBalances.bb ?? 0), inline: true },
            { name: 'DT',  value: String(newBalances.dt ?? 0), inline: true },
            { name: 'BP',  value: fmt(newBalances.bp), inline: true },
          ]
        ).setFooter({ text: 'Resets at midnight UTC - /leaderboard to see top players' })
      ] });
    });
  },
};

// /profile

const profile = {
  data: new SlashCommandBuilder()
    .setName('profile')
    .setDescription('View your linked the game profile')
    .addUserOption(o => o
      .setName('user')
      .setDescription('Discord user to look up - Mod/Admin only')
      .setRequired(false)),

  async execute(i) {
    await wrap(i, async () => {
      let targetId   = i.user.id;
      const targetUser = i.options.getUser('user');

      if (targetUser && targetUser.id !== i.user.id) {
        // FIX: use i.member directly - already available, no extra HTTP fetch
        if (!isModerator(i.member)) {
          return i.editReply({ embeds: [E(C.ERR, 'Access Denied',
            'You need the **Moderator** or **Admin** role to look up other players.'
          )] });
        }
        targetId = targetUser.id;
      }

      const p = await apiCall('GET', `/discord/profile/${targetId}`);

      // Derived stats
      const wins    = p.stats?.Wins    ?? 0;
      const kills   = p.stats?.Kills   ?? 0;
      const matches = p.stats?.Matches ?? 0;
      const winRate = matches > 0 ? ((wins / matches) * 100).toFixed(1) + '%' : '-';
      const kd      = matches > 0 ? (kills / Math.max(matches, 1)).toFixed(2) : '-';

      // FIX: use last_seen (updated on every API call) not last_login
      const lastSeen  = fmtDate(p.last_seen);
      const linkedAt  = fmtDate(p.discord_linked_at);
      const lastDaily = p.lastDailyClaim ?? 'Never';
      const isBanned  = p.banned;

      // FIX: null-safe on all vc_* fields
      const ge = p.vc_ge ?? 0;
      const bb = p.vc_bb ?? 0;
      const dt = p.vc_dt ?? 0;
      const bp = p.vc_bp ?? 0;

      const embed = E(
        isBanned ? C.ERR : C.INFO,
        ` ${p.display_name}`,
        isBanned
          ? ` **This account is banned.**`
          : `Linked as **${p.discord_tag ?? '-'}** since ${linkedAt}`,
        [
          { name: 'PlayFab ID',  value: `\`${p.playfab_id}\``,  inline: true },
          { name: 'Last seen',   value: lastSeen,                inline: true },
          { name: '\u200b',      value: '\u200b',               inline: true }, // spacer
          { name: 'GE',       value: fmt(ge),                 inline: true },
          { name: 'BB',       value: String(bb),              inline: true },
          { name: 'DT',       value: String(dt),              inline: true },
          { name: 'BP',       value: fmt(bp),                 inline: true },
          { name: '\u200b',      value: '\u200b',               inline: true },
          { name: '\u200b',      value: '\u200b',               inline: true }, // spacer
          { name: 'Wins',     value: fmt(wins),               inline: true },
          { name: 'Kills',    value: fmt(kills),              inline: true },
          { name: 'Matches',  value: fmt(matches),            inline: true },
          { name: 'XP',       value: fmt(p.stats?.XP ?? 0),  inline: true },
          { name: 'Win Rate', value: winRate,                 inline: true },
          { name: 'K/Match',  value: kd,                     inline: true },
          { name: 'Last Daily', value: lastDaily,             inline: true },
        ]
      );

      await i.editReply({ embeds: [embed] });
    });
  },
};

// /stats  (NEW - lightweight personal stats, no mod lookup)

const stats = {
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Quick view of your the game game stats'),

  async execute(i) {
    await wrap(i, async () => {
      const d = await apiCall('GET', `/discord/profile/${i.user.id}`);

      const wins    = d.stats?.Wins    ?? 0;
      const kills   = d.stats?.Kills   ?? 0;
      const matches = d.stats?.Matches ?? 0;
      const xp      = d.stats?.XP      ?? 0;
      const winRate = matches > 0 ? ((wins / matches) * 100).toFixed(1) + '%' : '-';
      const kd      = matches > 0 ? (kills / Math.max(matches, 1)).toFixed(2) : '-';

      await i.editReply({ embeds: [
        E(C.INFO, ` ${d.display_name}'s Stats`, null, [
          { name: 'Wins',     value: fmt(wins),    inline: true },
          { name: 'Kills',    value: fmt(kills),   inline: true },
          { name: 'Matches',  value: fmt(matches), inline: true },
          { name: 'XP',       value: fmt(xp),      inline: true },
          { name: 'Win Rate', value: winRate,      inline: true },
          { name: 'K/Match',  value: kd,           inline: true },
        ]).setFooter({ text: 'Run /profile for full currency & account details' })
      ] });
    });
  },
};

// Leaderboard

const LB_STATS = ['Kills', 'Wins', 'XP', 'Matches'];
const LB_RANK_PREFIXES = ['1.', '2.', '3.'];

const leaderboard = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Top 10 players by the selected statistic')
    .addStringOption(o => o
      .setName('stat')
      .setDescription('Stat to rank by (default: Wins)')
      .setRequired(false)
      .addChoices(
        { name: 'Wins',    value: 'Wins'    },
        { name: 'Kills',   value: 'Kills'   },
        { name: 'XP',      value: 'XP'      },
        { name: 'Matches', value: 'Matches' },
      )),

  async execute(i) {
    await wrap(i, async () => {
      const stat = i.options.getString('stat') ?? 'Wins';
      const d    = await apiCall('GET', `/discord/leaderboard/${stat}`);

      if (!d.entries?.length) {
        return i.editReply({ embeds: [E(C.WARN, `${stat} Leaderboard`, 'No entries yet.')] });
      }

      const lines = d.entries.map((e, idx) => {
        const medal = LB_RANK_PREFIXES[idx] ?? `**#${idx + 1}**`;
        return `${medal} **${e.display_name}** - ${fmt(e.stat_value)}`;
      });

      await i.editReply({ embeds: [
        E(C.INFO,
          `${stat} Leaderboard - Top ${d.entries.length}`,
          lines.join('\n')
        ).setFooter({ text: `Updated live - /leaderboard stat:Kills to switch` })
      ] });
    });
  },
};



// EXPORT ALL COMMANDS

module.exports = [
  // Admin / Mod
  playerinfo, balance, addcurrency, grantitem, setstats,
  ban, unban, wipe, jobstatus, bulkcurrency,
  // Player self-service
  link, unlink, daily, profile, stats, leaderboard,
];
