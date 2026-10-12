const { EmbedBuilder, PermissionsBitField } = require('discord.js');
const { getGuildConfig, saveGuildConfig } = require('../config/guildConfig');
const { logSecurity } = require('../logging/loggerService');

// Join velocity tracker: Map<guildId, number[]>  (timestamps of recent joins)
const joinVelocityTracker = new Map();

// Active quarantine sets: Map<guildId, Set<memberId>>
const quarantineRegistry = new Map();

// Quarantine role name used across the system
const QUARANTINE_ROLE_NAME = '⚠️ Quarantined';

/**
 * Returns or creates the Quarantine role for a guild.
 * The quarantine role: no colour, no perms. All other channels deny it SEND_MESSAGES.
 */
async function ensureQuarantineRole(guild) {
  let qRole = guild.roles.cache.find(r => r.name === QUARANTINE_ROLE_NAME);
  if (qRole) return qRole;

  try {
    qRole = await guild.roles.create({
      name: QUARANTINE_ROLE_NAME,
      color: 0x2b2d31,
      hoist: false,
      mentionable: false,
      reason: 'Anti-Raid Quarantine System — auto created',
    });
    return qRole;
  } catch (_) {
    return null;
  }
}

/**
 * Quarantines a member: strips all roles, assigns the quarantine role.
 * Returns { success, stripped, reason }
 */
async function quarantineMember(member, reason = 'Mass Join Raid') {
  const guild = member.guild;
  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);

  if (!me?.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    return { success: false, stripped: [], reason: 'Bot lacks Manage Roles permission' };
  }
  if (!member.manageable) {
    return { success: false, stripped: [], reason: 'Cannot manage this member (higher role)' };
  }

  // Collect roles to strip (not @everyone)
  const strippedRoleIds = typeof member.roles.cache.filter === 'function'
    ? member.roles.cache.filter(r => r.id !== guild.roles.everyone?.id).map(r => r.id)
    : [...(member.roles.cache.values ? member.roles.cache.values() : member.roles.cache)]
        .filter(r => r.id !== guild.roles.everyone?.id)
        .map(r => r.id);

  // Ensure quarantine role exists
  const qRole = await ensureQuarantineRole(guild);
  if (!qRole) {
    return { success: false, stripped: [], reason: 'Failed to create/find Quarantine role' };
  }

  try {
    // Strip all roles and assign quarantine role atomically
    await member.roles.set([qRole.id], `Anti-Raid Quarantine: ${reason}`);

    // Track in registry
    if (!quarantineRegistry.has(guild.id)) quarantineRegistry.set(guild.id, new Set());
    quarantineRegistry.get(guild.id).add(member.id);

    return { success: true, stripped: strippedRoleIds, roleId: qRole.id, reason };
  } catch (err) {
    return { success: false, stripped: [], reason: `Role assignment failed: ${err.message}` };
  }
}

/**
 * Releases a single member from quarantine. Restores @everyone effective access.
 * (We don't restore stripped roles since we don't store them per-user here; auto-role will fire on next join)
 */
