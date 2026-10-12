const { AuditLogEvent, PermissionsBitField, EmbedBuilder } = require('discord.js');
const { getGuildConfig, saveGuildConfig } = require('../config/guildConfig');
const { logAntiNuke, logSecurity } = require('../logging/loggerService');
const { redactSecrets } = require('../utils/helpers');

// Rate tracker: Map<"guildId:actorId:actionKey", number[]>
const actionRateTracker = new Map();
// Cooldown deduplication: Map<"guildId:actorId", number>
const punishmentCooldown = new Map();

/**
 * Checks if a member/user is authorized or immune from anti-nuke enforcement.
 */
function isTrustedUser(guild, userId) {
  if (!guild || !userId) return false;
  // 1. Server Owner is always protected
  if (userId === guild.ownerId) return true;
  // 2. Bot itself is immune
  if (guild.client?.user?.id && userId === guild.client.user.id) return true;
  // 3. Global Bot Owner
  const botOwnerId = process.env.OWNER_ID;
  if (botOwnerId && userId === botOwnerId) return true;

  const config = getGuildConfig(guild.id, guild.name);
  const sec = config.security || {};

  // 4. Configured Trusted Users
  if (sec.trustedUsers && sec.trustedUsers.includes(userId)) return true;

  // 5. Configured Trusted Roles
  const member = guild.members?.cache?.get(userId);
  if (member && sec.trustedRoles && sec.trustedRoles.length > 0) {
    if (member.roles.cache.some(r => sec.trustedRoles.includes(r.id))) return true;
  }

  return false;
}

/**
 * Checks rate thresholds using in-memory sliding windows (sub-millisecond evaluation).
 */
function recordAndCheckThreshold(guildId, actorId, actionKey, customLimit = null, customWindowMs = null) {
  const config = getGuildConfig(guildId);
  const sec = config.security || {};
  const thresholds = sec.thresholds || {};

  const defLimit = customLimit || thresholds[actionKey]?.limit || 3;
  const defWindowMs = customWindowMs || thresholds[actionKey]?.windowMs || 15000;

  const trackerKey = `${guildId}:${actorId}:${actionKey}`;
  const now = Date.now();

  let timestamps = actionRateTracker.get(trackerKey) || [];
  timestamps = timestamps.filter(ts => now - ts < defWindowMs);
  timestamps.push(now);
  actionRateTracker.set(trackerKey, timestamps);

  const count = timestamps.length;
  const triggered = count >= defLimit;

  return {
    triggered,
    count,
    limit: defLimit,
    windowMs: defWindowMs,
  };
}

/**
 * Resolves the actor from Discord Audit Logs with timestamp verification and type matching.
 */
async function resolveAuditActor(guild, auditLogEvent, targetId = null, maxAgeMs = 7000) {
  if (!guild) return null;
  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!me || !me.permissions.has(PermissionsBitField.Flags.ViewAuditLog)) {
    return null;
  }

  try {
    const logs = await guild.fetchAuditLogs({ type: auditLogEvent, limit: 1 }).catch(() => null);
    if (!logs) return null;
    const entry = logs.entries.first();
    if (!entry) return null;

    const age = Date.now() - entry.createdTimestamp;
    if (age > maxAgeMs) return null;

    if (targetId && entry.target && entry.target.id && entry.target.id !== targetId) {
      // If target is specified and doesn't match, attribution is ambiguous
      return null;
    }

    return entry.executor;
  } catch (err) {
    return null;
  }
}

/**
 * Executes configured anti-nuke punishment on an unauthorized actor with honest verification.
 */
