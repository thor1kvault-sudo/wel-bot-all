const { AuditLogEvent } = require('discord.js');
const { getGuildConfig } = require('../config/guildConfig');
const { redactSecrets } = require('../utils/helpers');
const {
  checkThreshold,
  isImmuneUser,
  resolveAuditActorRobust,
  executeContainment,
} = require('./securityEngine');

/**
 * Checks if a member/user is authorized or immune from anti-nuke enforcement.
 * Delegates to centralized security engine.
 */
function isTrustedUser(guild, userId) {
  return isImmuneUser(guild, userId);
}

/**
 * Checks rate thresholds using in-memory sliding windows.
 * Delegates to centralized security engine.
 */
function recordAndCheckThreshold(guildId, actorId, actionKey, customLimit = null, customWindowMs = null) {
  return checkThreshold(guildId, actorId, actionKey, customLimit, customWindowMs);
}

/**
 * Resolves the actor from Discord Audit Logs with timestamp verification and type matching.
 * Delegates to robust audit resolver with bounded retries.
 */
async function resolveAuditActor(guild, auditLogEvent, targetId = null, maxAgeMs = 7000) {
  return await resolveAuditActorRobust(guild, auditLogEvent, targetId, { maxAgeMs });
}

/**
 * Executes configured anti-nuke punishment on an unauthorized actor with honest verification.
 * Delegates to thread-safe containment executor.
 */
async function executeEnforcement(guild, actor, actionName, detectionDetails) {
  return await executeContainment(guild, actor, actionName, detectionDetails);
}

/**
 * Primary Anti-Nuke Event Handler called by Discord Gateway events.
 */
async function handleAntiNukeEvent(guild, auditLogType, actionKey, actionLabel, targetId = null) {
  if (!guild) return false;
  const config = getGuildConfig(guild.id, guild.name);
  if (!config.security?.antiNuke) return false;

  // Resolve actor from audit log with retries and target matching
  const executor = await resolveAuditActor(guild, auditLogType, targetId);
  if (!executor) {
    // If actor is unknown or audit log delayed, do not punish random users
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

  // Trigger punishment with concurrency lock
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