async function releaseMember(member, reason = 'Admin released') {
  const guild = member.guild;
  if (!quarantineRegistry.get(guild.id)?.has(member.id)) {
    return { success: false, reason: 'Member not in quarantine registry' };
  }

  const qRole = guild.roles.cache.find(r => r.name === QUARANTINE_ROLE_NAME);
  try {
    if (qRole && member.roles.cache.has(qRole.id)) {
      await member.roles.remove(qRole.id, `Quarantine lifted: ${reason}`);
    }
    quarantineRegistry.get(guild.id)?.delete(member.id);
    return { success: true };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

/**
 * Releases ALL quarantined members in a guild.
 */
async function releaseAllQuarantine(guild, reason = 'Admin mass release') {
  const registry = quarantineRegistry.get(guild.id);
  if (!registry || registry.size === 0) return { released: 0, failed: 0 };

  const qRole = guild.roles.cache.find(r => r.name === QUARANTINE_ROLE_NAME);
  let released = 0;
  let failed = 0;

  for (const memberId of [...registry]) {
    try {
      const member = guild.members.cache.get(memberId) || await guild.members.fetch(memberId).catch(() => null);
      if (!member) { registry.delete(memberId); continue; }
      if (qRole && member.roles.cache.has(qRole.id)) {
        await member.roles.remove(qRole.id, `Mass quarantine lift: ${reason}`);
      }
      registry.delete(memberId);
      released++;
    } catch (_) {
      failed++;
    }
  }
  return { released, failed };
}

/**
 * Gets the count of currently quarantined members.
 */
function getQuarantinedCount(guildId) {
  return quarantineRegistry.get(guildId)?.size || 0;
}

/**
 * Checks if a member is in quarantine.
 */
function isQuarantined(guildId, memberId) {
  return quarantineRegistry.get(guildId)?.has(memberId) ?? false;
}

/**
 * Core Anti-Raid Mass Join processor. Called on every guildMemberAdd.
 * Tracks velocity; if threshold exceeded, quarantines the joining wave.
 * @param {GuildMember} member - newly joined member
 * @returns {{ intercepted: boolean, reason?: string, quarantined?: number }}
 */
async function processRaidJoin(member) {
  if (!member || !member.guild) return { intercepted: false };
  const guild = member.guild;
  const config = getGuildConfig(guild.id, guild.name);
  const raidCfg = config.antiRaid || {};

  if (!raidCfg.enabled) return { intercepted: false };

  const windowMs = raidCfg.joinWindowMs || 10000;   // default 10 seconds
  const threshold = raidCfg.joinThreshold || 5;      // default 5 joins triggers
  const now = Date.now();

  // Maintain sliding window
  let timestamps = joinVelocityTracker.get(guild.id) || [];
  timestamps = timestamps.filter(t => now - t < windowMs);
  timestamps.push(now);
  joinVelocityTracker.set(guild.id, timestamps);

  if (timestamps.length < threshold) return { intercepted: false };

  // RAID DETECTED — quarantine the wave
  const mode = raidCfg.action || 'quarantine'; // 'quarantine' | 'kick' | 'lockdown'
  let quarantinedCount = 0;
  const affectedIds = [];

  // Collect recent joiners from cache (joined within window)
  const recentMembers = guild.members.cache.filter(m => {
    return !m.user.bot && (now - (m.joinedTimestamp || 0)) < windowMs;
  });

  if (mode === 'quarantine') {
    for (const [, m] of recentMembers) {
      const result = await quarantineMember(m, `Raid wave (${timestamps.length} joins in ${windowMs / 1000}s)`);
      if (result.success) { quarantinedCount++; affectedIds.push(m.id); }
    }

    // Persist quarantine state in config
    config.security = config.security || {};
    config.security.emergencyQuarantine = true;
    saveGuildConfig(guild.id, config);
  } else if (mode === 'lockdown') {
    config.security = config.security || {};
    config.security.lockdown = true;
    saveGuildConfig(guild.id, config);
  } else if (mode === 'kick') {
    for (const [, m] of recentMembers) {
      if (m.kickable) {
        await m.kick(`Anti-Raid: Mass join wave detected (${timestamps.length} joins in ${windowMs / 1000}s)`).catch(() => {});
        quarantinedCount++;
      }
    }
  }

  // Log security incident
  const embed = new EmbedBuilder()
    .setColor('#FF0000')
    .setTitle('🚨 ANTI-RAID: Mass Join Wave Detected & Neutralized!')
    .setDescription(
      `**Wave Size:** ${timestamps.length} joins in ${windowMs / 1000}s (Threshold: ${threshold})\n` +
      `**Action Taken:** \`${mode}\`\n` +
      `**Members Affected:** ${quarantinedCount}\n` +
      (mode === 'quarantine' ? `**Release:** Use \`/threat\` → 🟢 Release Quarantine` : '')
    )
    .setTimestamp();

  await logSecurity(guild, embed).catch(() => {});

  // Reset tracker to prevent re-firing on every subsequent join during the event
  joinVelocityTracker.set(guild.id, []);

  return { intercepted: true, reason: 'mass_join_raid', quarantined: quarantinedCount, action: mode };
}

module.exports = {
  processRaidJoin,
  quarantineMember,
  releaseMember,
  releaseAllQuarantine,
  ensureQuarantineRole,
  getQuarantinedCount,
  isQuarantined,
  QUARANTINE_ROLE_NAME,
};
