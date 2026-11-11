'use strict';

const MOD_ROLE_ID   = process.env.DISCORD_MOD_ROLE   || '';
const ADMIN_ROLE_ID = process.env.DISCORD_ADMIN_ROLE  || '';

/**
 * Check if a GuildMember has the moderator role (or admin role, which
 * implies moderator). If no role IDs are configured, only server admins
 * (manageGuild permission) are allowed.
 */
function hasMod(member) {
  if (!member) return false;
  if (member.permissions.has('Administrator')) return true;
  if (MOD_ROLE_ID && member.roles.cache.has(MOD_ROLE_ID)) return true;
  if (ADMIN_ROLE_ID && member.roles.cache.has(ADMIN_ROLE_ID)) return true;
  return false;
}

function hasAdmin(member) {
  if (!member) return false;
  if (member.permissions.has('Administrator')) return true;
  if (ADMIN_ROLE_ID && member.roles.cache.has(ADMIN_ROLE_ID)) return true;
  return false;
}

module.exports = { hasMod, hasAdmin };
