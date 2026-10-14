const { ChannelType, PermissionsBitField } = require('discord.js');
const { getGuildConfig, saveGuildConfigAsync } = require('../config/guildConfig');

/**
 * THOR APEX Server Structure Snapshot & Recovery Engine (Phase 6 & 7)
 *
 * Capabilities:
 * - Creates complete non-destructive snapshots of channels, permissions, and roles
 * - Safe emergency lockdown that preserves the full original @everyone overwrite per-channel
 * - Full restoration engine: restores exactly what was changed — never blindly grants permissions
 * - Partial-failure tracking so admins can see which channels failed and retry
 * - Concurrency lock: prevents simultaneous lockdown/unlock from corrupting state
 * - Persists lockdown state (including who engaged it and when) across bot restarts
 * - NEVER claims deleted messages can be recovered (honoring Discord API limitations)
 * - Excludes any secrets, webhooks tokens, or bot credentials
 */

// Concurrency locks per guild: Map<guildId, Promise>
const lockdownLocks = new Map();

// ─────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────

/**
 * Acquires a per-guild lock before modifying lockdown state.
 * Returns a release function.
 */
async function acquireLock(guildId) {
  if (lockdownLocks.has(guildId)) {
    try {
      await lockdownLocks.get(guildId);
    } catch (_) {}
  }
  let releaseLock;
  const lockPromise = new Promise(r => { releaseLock = r; });
  lockdownLocks.set(guildId, lockPromise);
  return () => {
    lockdownLocks.delete(guildId);
    releaseLock();
  };
}

/**
 * Serialises a PermissionOverwrite cache entry into a plain object for persistence.
 * Stores allow/deny as BigInt strings so they survive JSON round-trips correctly.
 */
