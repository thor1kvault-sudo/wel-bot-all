const {
  processSecurityPipelineEvent,
  checkWindowThreshold,
  isImmuneUser,
  resolveAuditActorRobust,
  executeContainment,
  getLatencyMetrics,
  recordLatencySample,
  resetPipeline,
  hrtimeToMs,
} = require('./securityPipeline');

/**
 * THOR APEX Centralized High-Speed Security Engine
 *
 * Facade maintaining 100% backward compatibility for all existing modules and tests,
 * backed by the high-resolution, monotonic SecurityPipeline.
 */

function checkThreshold(guildId, actorId, actionKey, customLimit = null, customWindowMs = null) {
  return checkWindowThreshold(guildId, actorId, actionKey, customLimit, customWindowMs);
}

function resetWindows() {
  resetPipeline();
}

module.exports = {
  checkThreshold,
  isImmuneUser,
  resolveAuditActorRobust,
  executeContainment,
  resetWindows,
  // Enhanced pipeline methods
  processSecurityPipelineEvent,
  getLatencyMetrics,
  recordLatencySample,
  resetPipeline,
  hrtimeToMs,
};