async function executeEnforcement(guild, actor, actionName, detectionDetails) {
  const startTime = Date.now();
  const config = getGuildConfig(guild.id, guild.name);
  const sec = config.security || {};
  const actionToTake = sec.action || 'strip_and_ban';

  // Cooldown deduplication: don't execute multiple punishments for same user within 10 seconds
  const cdKey = `${guild.id}:${actor.id}`;
  const lastPunished = punishmentCooldown.get(cdKey) || 0;
  if (Date.now() - lastPunished < 10000) {
    return { executed: false, reason: 'Cooldown active' };
  }
  punishmentCooldown.set(cdKey, Date.now());

  let member = guild.members.cache.get(actor.id) || await guild.members.fetch(actor.id).catch(() => null);
  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);

  let resultSummary = 'Logged';
  let rolesStrippedCount = 0;
  let actionSuccess = false;

  try {
    // 1. Strip Dangerous Roles
    if ((actionToTake === 'quarantine' || actionToTake === 'strip_and_ban' || actionToTake === 'ban') && member) {
      if (me?.permissions?.has(PermissionsBitField.Flags.ManageRoles) && member.manageable) {
        const botHighestRole = me.roles.highest;
        const strippable = member.roles.cache.filter(r => r.id !== guild.roles.everyone.id && r.position < botHighestRole.position);
        rolesStrippedCount = strippable.size;
        if (strippable.size > 0) {
          try {
            await member.roles.remove(strippable, `Anti-Nuke Enforcement: ${actionName}`);
            resultSummary = `Roles Stripped (${rolesStrippedCount})`;
          } catch (_) {}
        }
      }
    }

    // 2. Ban or Kick with genuine verification
    if (actionToTake === 'ban' || actionToTake === 'strip_and_ban') {
      if (!me?.permissions?.has(PermissionsBitField.Flags.BanMembers)) {
        resultSummary = 'Ban Failed (Bot lacks BanMembers permission)';
      } else if (member && !member.bannable) {
        resultSummary = 'Ban Failed (Target role is higher or equal to bot)';
      } else {
        try {
          await guild.bans.create(actor.id, {
            reason: `Anti-Nuke Detection: ${actionName} (${detectionDetails.count}/${detectionDetails.limit} in ${detectionDetails.windowMs / 1000}s)`,
            deleteMessageSeconds: 86400,
          });
          resultSummary = rolesStrippedCount > 0 ? 'INSTANT BAN & ROLES STRIPPED' : 'INSTANT BAN';
          actionSuccess = true;
        } catch (err) {
          resultSummary = `Ban Failed: ${err.message}`;
          console.error(redactSecrets(`Anti-nuke ban failed: ${err.message}`));
        }
      }
    } else if (actionToTake === 'kick') {
      if (!me?.permissions?.has(PermissionsBitField.Flags.KickMembers)) {
        resultSummary = 'Kick Failed (Bot lacks KickMembers permission)';
      } else if (member && !member.kickable) {
        resultSummary = 'Kick Failed (Target role is higher or equal to bot)';
      } else {
        try {
          await member.kick(`Anti-Nuke Detection: ${actionName}`);
          resultSummary = 'INSTANT KICK';
          actionSuccess = true;
        } catch (err) {
          resultSummary = `Kick Failed: ${err.message}`;
        }
      }
    } else if (actionToTake === 'quarantine') {
      resultSummary = rolesStrippedCount > 0 ? `QUARANTINE (${rolesStrippedCount} roles removed)` : 'QUARANTINE (No removable roles found)';
      actionSuccess = rolesStrippedCount > 0;
    } else if (actionToTake === 'alert') {
      resultSummary = 'ALERT SENT (No Punishment)';
      actionSuccess = true;
    }

    const latencyMs = Date.now() - startTime;

    // 3. Record Security Incident
    const incident = {
      id: `INC-${Date.now().toString(36).toUpperCase()}`,
      timestamp: Date.now(),
      actorId: actor.id,
      actorTag: actor.tag || actor.username || actor.id,
      action: actionName,
      detectionCount: detectionDetails.count,
      threshold: detectionDetails.limit,
      windowMs: detectionDetails.windowMs,
      result: resultSummary,
      latencyMs,
    };

    if (!config.incidents) config.incidents = [];
    config.incidents.unshift(incident);
    if (config.incidents.length > 100) config.incidents.pop();
    saveGuildConfig(guild.id, config);

    // 4. Dispatch Embed to #anti-nuke-logs & #security-logs
    const alertEmbed = new EmbedBuilder()
      .setColor(actionSuccess ? '#FF0000' : '#FEE75C')
      .setTitle('🚨 HIGH-SPEED ANTI-NUKE DETECTED!')
      .setDescription(`An unauthorized administrative action burst was intercepted and contained.`)
      .addFields(
        { name: '👤 Offending Actor', value: `${actor.tag || actor.id} (\`${actor.id}\`)`, inline: true },
        { name: '⚔️ Destructive Action', value: actionName, inline: true },
        { name: '📊 Burst Ratio', value: `**${detectionDetails.count}** / ${detectionDetails.limit} in ${detectionDetails.windowMs / 1000}s`, inline: true },
        { name: '🛡️ Containment Action', value: `**${resultSummary}**`, inline: true },
        { name: '⚡ Response Latency', value: `${latencyMs}ms`, inline: true },
        { name: '🆔 Incident Reference', value: `\`${incident.id}\``, inline: true }
      )
      .setFooter({ text: 'High-Speed Discord Security Engine • THOR APEX v2.0' })
      .setTimestamp();

    await logAntiNuke(guild, alertEmbed);
    await logSecurity(guild, alertEmbed);

    console.warn(redactSecrets(`[Anti-Nuke Intercept] Guild: ${guild.name} | Actor: ${actor.tag || actor.id} | Action: ${actionName} | Result: ${resultSummary} (${latencyMs}ms)`));
    return { executed: true, incident, success: actionSuccess };
  } catch (err) {
    console.error(redactSecrets(`Enforcement error: ${err.message}`));
    return { executed: false, error: err.message };
  }
}

/**
 * Primary Anti-Nuke Event Handler called by Discord Gateway events.
 */
async function handleAntiNukeEvent(guild, auditLogType, actionKey, actionLabel, targetId = null) {
  if (!guild) return false;
  const config = getGuildConfig(guild.id, guild.name);
  if (!config.security?.antiNuke) return false;

  // Resolve actor from audit log
  const executor = await resolveAuditActor(guild, auditLogType, targetId);
  if (!executor) {
    // If actor is unknown or audit log delayed, log alert without punishing random users
    return false;
  }

  // Check trusted exemptions
  if (isTrustedUser(guild, executor.id)) {
    return false;
  }

  // Rate tracking & threshold check
  const check = recordAndCheckThreshold(guild.id, executor.id, actionKey);
  if (!check.triggered) {
    console.log(redactSecrets(`[Anti-Nuke Monitor] ${executor.tag || executor.id} performed ${actionLabel} (${check.count}/${check.limit}) in ${guild.name}`));
    return false;
  }

  // Trigger sub-second punishment
  await executeEnforcement(guild, executor, actionLabel, check);
  return true;
}

module.exports = {
  isTrustedUser,
  recordAndCheckThreshold,
  resolveAuditActor,
  executeEnforcement,
  handleAntiNukeEvent,
};