function serialiseOverwrite(ov) {
  return {
    id: ov.id,
    type: ov.type,              // 0 = role, 1 = member
    allow: (ov.allow?.bitfield ?? 0n).toString(),
    deny: (ov.deny?.bitfield ?? 0n).toString(),
  };
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Takes a non-destructive snapshot of the guild channel and role topology.
 * Used for /security status and full-guild recovery planning.
 */
function createGuildSnapshot(guild) {
  if (!guild) return null;

  const channels = [];
  if (guild.channels?.cache) {
    for (const [, ch] of guild.channels.cache) {
      if (!ch || ch.type === ChannelType.GuildCategory) continue;

      const overwrites = [];
      if (ch.permissionOverwrites?.cache) {
        for (const [, ov] of ch.permissionOverwrites.cache) {
          overwrites.push({
            id: ov.id,
            type: ov.type,
            allow: ov.allow?.bitfield?.toString() || '0',
            deny: ov.deny?.bitfield?.toString() || '0',
          });
        }
      }

      channels.push({
        id: ch.id,
        name: ch.name,
        type: ch.type,
        parentId: ch.parentId || null,
        position: ch.position,
        topic: ch.topic || '',
        nsfw: !!ch.nsfw,
        rateLimitPerUser: ch.rateLimitPerUser || 0,
        permissionOverwrites: overwrites,
      });
    }
  }

  const roles = [];
  if (guild.roles?.cache) {
    for (const [, r] of guild.roles.cache) {
      if (!r || r.managed || r.id === guild.roles.everyone?.id) continue;
      roles.push({
        id: r.id,
        name: r.name,
        color: r.color,
        hoist: r.hoist,
        position: r.position,
        permissions: r.permissions.bitfield.toString(),
        mentionable: r.mentionable,
      });
    }
  }

  return {
    guildId: guild.id,
    guildName: guild.name,
    timestamp: Date.now(),
    channelCount: channels.length,
    roleCount: roles.length,
    channels,
    roles,
  };
}

/**
 * Performs emergency server lockdown.
 *
 * For every applicable text/voice/stage channel that does NOT already have
 * SendMessages (or Connect for voice) explicitly denied for @everyone, we:
 *   1. Save the FULL current @everyone overwrite (all flags) as the snapshot.
 *   2. Apply the lockdown deny: SendMessages, AddReactions,
 *      CreatePublicThreads, CreatePrivateThreads, Connect (voice).
 *
 * Channels where @everyone already has SendMessages/Connect denied are
 * skipped — they are NOT added to the snapshot so unlock won't touch them.
 *
 * Persists: config.security.lockdown = true
 *           config.security.lockdownEngagedAt   = timestamp
 *           config.security.lockdownEngagedBy   = "tag (id)"
 *           config.security.preLockdownSnapshot = { [channelId]: { allow, deny } }
 *
 * @returns {{ success: boolean, lockedChannels: number, skippedChannels: number, reason?: string }}
 */
async function engageEmergencyLockdown(guild, engagedByLabel = 'System', reason = 'Emergency Security Lockdown') {
  if (!guild) return { success: false, reason: 'Invalid guild' };

  const release = await acquireLock(guild.id);
  try {
    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!me?.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
      return { success: false, reason: 'Bot lacks ManageChannels permission' };
    }

    const config = getGuildConfig(guild.id, guild.name);
    config.security = config.security || {};

    // If already locked, return early — do not overwrite the existing snapshot
    if (config.security.lockdown === true) {
      return {
        success: false,
        reason: 'Server is already in lockdown. Unlock first before re-engaging.',
        alreadyLocked: true,
      };
    }

    // Build a fresh snapshot map (channel id → serialised pre-lockdown overwrite)
    const snapshot = {};

    const everyoneId = guild.roles.everyone.id;
    let lockedCount = 0;
    let skippedCount = 0;

    for (const [, ch] of guild.channels.cache) {
      // Skip categories and threads
      if (ch.type === ChannelType.GuildCategory) continue;
      const isThread = typeof ch.isThread === 'function' ? ch.isThread() : false;
      if (isThread) continue;

      const isText = typeof ch.isTextBased === 'function' ? ch.isTextBased() : false;
      const isVoice = ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice;

      if (!isText && !isVoice) continue;

      const editFn = ch.permissionOverwrites?.edit || ch.permissionOverwrites?.create;
      if (typeof editFn !== 'function') continue;

      // Read the current @everyone overwrite (may be undefined if no explicit overwrite exists)
      const currentOW = ch.permissionOverwrites?.cache?.get?.(everyoneId);

      // Check if already explicitly denied the key permission we want to deny
      const alreadyDeniedText = isText &&
        (currentOW?.deny?.has?.(PermissionsBitField.Flags.SendMessages) ?? false);
      const alreadyDeniedVoice = isVoice &&
        (currentOW?.deny?.has?.(PermissionsBitField.Flags.Connect) ?? false);

      if (alreadyDeniedText || alreadyDeniedVoice) {
        // Channel was already locked before us — skip, so we don't touch it during unlock
        skippedCount++;
        continue;
      }

      // Snapshot the FULL overwrite (allow + deny bits) — or empty if none existed
      snapshot[ch.id] = currentOW
        ? serialiseOverwrite(currentOW)
        : { id: everyoneId, type: 0, allow: '0', deny: '0' };

      // Apply lockdown deny flags
      const denyOptions = isVoice
        ? { Connect: false }
        : {
            SendMessages: false,
            AddReactions: false,
            CreatePublicThreads: false,
            CreatePrivateThreads: false,
          };

      try {
        await editFn.call(ch.permissionOverwrites, guild.roles.everyone, denyOptions, { reason });
        lockedCount++;
      } catch (_) {
        // Remove from snapshot if we couldn't actually lock it
        delete snapshot[ch.id];
      }
    }

    // Persist state
    config.security.lockdown = true;
    config.security.lockdownEngagedAt = Date.now();
    config.security.lockdownEngagedBy = engagedByLabel;
    config.security.preLockdownSnapshot = snapshot;
    // Legacy key — cleared so stale data doesn't confuse old code paths
    delete config.security.preLockdownOverwrites;

    saveGuildConfigAsync(guild.id, config);

    return { success: true, lockedChannels: lockedCount, skippedChannels: skippedCount };
  } finally {
    release();
  }
}

/**
 * Lifts emergency server lockdown and fully restores the original @everyone
 * permission overwrites saved during engageEmergencyLockdown.
 *
 * Safety guarantees:
 * - If the server is NOT in lockdown, returns an informational result.
 * - If no snapshot exists, refuses to guess — returns an error result.
 * - Only modifies channels that appear in the snapshot (channels that were
 *   pre-locked before lockdown are left completely untouched).
 * - Each channel's FULL original overwrite is restored, not just a null-reset.
 * - Failures per channel are collected; the unlock continues for all others.
 * - Clears lockdown state only after ALL channels have been attempted.
 * - Safe to retry: channels already restored are idempotent on re-edit.
 *
 * @returns {{
 *   success: boolean,
 *   unlockedChannels: number,
 *   failedChannels: Array<{id:string, error:string}>,
 *   partial: boolean,
 *   reason?: string,
 *   noSnapshot?: boolean,
 *   notLocked?: boolean
 * }}
 */
