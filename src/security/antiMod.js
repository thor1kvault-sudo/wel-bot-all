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
 * - Rapid channel permission overrides (locking out staff/members)
 * - Dangerous role grants (assigning admin/mod perms to alts)
 * - Mass message deletions / purges
 * - Configuration tampering
 * 
 * Evaluation Policy:
 * - Multi-window rate limiting: short burst window (15–30s) + longer rolling window (60–120s)
 * - Stricter controls: Administrator permission is NOT automatically exempt.
 *   Only the Server Owner, Bot Owner, and explicitly configured `trustedUsers` / `trustedRoles` are immune.
 */

const MOD_ACTION_KEYS = {
  TIMEOUT: 'modTimeout',
  KICK: 'modKick',
  BAN: 'modBan',
  UNBAN: 'modUnban',
  ROLE_GRANT: 'modRoleGrant',
  PERM_OVERRIDE: 'modPermOverride',
  PURGE: 'modPurge',
  CONFIG_TAMPER: 'modConfigTamper',
};

// Default conservative thresholds for staff members
const DEFAULT_MOD_THRESHOLDS = {
  [MOD_ACTION_KEYS.TIMEOUT]: { limit: 5, windowMs: 30000, longLimit: 12, longWindowMs: 120000 },
  [MOD_ACTION_KEYS.KICK]: { limit: 3, windowMs: 30000, longLimit: 8, longWindowMs: 120000 },
  [MOD_ACTION_KEYS.BAN]: { limit: 3, windowMs: 30000, longLimit: 8, longWindowMs: 120000 },
  [MOD_ACTION_KEYS.UNBAN]: { limit: 3, windowMs: 30000, longLimit: 8, longWindowMs: 120000 },
  [MOD_ACTION_KEYS.ROLE_GRANT]: { limit: 3, windowMs: 20000, longLimit: 6, longWindowMs: 90000 },
  [MOD_ACTION_KEYS.PERM_OVERRIDE]: { limit: 3, windowMs: 20000, longLimit: 6, longWindowMs: 90000 },
  [MOD_ACTION_KEYS.PURGE]: { limit: 4, windowMs: 20000, longLimit: 10, longWindowMs: 90000 },
  [MOD_ACTION_KEYS.CONFIG_TAMPER]: { limit: 2, windowMs: 30000, longLimit: 4, longWindowMs: 120000 },
};

/**
 * Evaluates whether a moderation action performed by an actor violates rate limits.
 * Checks both short burst window and extended rolling window.
 */
function checkModeratorVelocity(guildId, actorId, actionKey) {
  const config = getGuildConfig(guildId);
  const customThresholds = config.security?.modThresholds || {};
  const targetConfig = customThresholds[actionKey] || DEFAULT_MOD_THRESHOLDS[actionKey] || { limit: 4, windowMs: 25000 };

  // 1. Short burst check
  const shortCheck = checkThreshold(
    guildId,
    actorId,
    `antimod:short:${actionKey}`,
    targetConfig.limit,
    targetConfig.windowMs
  );
  if (shortCheck.triggered) {
    return { ...shortCheck, windowType: 'short' };
  }

  // 2. Long window check (if configured)
  if (targetConfig.longLimit && targetConfig.longWindowMs) {
    const longCheck = checkThreshold(
      guildId,
      actorId,
      `antimod:long:${actionKey}`,
      targetConfig.longLimit,
      targetConfig.longWindowMs
    );
    if (longCheck.triggered) {
      return { ...longCheck, windowType: 'long' };
    }
  }

  return { ...shortCheck, triggered: false };
}

/**
 * Handles suspected moderator abuse event.
 */
async function handleModerationAction(guild, actor, actionKey, actionLabel, targetDescription = '') {
  if (!guild || !actor) return { intercepted: false };

  // Owner and explicitly configured trusted users/roles are immune
  if (isImmuneUser(guild, actor.id)) {
    return { intercepted: false, reason: 'immune' };
  }

  const velocity = checkModeratorVelocity(guild.id, actor.id, actionKey);
  if (!velocity.triggered) {
    return { intercepted: false, velocity };
  }

  console.warn(redactSecrets(`[Anti-Mod Abuse Intercept] ${actor.tag || actor.id} exceeded velocity for ${actionLabel} in ${guild.name} (${velocity.count}/${velocity.limit} [${velocity.windowType || 'short'}])`));

  // Containment: strip dangerous administrative roles and quarantine/restrict rogue mod
  const fullLabel = `Anti-Mod Abuse: Rogue ${actionLabel}${targetDescription ? ` on ${targetDescription}` : ''} (${velocity.windowType || 'burst'} threshold)`;
  const enforcement = await executeContainment(guild, actor, fullLabel, velocity, {
    customAction: 'strip_roles', // Safe containment: strip dangerous roles first
  });

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
