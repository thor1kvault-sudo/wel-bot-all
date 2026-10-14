const { AuditLogEvent } = require('discord.js');
const { getGuildConfig } = require('../config/guildConfig');
const { redactSecrets } = require('../utils/helpers');
const {
  checkThreshold,
  isImmuneUser,
  resolveAuditActorRobust,
  executeContainment,
  processSecurityPipelineEvent,
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
 * Dispatches through the Ultra-Fast Security Pipeline for sub-millisecond local classification,
 * idempotency, decoupled attribution, and thread-safe containment.
 */
async function handleAntiNukeEvent(guild, auditLogType, actionKey, actionLabel, targetId = null, actor = null) {
  if (!guild) return false;
  const config = getGuildConfig(guild.id, guild.name);
  if (!config.security?.antiNuke) return false;

  const result = await processSecurityPipelineEvent({
    guild,
    auditLogType,
    actionKey,
    actionLabel,
    targetId,
    actor,
  });

  return result.contained || false;
}

module.exports = {
  isTrustedUser,
  recordAndCheckThreshold,
  resolveAuditActor,
  executeEnforcement,
  handleAntiNukeEvent,
};
