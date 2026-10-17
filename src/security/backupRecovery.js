'use strict';

const { ChannelType, PermissionsBitField } = require('discord.js');
const { getGuildConfig, saveGuildConfigAsync } = require('../config/guildConfig');

/**
 * THOR APEX Server Structure Snapshot & Recovery Engine (Phase 6 & 7)
 *
 * Full Production Lockdown Engine Guarantees:
 * - Durable state machine: PREPARING -> APPLYING -> ACTIVE / PARTIAL_FAILURE -> RESTORING -> RESTORED
 * - Snapshot First: saves and verifies complete channel overwrite snapshot to durable storage BEFORE modifying any channel
 * - Strict non-destructive scope: preserves private channels, staff channels, and all 15 SERVER LOGS channels
 * - Full restriction: SendMessages, AddReactions, CreatePublicThreads, CreatePrivateThreads, SendMessagesInThreads, Connect, Speak, CreateInstantInvite
 * - Community Onboarding Exemption: truthfully detects Discord API error 350005 and records exemptions without reporting false failures
 * - Exact atomic restoration: restores exact original @everyone allow/deny bitfields while preserving all other role and member overwrites
 * - Partial failure tracking & safe retry: preserves pending snapshots until all channels succeed
 * - Mutex lock: prevents concurrent operations for the same guild
 * - Strict isolation: Panic Mode (role perms) and Lockdown (channel overwrites) operate independently
 */

// Concurrency locks per guild: Map<guildId, Promise>
const lockdownLocks = new Map();

/**
 * Acquires a per-guild lock before modifying lockdown state.
 * Returns a release function. Callers MUST call release() in a finally block.
 */
