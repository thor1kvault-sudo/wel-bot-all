const { EmbedBuilder, PermissionsBitField } = require('discord.js');
const { getGuildConfig, saveGuildConfig } = require('../config/guildConfig');
const { logSecurity } = require('../logging/loggerService');

// Join velocity tracker: Map<guildId, number[]> (timestamps of recent joins)
const joinVelocityTracker = new Map();

// Active quarantine sets: Map<guildId, Set<memberId>>
const quarantineRegistry = new Map();

// Quarantine entry timestamps for auto-expiry: Map<"guildId:memberId", number>
const quarantineTimestamps = new Map();

// Quarantine role name used across the system
const QUARANTINE_ROLE_NAME = '⚠️ Quarantined';

/**
 * Returns or creates the Quarantine role for a guild.
 * The quarantine role: no colour, no perms. Channels deny it SEND_MESSAGES.
 */
async function ensureQuarantineRole(guild) {
  if (!guild?.roles?.cache) return null;
  let qRole = typeof guild.roles.cache.find === 'function'
    ? guild.roles.cache.find(r => r.name === QUARANTINE_ROLE_NAME)
    : [...guild.roles.cache.values()].find(r => r.name === QUARANTINE_ROLE_NAME);
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
 * Quarantines a member: strips roles and assigns quarantine role safely.
 * Returns { success, stripped, reason }
 */
async function quarantineMember(member, reason = 'Mass Join Raid') {
  const guild = member.guild;
  const me = guild.members.me || (typeof guild.members.fetchMe === 'function' ? await guild.members.fetchMe().catch(() => null) : null);

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
    // Strip roles and assign quarantine role atomically
    await member.roles.set([qRole.id], `Anti-Raid Quarantine: ${reason}`);

    // Track in registry
    if (!quarantineRegistry.has(guild.id)) quarantineRegistry.set(guild.id, new Set());
    quarantineRegistry.get(guild.id).add(member.id);
    quarantineTimestamps.set(`${guild.id}:${member.id}`, Date.now());

    return { success: true, stripped: strippedRoleIds, roleId: qRole.id, reason };
  } catch (err) {
    return { success: false, stripped: [], reason: `Role assignment failed: ${err.message}` };
  }
}

/**
 * Releases a single member from quarantine.
 */
