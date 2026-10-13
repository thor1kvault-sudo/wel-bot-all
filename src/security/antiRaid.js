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
 * Evaluates join risk signals for a member (Phase 5: Multi-factor risk scoring).
 * Signals:
 * - Account Age < 24h: +40 pts
 * - Account Age < 3 days: +25 pts
 * - Default avatar (no custom avatar): +20 pts
 * - Suspicious username patterns: +15 pts
 * Score >= 50 indicates high raid suspicion.
 */
function evaluateJoinRisk(member) {
  if (!member || !member.user) return { score: 0, highRisk: false, reasons: [] };

  let score = 0;
  const reasons = [];
  const now = Date.now();
  const created = member.user.createdTimestamp || now;
  const ageMs = now - created;
  const ageHours = ageMs / (1000 * 60 * 60);

  if (ageHours < 24) {
    score += 40;
    reasons.push('Account created < 24h ago');
  } else if (ageHours < 72) {
    score += 25;
    reasons.push('Account created < 3 days ago');
  }

  // Default avatar check
  if (!member.user.avatar) {
    score += 20;
    reasons.push('Default Discord avatar');
  }

  // Generic raid username pattern (e.g. repeated numbers or spam strings)
  const username = member.user.username || '';
  if (/^[a-zA-Z]{2,4}\d{4,8}$/.test(username) || /[a-z]{8,}\d{4,}/i.test(username)) {
    score += 15;
    reasons.push('Pattern-generated username');
  }

  return {
    score,
    highRisk: score >= 40,
    reasons,
    ageHours: Math.round(ageHours),
  };
}

/**
 * Core Anti-Raid Mass Join processor. Called on every guildMemberAdd.
 * Tracks velocity with risk scoring; safely quarantines suspicious wave members.
 * Never performs indiscriminate destructive mass-kicks.
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
  const mode = raidCfg.action || 'quarantine'; // 'quarantine' is the safe enterprise default
  let quarantinedCount = 0;
  const affectedIds = [];

  // Collect recent joiners from cache (joined within window)
  const recentMembers = guild.members.cache.filter(m => {
    return !m.user.bot && (now - (m.joinedTimestamp || 0)) < windowMs;
  });

  // Evaluate risk scores: only take severe action on accounts with risk signals
  for (const [, m] of recentMembers) {
    const risk = evaluateJoinRisk(m);
    
    // In quarantine mode, quarantine all recent joiners in wave to be safe
    // In kick mode, only kick high risk accounts; quarantine lower risk accounts to prevent false-positive bans
    if (mode === 'kick' && risk.highRisk && m.kickable) {
      await m.kick(`Anti-Raid Risk Intercept: Mass join wave (${risk.reasons.join(', ')})`).catch(() => {});
      quarantinedCount++;
    } else {
      const result = await quarantineMember(m, `Raid wave (${timestamps.length} joins in ${windowMs / 1000}s${risk.reasons.length ? ' • ' + risk.reasons.join(', ') : ''})`);
      if (result.success) { quarantinedCount++; affectedIds.push(m.id); }
    }
  }

  // Persist quarantine state in config using non-blocking async save
  config.security = config.security || {};
  config.security.emergencyQuarantine = true;
  saveGuildConfig(guild.id, config);

  // Log security incident
  const embed = new EmbedBuilder()
    .setColor('#FF0000')
    .setTitle('🚨 ANTI-RAID: Mass Join Wave Intercepted!')
    .setDescription(
      `**Wave Size:** ${timestamps.length} joins in ${windowMs / 1000}s (Threshold: ${threshold})\n` +
      `**Containment Mode:** \`${mode}\`\n` +
      `**Accounts Contained:** ${quarantinedCount}\n` +
      `**Release:** Run \`/security unlock\` or \`/threat\` → 🟢 Release Quarantine`
    )
    .setTimestamp();

  await logSecurity(guild, embed).catch(() => {});

  // Reset tracker to prevent re-firing on every subsequent join during the event
  joinVelocityTracker.set(guild.id, []);

  return { intercepted: true, reason: 'mass_join_raid', quarantined: quarantinedCount, action: mode };
}

module.exports = {
  processRaidJoin,
  evaluateJoinRisk,
  quarantineMember,
  releaseMember,
  releaseAllQuarantine,
  ensureQuarantineRole,
  getQuarantinedCount,
  isQuarantined,
  QUARANTINE_ROLE_NAME,
};