async function liftEmergencyLockdown(guild, liftedByLabel = 'System', reason = 'Security Lockdown Lifted') {
  if (!guild) return { success: false, reason: 'Invalid guild' };

  const release = await acquireLock(guild.id);
  try {
    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!me?.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
      return { success: false, reason: 'Bot lacks ManageChannels permission' };
    }

    const config = getGuildConfig(guild.id, guild.name);
    config.security = config.security || {};

    // Guard: not in lockdown
    if (!config.security.lockdown) {
      return {
        success: false,
        notLocked: true,
        reason: 'This server is not currently in lockdown.',
      };
    }

    // Guard: no snapshot — cannot safely restore
    const snapshot = config.security.preLockdownSnapshot || null;
    if (!snapshot || Object.keys(snapshot).length === 0) {
      // Attempt legacy key migration
      const legacyMap = config.security.preLockdownOverwrites || null;
      if (!legacyMap || Object.keys(legacyMap).length === 0) {
        return {
          success: false,
          noSnapshot: true,
          reason: 'No valid lockdown snapshot found. Cannot safely restore permissions without a snapshot.',
        };
      }
      // Migrate legacy format: treat it as an empty-overwrite map (null-reset strategy)
      // Legacy only tracked { hadExplicitDeny: false } — restore to null (inheritance)
      config.security.preLockdownSnapshot = {};
      for (const chId of Object.keys(legacyMap)) {
        config.security.preLockdownSnapshot[chId] = { id: guild.roles.everyone.id, type: 0, allow: '0', deny: '0' };
      }
    }

    const effectiveSnapshot = config.security.preLockdownSnapshot || {};
    const everyoneRole = guild.roles.everyone;
    const failedChannels = [];
    let unlockedCount = 0;

    for (const [chId, savedOW] of Object.entries(effectiveSnapshot)) {
      const ch = guild.channels.cache.get(chId);
      if (!ch) {
        // Channel was deleted after lockdown — skip silently (not a failure)
        continue;
      }

      if (typeof ch.permissionOverwrites?.edit !== 'function') {
        failedChannels.push({ id: chId, name: ch.name || chId, error: 'No edit function available on channel' });
        continue;
      }

      try {
        // Restore original allow/deny bits
        // If the saved overwrite had allow=0 and deny=0 (no prior explicit overwrite),
        // we reset to null (remove the overwrite Discord added during lockdown).
        const savedAllow = BigInt(savedOW.allow || '0');
        const savedDeny = BigInt(savedOW.deny || '0');

        if (savedAllow === 0n && savedDeny === 0n) {
          // No prior explicit overwrite existed — delete the lockdown overwrite entirely
          const ow = ch.permissionOverwrites.cache?.get?.(everyoneRole.id);
          if (ow && typeof ch.permissionOverwrites.delete === 'function') {
            await ch.permissionOverwrites.delete(everyoneRole, reason);
          } else {
            // Fallback: null-reset via edit (sets back to inherit)
            await ch.permissionOverwrites.edit(everyoneRole, {
              SendMessages: null,
              AddReactions: null,
              CreatePublicThreads: null,
              CreatePrivateThreads: null,
              Connect: null,
            }, { reason });
          }
        } else {
          // Restore exact original overwrite bits using raw bitfield values
          await ch.permissionOverwrites.edit(everyoneRole, {
            SendMessages: savedDeny & PermissionsBitField.Flags.SendMessages
              ? false
              : savedAllow & PermissionsBitField.Flags.SendMessages
                ? true
                : null,
            AddReactions: savedDeny & PermissionsBitField.Flags.AddReactions
              ? false
              : savedAllow & PermissionsBitField.Flags.AddReactions
                ? true
                : null,
            CreatePublicThreads: savedDeny & PermissionsBitField.Flags.CreatePublicThreads
              ? false
              : savedAllow & PermissionsBitField.Flags.CreatePublicThreads
                ? true
                : null,
            CreatePrivateThreads: savedDeny & PermissionsBitField.Flags.CreatePrivateThreads
              ? false
              : savedAllow & PermissionsBitField.Flags.CreatePrivateThreads
                ? true
                : null,
            Connect: savedDeny & PermissionsBitField.Flags.Connect
              ? false
              : savedAllow & PermissionsBitField.Flags.Connect
                ? true
                : null,
          }, { reason });
        }

        unlockedCount++;
      } catch (err) {
        failedChannels.push({
          id: chId,
          name: ch.name || chId,
          error: err.message || String(err),
        });
      }
    }

    const partial = failedChannels.length > 0;

    // Clear lockdown state. If partial, record the failures for admin review.
    config.security.lockdown = false;
    config.security.lockdownLiftedAt = Date.now();
    config.security.lockdownLiftedBy = liftedByLabel;
    config.security.preLockdownSnapshot = {};
    // Keep legacy key cleared
    delete config.security.preLockdownOverwrites;

    if (partial) {
      config.security.lastUnlockFailures = failedChannels.map(f => ({ id: f.id, name: f.name, error: f.error }));
    } else {
      delete config.security.lastUnlockFailures;
    }

    saveGuildConfigAsync(guild.id, config);

    return {
      success: true,
      unlockedChannels: unlockedCount,
      failedChannels,
      partial,
    };
  } finally {
    release();
  }
}

module.exports = {
  createGuildSnapshot,
  engageEmergencyLockdown,
  liftEmergencyLockdown,
};