async function releaseMember(member, reason = 'Admin released') {
  const guild = member.guild;
  if (!quarantineRegistry.get(guild.id)?.has(member.id)) {
    return { success: false, reason: 'Member not in quarantine registry' };
  }

  const findQRole = () => {
    if (!guild?.roles?.cache) return null;
    return typeof guild.roles.cache.find === 'function'
      ? guild.roles.cache.find(r => r.name === QUARANTINE_ROLE_NAME)
      : [...guild.roles.cache.values()].find(r => r.name === QUARANTINE_ROLE_NAME);
  };

  const qRole = findQRole();
  try {
    if (qRole && member.roles.cache.has(qRole.id)) {
      await member.roles.remove(qRole.id, `Quarantine lifted: ${reason}`);
    }
    quarantineRegistry.get(guild.id)?.delete(member.id);
    quarantineTimestamps.delete(`${guild.id}:${member.id}`);
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

  const qRole = typeof guild.roles?.cache?.find === 'function'
    ? guild.roles.cache.find(r => r.name === QUARANTINE_ROLE_NAME)
    : [...(guild.roles?.cache?.values() || [])].find(r => r.name === QUARANTINE_ROLE_NAME);
  let released = 0;
  let failed = 0;

  for (const memberId of [...registry]) {
    try {
      const member = guild.members.cache.get(memberId) || (typeof guild.members.fetch === 'function' ? await guild.members.fetch(memberId).catch(() => null) : null);
      if (!member) {
        registry.delete(memberId);
        quarantineTimestamps.delete(`${guild.id}:${memberId}`);
        continue;
      }
      if (qRole && member.roles.cache.has(qRole.id)) {
        await member.roles.remove(qRole.id, `Mass quarantine lift: ${reason}`);
      }
      registry.delete(memberId);
      quarantineTimestamps.delete(`${guild.id}:${memberId}`);
      released++;
    } catch (_) {
      failed++;
    }
  }
  return { released, failed };
}

/**
 * Periodically expires and auto-releases members quarantined longer than expiryMs.
 */
async function autoExpireQuarantine(guild, expiryMs = 3600000) {
  const registry = quarantineRegistry.get(guild.id);
  if (!registry || registry.size === 0) return 0;

  const now = Date.now();
  let expiredCount = 0;

  for (const memberId of [...registry]) {
    const qTime = quarantineTimestamps.get(`${guild.id}:${memberId}`) || 0;
    if (now - qTime >= expiryMs) {
      const member = guild.members.cache.get(memberId) || (typeof guild.members.fetch === 'function' ? await guild.members.fetch(memberId).catch(() => null) : null);
      if (member) {
        const res = await releaseMember(member, 'Quarantine time expired');
        if (res.success) expiredCount++;
      } else {
        registry.delete(memberId);
        quarantineTimestamps.delete(`${guild.id}:${memberId}`);
      }
    }
  }

  return expiredCount;
}

/**
 * Gets count of quarantined members in a guild.
 */
function getQuarantinedCount(guildId) {
  return quarantineRegistry.get(guildId)?.size || 0;
}

/**
 * Checks if a member is currently quarantined.
 */
function isQuarantined(guildId, memberId) {
  return quarantineRegistry.get(guildId)?.has(memberId) ?? false;
}

/**
 * Evaluates join risk signals for a member (Phase 5).
 * Account age is strictly a weighted signal, NEVER sole proof of abuse.
 * Signals:
 * - Account Age < 24h: +35 pts
 * - Account Age < 3 days: +20 pts
 * - Default avatar (no custom avatar): +25 pts
 * - Pattern-generated spam username: +25 pts
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
    score += 35;
    reasons.push('Account created < 24h ago');
  } else if (ageHours < 72) {
    score += 20;
    reasons.push('Account created < 3 days ago');
  }

  // Default avatar check
  if (!member.user.avatar) {
    score += 25;
    reasons.push('Default Discord avatar');
  }

  // Pattern username check
  const username = member.user.username || '';
  if (/^[a-zA-Z]{2,4}\d{4,8}$/.test(username) || /[a-z]{8,}\d{4,}/i.test(username)) {
    score += 25;
    reasons.push('Pattern-generated username');
  }

  return {
    score,
    highRisk: score >= 50,
    reasons,
    ageHours: Math.round(ageHours),
  };
}

/**
 * Primary Anti-Raid Mass Join Processor.
 * Evaluates velocity and risk signals safely.
 */
async function processRaidJoin(member) {
  if (!member || !member.guild) return { intercepted: false };
  const guild = member.guild;
  const config = getGuildConfig(guild.id, guild.name);
  const raidCfg = config.antiRaid || {};

  if (!raidCfg.enabled) return { intercepted: false };

  const windowMs = raidCfg.joinWindowMs || 10000;
  const threshold = raidCfg.joinThreshold || 5;
  const now = Date.now();

  let timestamps = joinVelocityTracker.get(guild.id) || [];
  timestamps = timestamps.filter(t => now - t < windowMs);
  timestamps.push(now);
  joinVelocityTracker.set(guild.id, timestamps);

  if (timestamps.length < threshold) return { intercepted: false };

  // RAID DETECTED
  const mode = raidCfg.action || 'quarantine';
  let quarantinedCount = 0;
  const affectedIds = [];

  const recentMembers = guild.members.cache.filter(m => {
    return !m.user.bot && (now - (m.joinedTimestamp || 0)) < windowMs;
  });

  for (const [, m] of recentMembers) {
    const risk = evaluateJoinRisk(m);

    if (mode === 'kick' && risk.highRisk && m.kickable) {
      await m.kick(`Anti-Raid Risk Intercept: Mass join wave (${risk.reasons.join(', ')})`).catch(() => {});
      quarantinedCount++;
    } else {
      const result = await quarantineMember(m, `Raid wave (${timestamps.length} joins in ${windowMs / 1000}s${risk.reasons.length ? ' • ' + risk.reasons.join(', ') : ''})`);
      if (result.success) {
        quarantinedCount++;
        affectedIds.push(m.id);
      }
    }
  }

  config.security = config.security || {};
  config.security.emergencyQuarantine = true;
  saveGuildConfig(guild.id, config);

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

  joinVelocityTracker.set(guild.id, []);

  return { intercepted: true, reason: 'mass_join_raid', quarantined: quarantinedCount, action: mode };
}

module.exports = {
  processRaidJoin,
  evaluateJoinRisk,
  quarantineMember,
  releaseMember,
  releaseAllQuarantine,
  autoExpireQuarantine,
  ensureQuarantineRole,
  getQuarantinedCount,
  isQuarantined,
  QUARANTINE_ROLE_NAME,
};
