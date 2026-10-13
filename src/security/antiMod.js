const { PermissionsBitField, AuditLogEvent, EmbedBuilder } = require('discord.js');
const { getGuildConfig } = require('../config/guildConfig');
const { checkThreshold, isImmuneUser, executeContainment } = require('./securityEngine');
const { redactSecrets } = require('../utils/helpers');

/**
 * THOR APEX Anti-Moderation Abuse Engine (Phase 4)
 * 
 * Protects servers against rogue or compromised staff members performing:
 * - Mass timeouts
 * - Unauthorized mass kicks/bans
 * - Unauthorized unbans (e.g. unbanning blacklisted raiders)
 * - Rapid channel permission overrides (locking out admins)
 * - Dangerous role grants below Administrator
 * - Mass message deletions / purges
 */

const MOD_ACTION_KEYS = {
  TIMEOUT: 'modTimeout',
  KICK: 'modKick',
  BAN: 'modBan',
  UNBAN: 'modUnban',
  ROLE_GRANT: 'modRoleGrant',
  PERM_OVERRIDE: 'modPermOverride',
  PURGE: 'modPurge',
};

// Default conservative thresholds for moderators (can be customized per guild in config.security.modThresholds)
const DEFAULT_MOD_THRESHOLDS = {
  [MOD_ACTION_KEYS.TIMEOUT]: { limit: 5, windowMs: 30000 },       // max 5 timeouts per 30s
  [MOD_ACTION_KEYS.KICK]: { limit: 3, windowMs: 30000 },          // max 3 kicks per 30s
  [MOD_ACTION_KEYS.BAN]: { limit: 3, windowMs: 30000 },           // max 3 bans per 30s
  [MOD_ACTION_KEYS.UNBAN]: { limit: 3, windowMs: 30000 },         // max 3 unbans per 30s
  [MOD_ACTION_KEYS.ROLE_GRANT]: { limit: 4, windowMs: 20000 },    // max 4 high role grants per 20s
  [MOD_ACTION_KEYS.PERM_OVERRIDE]: { limit: 3, windowMs: 20000 }, // max 3 channel overrides per 20s
  [MOD_ACTION_KEYS.PURGE]: { limit: 4, windowMs: 20000 },         // max 4 bulk purges per 20s
};

/**
 * Evaluates whether a moderation action performed by an actor violates rate limits.
 */
function checkModeratorVelocity(guildId, actorId, actionKey) {
  const config = getGuildConfig(guildId);
  const customThresholds = config.security?.modThresholds || {};
  const targetConfig = customThresholds[actionKey] || DEFAULT_MOD_THRESHOLDS[actionKey] || { limit: 4, windowMs: 25000 };

  return checkThreshold(guildId, actorId, `antimod:${actionKey}`, targetConfig.limit, targetConfig.windowMs);
}

/**
 * Handles suspected moderator abuse event.
 */
async function handleModerationAction(guild, actor, actionKey, actionLabel, targetDescription = '') {
  if (!guild || !actor) return { intercepted: false };

  // Owner and security-immune users are exempted from anti-mod rate-limiting
  if (isImmuneUser(guild, actor.id)) {
    return { intercepted: false, reason: 'immune' };
  }

  const velocity = checkModeratorVelocity(guild.id, actor.id, actionKey);
  if (!velocity.triggered) {
    return { intercepted: false, velocity };
  }

  console.warn(redactSecrets(`[Anti-Mod Abuse Intercept] ${actor.tag || actor.id} exceeded velocity for ${actionLabel} in ${guild.name} (${velocity.count}/${velocity.limit})`));

  // Execute containment (strip roles and restrict/quarantine rogue mod)
  const fullLabel = `Anti-Mod Abuse: Rogue ${actionLabel}${targetDescription ? ` on ${targetDescription}` : ''}`;
  const enforcement = await executeContainment(guild, actor, fullLabel, velocity);

  return {
    intercepted: true,
    velocity,
    enforcement,
  };
}

module.exports = {
  MOD_ACTION_KEYS,
  DEFAULT_MOD_THRESHOLDS,
  checkModeratorVelocity,
  handleModerationAction,
};