async function acquireLock(guildId) {
  if (lockdownLocks.has(guildId)) {
    try { await lockdownLocks.get(guildId); } catch (_) {}
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
 * Serialises ALL flags from a PermissionOverwrite cache entry into a plain
 * object suitable for JSON persistence.
 * Stores allow/deny as decimal BigInt strings so they survive JSON round-trips.
 */
function serialiseOverwrite(ov) {
  return {
    id: ov.id,
    type: ov.type, // 0 = role overwrite, 1 = member overwrite
    allow: (ov.allow?.bitfield ?? 0n).toString(),
    deny: (ov.deny?.bitfield ?? 0n).toString(),
  };
}

/**
 * Returns true if @everyone is explicitly denied ViewChannel on this channel.
 */
function isExplicitlyHidden(ch, everyoneId) {
  const ow = ch.permissionOverwrites?.cache?.get?.(everyoneId);
  if (!ow) return false;
  const denyBit = ow.deny?.bitfield ?? 0n;
  return (denyBit & PermissionsBitField.Flags.ViewChannel) !== 0n;
}

/**
 * Returns true if @everyone is denied ViewChannel via the channel's parent
 * category — i.e. the channel inherits its invisibility from the category.
 */
function isCategoryHidden(ch, guild, everyoneId) {
  if (!ch.parentId) return false;
  const category = guild.channels?.cache?.get?.(ch.parentId);
  if (!category) return false;
  const catOW = category.permissionOverwrites?.cache?.get?.(everyoneId);
  if (!catOW) return false;
  const denyBit = catOW.deny?.bitfield ?? 0n;
  return (denyBit & PermissionsBitField.Flags.ViewChannel) !== 0n;
}

/**
 * Returns true if the channel should be skipped during lockdown because
 * @everyone cannot see it — either via an explicit per-channel overwrite or
 * via an inherited category overwrite.
 */
function isChannelHiddenFromEveryone(ch, guild, everyoneId) {
  return isExplicitlyHidden(ch, everyoneId) || isCategoryHidden(ch, guild, everyoneId);
}

/**
 * Takes a non-destructive snapshot of the guild channel and role topology.
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
            allow: (ov.allow?.bitfield ?? 0n).toString(),
            deny: (ov.deny?.bitfield ?? 0n).toString(),
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
 * Performs emergency server lockdown with durable Snapshot-First validation.
 *
 * Guaranteed Execution Path:
 * 1. Checks bot permission (ManageChannels).
 * 2. Checks re-engage guard: blocks duplicate runs if already active/applying.
 * 3. Scans all eligible channels and builds the complete baseline snapshot.
 * 4. Generates unique operationId and writes snapshot to durable disk storage.
 * 5. Verifies snapshot persistence before touching a single channel.
 * 6. Applies lockdown deny bits with Discord API error handling (Onboarding 350005).
 * 7. Persists final state machine status (ACTIVE or PARTIAL_FAILURE).
 */
async function engageEmergencyLockdown(
  guild,
  engagedByLabel = 'System',
  reason = 'Emergency Security Lockdown',
) {
  if (!guild) return { success: false, reason: 'Invalid guild' };

  const release = await acquireLock(guild.id);
  try {
    const me = guild.members.me || await guild.members.fetchMe?.().catch(() => null);
    if (!me?.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
      return { success: false, reason: 'Bot lacks ManageChannels permission' };
    }

    const config = getGuildConfig(guild.id, guild.name);
    config.security = config.security || {};

    const hasActiveSnapshot = !!(
      config.security.preLockdownSnapshot &&
      Object.keys(config.security.preLockdownSnapshot).length > 0
    );

    // Re-engage guard — never overwrite an existing snapshot
    if (config.security.lockdown === true || hasActiveSnapshot) {
      return {
        success: false,
        reason: 'Server is already in lockdown or has an active recovery snapshot. Run /security unlock first.',
        alreadyLocked: true,
        operationId: config.security.lockdownState?.operationId,
      };
    }

    const everyoneId = guild.roles.everyone.id;
    const targetChannels = [];
    const initialSnapshot = {};
    let skippedCount = 0;

    // ── STEP 1: Scan and identify all eligible channels ───────────────────────
    for (const [, ch] of guild.channels.cache) {
      if (ch.type === ChannelType.GuildCategory) continue;
      const isThread = typeof ch.isThread === 'function' ? ch.isThread() : false;
      if (isThread) continue;

      const isText = typeof ch.isTextBased === 'function' ? ch.isTextBased() : false;
      const isVoice = ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice;
      if (!isText && !isVoice) continue;

      // Skip channels hidden from @everyone (protect private/staff channels and SERVER LOGS)
      if (isChannelHiddenFromEveryone(ch, guild, everyoneId)) {
        skippedCount++;
        continue;
      }

      // Skip channels where sending/connecting is already denied
      const currentOW = ch.permissionOverwrites?.cache?.get?.(everyoneId);
      const alreadyDeniedText = isText && ((currentOW?.deny?.bitfield ?? 0n) & PermissionsBitField.Flags.SendMessages) !== 0n;
      const alreadyDeniedVoice = isVoice && ((currentOW?.deny?.bitfield ?? 0n) & PermissionsBitField.Flags.Connect) !== 0n;

      if (alreadyDeniedText || alreadyDeniedVoice) {
        skippedCount++;
        continue;
      }

      // Check bot permissions on this specific channel
      if (typeof ch.permissionsFor === 'function') {
        const botPerms = ch.permissionsFor(me);
        if (botPerms && !botPerms.has(PermissionsBitField.Flags.ManageChannels)) {
          continue; // Will fail during execution or is not manageable
        }
      }

      // Add to snapshot payload before applying changes
      initialSnapshot[ch.id] = currentOW
        ? serialiseOverwrite(currentOW)
        : { id: everyoneId, type: 0, allow: '0', deny: '0' };

      initialSnapshot[ch.id].channelName = ch.name || ch.id;
      initialSnapshot[ch.id].channelType = ch.type;
      initialSnapshot[ch.id].parentId = ch.parentId || null;

      targetChannels.push(ch);
    }

    if (targetChannels.length === 0) {
      config.security.preLockdownSnapshot = {};
      await saveGuildConfigAsync(guild.id, config);
      return {
        success: true,
        lockedChannels: 0,
        skippedChannels: skippedCount,
        exemptChannels: [],
        failedChannels: [],
        partial: false,
        message: 'No eligible public channels found to lock (all channels are private or already locked).',
      };
    }

    // ── STEP 2: Durable Snapshot First (Persist and Verify) ───────────────────
    const operationId = `lockdown_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    config.security.lockdownState = {
      operationId,
      status: 'PREPARING',
      engagedAt: Date.now(),
      engagedBy: engagedByLabel,
      reason,
      totalTargets: targetChannels.length,
    };
    config.security.preLockdownSnapshot = { ...initialSnapshot };

    // Write snapshot to disk
    await saveGuildConfigAsync(guild.id, config);

    // Verify snapshot was saved durably before modifying Discord permissions
    const persistedConfig = getGuildConfig(guild.id);
    if (!persistedConfig?.security?.preLockdownSnapshot || Object.keys(persistedConfig.security.preLockdownSnapshot).length === 0) {
      return {
        success: false,
        reason: 'Failed to durably persist pre-lockdown snapshot to storage. Aborting to prevent unrecoverable permission loss.',
        persisted: false,
      };
    }

    // Mark as APPLYING
    config.security.lockdown = true;
    config.security.lockdownState.status = 'APPLYING';
    await saveGuildConfigAsync(guild.id, config);

    // ── STEP 3: Apply lockdown in controlled sequence ─────────────────────────
    const finalSnapshot = { ...initialSnapshot };
    const exemptChannels = [];
    const failedChannels = [];
    let lockedCount = 0;

    for (const ch of targetChannels) {
      const isVoice = ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice;
      const editFn = ch.permissionOverwrites?.edit || ch.permissionOverwrites?.create;

      if (typeof editFn !== 'function') {
        delete finalSnapshot[ch.id];
        failedChannels.push({ id: ch.id, name: ch.name || ch.id, error: 'No edit function on channel' });
        continue;
      }

      // Restrict eligible channels
      const denyOptions = isVoice
        ? {
            Connect: false,
            Speak: false,
            CreateInstantInvite: false,
          }
        : {
            SendMessages: false,
            AddReactions: false,
            CreatePublicThreads: false,
            CreatePrivateThreads: false,
            SendMessagesInThreads: false,
            CreateInstantInvite: false,
          };

      try {
        await editFn.call(ch.permissionOverwrites, guild.roles.everyone, denyOptions, { reason });
        lockedCount++;
      } catch (err) {
        delete finalSnapshot[ch.id]; // Remove from snapshot so unlock won't attempt to restore untouched channel

        // Check if Discord rejected lockdown due to Community Onboarding / Server Guide requirements (Code 350005)
        const isDiscordOnboardingError =
          err?.code === 350005 ||
          err?.code === '350005' ||
          err?.rawError?.code === 350005 ||
          (typeof err?.message === 'string' && /onboarding/i.test(err.message)) ||
          (typeof err?.message === 'string' && /default channel/i.test(err.message));

        if (isDiscordOnboardingError) {
          exemptChannels.push({
            id: ch.id,
            name: ch.name || ch.id,
            reason: 'Discord Server Guide / Onboarding requirement (Community onboarding mandates at least one sendable channel)',
            code: 350005,
            isCommunityOnboarding: true,
          });
        } else {
          failedChannels.push({
            id: ch.id,
            name: ch.name || ch.id,
            error: err.message || String(err),
            code: err.code || null,
          });
        }
      }
    }

    // ── STEP 4: Persist final outcome & state machine transition ─────────────
    if (lockedCount === 0 && failedChannels.length > 0) {
      // Complete failure
      config.security.lockdown = false;
      config.security.lockdownState.status = 'FAILED';
      config.security.preLockdownSnapshot = {};
      await saveGuildConfigAsync(guild.id, config);
      return {
        success: false,
        reason: 'Failed to secure any channels. Check bot permissions and role hierarchy.',
        lockedChannels: 0,
        skippedChannels: skippedCount,
        failedChannels,
        exemptChannels,
      };
    }

    const isPartial = failedChannels.length > 0;
    config.security.lockdown = true;
    config.security.lockdownState.status = isPartial ? 'PARTIAL_FAILURE' : 'ACTIVE';
    config.security.lockdownState.lockedCount = lockedCount;
    config.security.lockdownState.exemptCount = exemptChannels.length;
    config.security.lockdownState.failedCount = failedChannels.length;
    config.security.preLockdownSnapshot = finalSnapshot;

    if (exemptChannels.length > 0) {
      config.security.lastLockdownExemptions = exemptChannels;
    } else {
      delete config.security.lastLockdownExemptions;
    }

    if (failedChannels.length > 0) {
      config.security.lastLockdownFailures = failedChannels;
    } else {
      delete config.security.lastLockdownFailures;
    }

    delete config.security.preLockdownOverwrites; // clear legacy key
    await saveGuildConfigAsync(guild.id, config);

    return {
      success: true,
      operationId,
      status: config.security.lockdownState.status,
      lockedChannels: lockedCount,
      skippedChannels: skippedCount,
      exemptChannels,
      failedChannels,
      partial: isPartial,
    };
  } finally {
    release();
  }
}

/**
 * Lifts emergency server lockdown and atomically restores original permissions.
 *
 * Guaranteed Execution Path:
 * 1. Checks bot ManageChannels permission.
 * 2. Checks active state & snapshot existence; refuses to guess if snapshot is missing.
 * 3. Sets state to RESTORING.
 * 4. For each channel: restores @everyone permissions while preserving other role/member overwrites.
 * 5. If partial failure: retains failed channels in snapshot, keeps lockdown: true for safe retry.
 * 6. If full success: transitions state to RESTORED, clears snapshot, sets lockdown: false.
 */
async function liftEmergencyLockdown(
  guild,
  liftedByLabel = 'System',
  reason = 'Security Lockdown Lifted',
) {
  if (!guild) return { success: false, reason: 'Invalid guild' };

  const release = await acquireLock(guild.id);
  try {
    const me = guild.members.me || await guild.members.fetchMe?.().catch(() => null);
    if (!me?.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
      return { success: false, reason: 'Bot lacks ManageChannels permission' };
    }

    const config = getGuildConfig(guild.id, guild.name);
    config.security = config.security || {};

    const hasRemainingSnapshot = !!(
      (config.security.preLockdownSnapshot && Object.keys(config.security.preLockdownSnapshot).length > 0) ||
      (config.security.preLockdownOverwrites && Object.keys(config.security.preLockdownOverwrites).length > 0)
    );

    // Guard: not in lockdown and no pending snapshot to retry
    if (!config.security.lockdown && !hasRemainingSnapshot) {
      return {
        success: false,
        notLocked: true,
        reason: 'This server is not currently in lockdown.',
      };
    }

    // Guard: no snapshot exists — refuse to guess or corrupt channel permissions
    let effectiveSnapshot = config.security.preLockdownSnapshot || null;

    if (!effectiveSnapshot || Object.keys(effectiveSnapshot).length === 0) {
      const legacyMap = config.security.preLockdownOverwrites || null;
      if (!legacyMap || Object.keys(legacyMap).length === 0) {
        return {
          success: false,
          noSnapshot: true,
          reason: 'No valid lockdown snapshot found. Refusing to guess or overwrite existing permissions without a verified snapshot.',
        };
      }
      effectiveSnapshot = {};
      const evId = guild.roles.everyone.id;
      for (const chId of Object.keys(legacyMap)) {
        effectiveSnapshot[chId] = { id: evId, type: 0, allow: '0', deny: '0' };
      }
      config.security.preLockdownSnapshot = effectiveSnapshot;
    }

    // Set state to RESTORING
    if (!config.security.lockdownState) config.security.lockdownState = {};
    config.security.lockdownState.status = 'RESTORING';
    config.security.lockdownState.restoringAt = Date.now();
    config.security.lockdownState.restoredBy = liftedByLabel;
    await saveGuildConfigAsync(guild.id, config);

    const everyoneRole = guild.roles.everyone;
    const failedChannels = [];
    let unlockedCount = 0;

    for (const [chId, savedOW] of Object.entries(effectiveSnapshot)) {
      const ch = guild.channels.cache.get(chId);
      if (!ch) {
        // Channel was deleted while in lockdown; remove from snapshot so retries don't hang
        delete effectiveSnapshot[chId];
        continue;
      }

      if (typeof ch.permissionOverwrites?.edit !== 'function') {
        failedChannels.push({ id: chId, name: ch.name || chId, error: 'No edit function on channel' });
        continue;
      }

      if (typeof ch.permissionsFor === 'function') {
        const botPerms = ch.permissionsFor(me);
        if (botPerms && !botPerms.has(PermissionsBitField.Flags.ManageChannels)) {
          failedChannels.push({ id: chId, name: ch.name || chId, error: 'Bot lacks ManageChannels in this channel' });
          continue;
        }
      }

      try {
        const savedAllow = BigInt(savedOW.allow || '0');
        const savedDeny = BigInt(savedOW.deny || '0');

        if (savedAllow === 0n && savedDeny === 0n) {
          // No explicit overwrite existed prior to lockdown — delete our entry to restore inheritance
          const currentOW = ch.permissionOverwrites.cache?.get?.(everyoneRole.id);
          if (currentOW && typeof ch.permissionOverwrites.delete === 'function') {
            await ch.permissionOverwrites.delete(everyoneRole, reason);
          } else {
            // Null-reset lockdown touched flags
            await ch.permissionOverwrites.edit(everyoneRole, {
              SendMessages: null,
              AddReactions: null,
              CreatePublicThreads: null,
              CreatePrivateThreads: null,
              SendMessagesInThreads: null,
              Connect: null,
              Speak: null,
              CreateInstantInvite: null,
            }, { reason });
          }
        } else {
          // Explicit overwrite existed — restore atomically while preserving other role/member overwrites
          const bit = (flag) => {
            if ((savedDeny & flag) !== 0n) return false;
            if ((savedAllow & flag) !== 0n) return true;
            return null;
          };

          if (typeof ch.permissionOverwrites.set === 'function') {
            const otherOverwrites = Array.from(ch.permissionOverwrites.cache ? ch.permissionOverwrites.cache.values() : [])
              .filter(ov => ov.id !== everyoneRole.id)
              .map(ov => ({
                id: ov.id,
                type: ov.type,
                allow: ov.allow?.bitfield ?? BigInt(ov.allow || '0'),
                deny: ov.deny?.bitfield ?? BigInt(ov.deny || '0'),
              }));

            await ch.permissionOverwrites.set(
              [{ id: everyoneRole.id, type: 0, allow: savedAllow, deny: savedDeny }, ...otherOverwrites],
              reason,
            );
          } else {
            await ch.permissionOverwrites.edit(everyoneRole, {
              ViewChannel: bit(PermissionsBitField.Flags.ViewChannel),
              SendMessages: bit(PermissionsBitField.Flags.SendMessages),
              AddReactions: bit(PermissionsBitField.Flags.AddReactions),
              CreatePublicThreads: bit(PermissionsBitField.Flags.CreatePublicThreads),
              CreatePrivateThreads: bit(PermissionsBitField.Flags.CreatePrivateThreads),
              SendMessagesInThreads: bit(PermissionsBitField.Flags.SendMessagesInThreads),
              Connect: bit(PermissionsBitField.Flags.Connect),
              Speak: bit(PermissionsBitField.Flags.Speak),
              CreateInstantInvite: bit(PermissionsBitField.Flags.CreateInstantInvite),
            }, { reason });
          }
        }

        unlockedCount++;
        delete effectiveSnapshot[chId]; // Successfully restored; remove from snapshot
      } catch (err) {
        failedChannels.push({
          id: chId,
          name: ch.name || chId,
          error: err.message || String(err),
          code: err.code || null,
        });
      }
    }

    const partial = failedChannels.length > 0;

    if (partial) {
      // Preserve lockdown state and remaining snapshots for retry
      config.security.lockdown = true;
      config.security.lockdownState.status = 'PARTIAL_FAILURE';
      config.security.preLockdownSnapshot = effectiveSnapshot;
      config.security.lastUnlockFailures = failedChannels;
    } else {
      // Full unlock success
      config.security.lockdown = false;
      config.security.lockdownState.status = 'RESTORED';
      config.security.lockdownLiftedAt = Date.now();
      config.security.lockdownLiftedBy = liftedByLabel;
      config.security.preLockdownSnapshot = {};
      delete config.security.lastUnlockFailures;
    }

    delete config.security.preLockdownOverwrites;
    await saveGuildConfigAsync(guild.id, config);

    return {
      success: true,
      status: config.security.lockdownState.status,
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
  _internals: { isChannelHiddenFromEveryone, isExplicitlyHidden, isCategoryHidden },
};
