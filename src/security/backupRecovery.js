const { ChannelType, PermissionsBitField } = require('discord.js');
const { getGuildConfig, saveGuildConfigAsync } = require('../config/guildConfig');

/**
 * THOR APEX Server Structure Snapshot & Recovery Engine (Phase 6 & 7)
 *
 * Capabilities:
 * - Creates complete non-destructive snapshots of channels, permissions, and roles
 * - Safe emergency lockdown that preserves the full original permission overwrites
 * - Skips channels that are already hidden (ViewChannel denied) to avoid breaking
 *   private channels, SERVER LOGS channels, and category-inherited privacy
 * - Full restoration engine: restores the exact full overwrite bitfield atomically
 * - Partial-failure tracking so admins can see which channels failed and retry
 * - Concurrency lock: prevents simultaneous lockdown/unlock from corrupting state
 * - Persists lockdown state (including who engaged it and when) across bot restarts
 * - NEVER claims deleted messages can be recovered (honoring Discord API limitations)
 * - Excludes any secrets, webhook tokens, or bot credentials
 */

// Concurrency locks per guild: Map<guildId, Promise>
const lockdownLocks = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

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
    type: ov.type,   // 0 = role overwrite, 1 = member overwrite
    allow: (ov.allow?.bitfield ?? 0n).toString(),
    deny:  (ov.deny?.bitfield  ?? 0n).toString(),
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
 *
 * This is the mechanism behind SERVER LOGS channels (and any other private
 * category): the individual channel has no @everyone overwrite, but the
 * parent category has ViewChannel denied. If we were to create a new
 * per-channel overwrite, the category inheritance would be broken.
 */
function isCategoryHidden(ch, guild, everyoneId) {
  if (!ch.parentId) return false;
  const category = guild.channels.cache.get(ch.parentId);
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
 *
 * We must never touch hidden channels during lockdown because:
 * 1. They don't need to be restricted (members can't see them anyway).
 * 2. Creating or editing their @everyone overwrite can break category
 *    inheritance and make them accidentally visible.
 */
function isChannelHiddenFromEveryone(ch, guild, everyoneId) {
  return isExplicitlyHidden(ch, everyoneId) || isCategoryHidden(ch, guild, everyoneId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

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
            id:    ov.id,
            type:  ov.type,
            allow: (ov.allow?.bitfield ?? 0n).toString(),
            deny:  (ov.deny?.bitfield  ?? 0n).toString(),
          });
        }
      }

      channels.push({
        id:                  ch.id,
        name:                ch.name,
        type:                ch.type,
        parentId:            ch.parentId || null,
        position:            ch.position,
        topic:               ch.topic || '',
        nsfw:                !!ch.nsfw,
        rateLimitPerUser:    ch.rateLimitPerUser || 0,
        permissionOverwrites: overwrites,
      });
    }
  }

  const roles = [];
  if (guild.roles?.cache) {
    for (const [, r] of guild.roles.cache) {
      if (!r || r.managed || r.id === guild.roles.everyone?.id) continue;
      roles.push({
        id:          r.id,
        name:        r.name,
        color:       r.color,
        hoist:       r.hoist,
        position:    r.position,
        permissions: r.permissions.bitfield.toString(),
        mentionable: r.mentionable,
      });
    }
  }

  return {
    guildId:      guild.id,
    guildName:    guild.name,
    timestamp:    Date.now(),
    channelCount: channels.length,
    roleCount:    roles.length,
    channels,
    roles,
  };
}

/**
 * Performs emergency server lockdown.
 *
 * SAFETY RULES (applied for every channel before touching it):
 *
 *   SKIP if the channel is hidden from @everyone (ViewChannel denied
 *   explicitly on the channel, or denied on the parent category).
 *   ↳ This protects private channels, staff channels, and SERVER LOGS.
 *
 *   SKIP if @everyone already has SendMessages (text) or Connect (voice)
 *   explicitly denied — the channel is already effectively locked.
 *
 * For channels that pass both checks:
 *   1. Snapshot the COMPLETE current @everyone overwrite (all allow/deny bits).
 *      If no explicit overwrite exists, record allow=0 / deny=0.
 *   2. Edit only the lockdown-specific bits:
 *      Text → deny SendMessages, AddReactions, CreatePublicThreads, CreatePrivateThreads
 *      Voice → deny Connect
 *
 * State persisted on success:
 *   config.security.lockdown            = true
 *   config.security.lockdownEngagedAt   = timestamp (ms)
 *   config.security.lockdownEngagedBy   = "Tag (id)" label
 *   config.security.preLockdownSnapshot = { [channelId]: { id, type, allow, deny } }
 *
 * @returns {{ success, lockedChannels, skippedChannels, reason?, alreadyLocked? }}
 */
async function engageEmergencyLockdown(
  guild,
  engagedByLabel = 'System',
  reason = 'Emergency Security Lockdown',
) {
  if (!guild) return { success: false, reason: 'Invalid guild' };

  const release = await acquireLock(guild.id);
  try {
    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!me?.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
      return { success: false, reason: 'Bot lacks ManageChannels permission' };
    }

    const config = getGuildConfig(guild.id, guild.name);
    config.security = config.security || {};

    // Re-engage guard — never overwrite an existing snapshot
    if (config.security.lockdown === true) {
      return {
        success: false,
        reason: 'Server is already in lockdown. Unlock first before re-engaging.',
        alreadyLocked: true,
      };
    }

    const everyoneId = guild.roles.everyone.id;
    const snapshot = {};
    const failedChannels = [];
    let lockedCount  = 0;
    let skippedCount = 0;

    for (const [, ch] of guild.channels.cache) {
      // ── Skip categories and threads ────────────────────────────────────────
      if (ch.type === ChannelType.GuildCategory) continue;
      const isThread = typeof ch.isThread === 'function' ? ch.isThread() : false;
      if (isThread) continue;

      const isText  = typeof ch.isTextBased === 'function' ? ch.isTextBased() : false;
      const isVoice = ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice;
      if (!isText && !isVoice) continue;

      // ── Skip channels that @everyone cannot see (hidden channels) ──────────
      // This prevents breaking private channels, staff channels, and
      // SERVER LOGS category children.
      if (isChannelHiddenFromEveryone(ch, guild, everyoneId)) {
        skippedCount++;
        continue;
      }

      // ── Skip channels where the relevant permission is already denied ───────
      const currentOW = ch.permissionOverwrites?.cache?.get?.(everyoneId);
      const alreadyDeniedText  = isText  && ((currentOW?.deny?.bitfield ?? 0n) & PermissionsBitField.Flags.SendMessages) !== 0n;
      const alreadyDeniedVoice = isVoice && ((currentOW?.deny?.bitfield ?? 0n) & PermissionsBitField.Flags.Connect)      !== 0n;

      if (alreadyDeniedText || alreadyDeniedVoice) {
        skippedCount++;
        continue;
      }

      // ── Check bot permissions on this specific channel ─────────────────────
      if (typeof ch.permissionsFor === 'function') {
        const botPerms = ch.permissionsFor(me);
        if (botPerms && !botPerms.has(PermissionsBitField.Flags.ManageChannels)) {
          failedChannels.push({ id: ch.id, name: ch.name || ch.id, error: 'Bot lacks ManageChannels in this channel' });
          continue;
        }
      }

      const editFn = ch.permissionOverwrites?.edit || ch.permissionOverwrites?.create;
      if (typeof editFn !== 'function') {
        failedChannels.push({ id: ch.id, name: ch.name || ch.id, error: 'No edit function on channel' });
        continue;
      }

      // ── Snapshot the full current @everyone overwrite ──────────────────────
      snapshot[ch.id] = currentOW
        ? serialiseOverwrite(currentOW)
        : { id: everyoneId, type: 0, allow: '0', deny: '0' };

      // ── Apply only the lockdown deny bits ──────────────────────────────────
      const denyOptions = isVoice
        ? { Connect: false }
        : {
            SendMessages:        false,
            AddReactions:        false,
            CreatePublicThreads: false,
            CreatePrivateThreads: false,
          };

      try {
        await editFn.call(ch.permissionOverwrites, guild.roles.everyone, denyOptions, { reason });
        lockedCount++;
      } catch (err) {
        // Could not lock this channel — remove from snapshot so unlock won't touch it
        delete snapshot[ch.id];
        failedChannels.push({ id: ch.id, name: ch.name || ch.id, error: err.message || String(err) });
      }
    }

    if (lockedCount === 0 && failedChannels.length > 0) {
      return {
        success: false,
        reason: 'Failed to secure any channels. Check bot channel permissions.',
        lockedChannels: 0,
        skippedChannels: skippedCount,
        failedChannels,
      };
    }

    // Persist state atomically
    config.security.lockdown          = true;
    config.security.lockdownEngagedAt = Date.now();
    config.security.lockdownEngagedBy = engagedByLabel;
    config.security.preLockdownSnapshot = snapshot;
    if (failedChannels.length > 0) {
      config.security.lastLockdownFailures = failedChannels;
    } else {
      delete config.security.lastLockdownFailures;
    }
    delete config.security.preLockdownOverwrites; // clear any stale legacy key

    saveGuildConfigAsync(guild.id, config);

    return {
      success: true,
      lockedChannels: lockedCount,
      skippedChannels: skippedCount,
      failedChannels,
      partial: failedChannels.length > 0,
    };
  } finally {
    release();
  }
}

/**
 * Lifts emergency server lockdown and fully restores the original @everyone
 * permission overwrites that were saved during engageEmergencyLockdown.
 *
 * SAFETY GUARANTEES:
 *   - Returns notLocked:true  if the server is not currently in lockdown and has no pending snapshot.
 *   - Returns noSnapshot:true if no valid snapshot exists (refuses to guess).
 *   - Only modifies channels present in the snapshot.
 *   - Channels with allow=0 / deny=0 have their overwrite DELETED (not reset
 *     to null via edit), fully restoring category inheritance.
 *   - Channels with a non-zero saved overwrite preserve all existing role and member
 *     overwrites atomically, restoring ONLY the @everyone overwrite bitfield.
 *   - Failures are collected; restoration continues for all remaining channels.
 *   - On partial failure the snapshot is PRESERVED so the admin can retry.
 *   - Clears lockdown state only after all channels have been successfully restored.
 *
 * @returns {{
 *   success, unlockedChannels, failedChannels, partial,
 *   reason?, noSnapshot?, notLocked?
 * }}
 */
async function liftEmergencyLockdown(
  guild,
  liftedByLabel = 'System',
  reason = 'Security Lockdown Lifted',
) {
  if (!guild) return { success: false, reason: 'Invalid guild' };

  const release = await acquireLock(guild.id);
  try {
    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!me?.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
      return { success: false, reason: 'Bot lacks ManageChannels permission' };
    }

    const config = getGuildConfig(guild.id, guild.name);
    config.security = config.security || {};

    const hasRemainingSnapshot = !!(
      (config.security.preLockdownSnapshot && Object.keys(config.security.preLockdownSnapshot).length > 0) ||
      (config.security.preLockdownOverwrites && Object.keys(config.security.preLockdownOverwrites).length > 0)
    );

    // ── Guard: not in lockdown and no pending snapshot to retry ─────────────
    if (!config.security.lockdown && !hasRemainingSnapshot) {
      return {
        success: false,
        notLocked: true,
        reason: 'This server is not currently in lockdown.',
      };
    }

    // ── Guard: no snapshot — refuse to touch permissions ───────────────────
    let effectiveSnapshot = config.security.preLockdownSnapshot || null;

    if (!effectiveSnapshot || Object.keys(effectiveSnapshot).length === 0) {
      // Try legacy migration (old format stored { hadExplicitDeny: false })
      const legacyMap = config.security.preLockdownOverwrites || null;
      if (!legacyMap || Object.keys(legacyMap).length === 0) {
        return {
          success: false,
          noSnapshot: true,
          reason: 'No valid lockdown snapshot found. Cannot safely restore permissions without a snapshot.',
        };
      }
      // Migrate: treat each legacy entry as "no prior overwrite" (delete/null-reset)
      effectiveSnapshot = {};
      const evId = guild.roles.everyone.id;
      for (const chId of Object.keys(legacyMap)) {
        effectiveSnapshot[chId] = { id: evId, type: 0, allow: '0', deny: '0' };
      }
      config.security.preLockdownSnapshot = effectiveSnapshot;
    }

    const everyoneRole = guild.roles.everyone;
    const failedChannels = [];
    let unlockedCount = 0;

    for (const [chId, savedOW] of Object.entries(effectiveSnapshot)) {
      const ch = guild.channels.cache.get(chId);
      if (!ch) {
        // Channel was deleted while in lockdown; remove from snapshot so retry doesn't hang
        delete effectiveSnapshot[chId];
        continue;
      }

      if (typeof ch.permissionOverwrites?.edit !== 'function') {
        failedChannels.push({ id: chId, name: ch.name || chId, error: 'No edit function on channel' });
        continue;
      }

      // Check bot permission in channel if available
      if (typeof ch.permissionsFor === 'function') {
        const botPerms = ch.permissionsFor(me);
        if (botPerms && !botPerms.has(PermissionsBitField.Flags.ManageChannels)) {
          failedChannels.push({ id: chId, name: ch.name || chId, error: 'Bot lacks ManageChannels in this channel' });
          continue;
        }
      }

      try {
        const savedAllow = BigInt(savedOW.allow || '0');
        const savedDeny  = BigInt(savedOW.deny  || '0');

        if (savedAllow === 0n && savedDeny === 0n) {
          // No explicit overwrite existed before lockdown — delete the entry
          // we added so the channel reverts to category inheritance.
          const currentOW = ch.permissionOverwrites.cache?.get?.(everyoneRole.id);
          if (currentOW && typeof ch.permissionOverwrites.delete === 'function') {
            await ch.permissionOverwrites.delete(everyoneRole, reason);
          } else {
            // Fallback if delete is not available: null-reset all lockdown flags
            await ch.permissionOverwrites.edit(everyoneRole, {
              SendMessages:        null,
              AddReactions:        null,
              CreatePublicThreads: null,
              CreatePrivateThreads: null,
              Connect:             null,
            }, { reason });
          }
        } else {
          // There was an explicit overwrite before lockdown — restore it exactly.
          const bit = (flag) => {
            if ((savedDeny  & flag) !== 0n) return false;  // was explicitly denied
            if ((savedAllow & flag) !== 0n) return true;   // was explicitly allowed
            return null;                                    // was inherited
          };

          if (typeof ch.permissionOverwrites.set === 'function') {
            // Atomic: preserve other role and member overwrites so they are never wiped!
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
            // Partial edit — restore all five lockdown-touched flags to their
            // original values (deny / allow / inherit).
            await ch.permissionOverwrites.edit(everyoneRole, {
              ViewChannel:          bit(PermissionsBitField.Flags.ViewChannel),
              SendMessages:         bit(PermissionsBitField.Flags.SendMessages),
              AddReactions:         bit(PermissionsBitField.Flags.AddReactions),
              CreatePublicThreads:  bit(PermissionsBitField.Flags.CreatePublicThreads),
              CreatePrivateThreads: bit(PermissionsBitField.Flags.CreatePrivateThreads),
              Connect:              bit(PermissionsBitField.Flags.Connect),
            }, { reason });
          }
        }
        unlockedCount++;
      } catch (err) {
        failedChannels.push({
          id:    chId,
          name:  ch.name || chId,
          error: err.message || String(err),
        });
      }
    }

    const partial = failedChannels.length > 0;

    // Persist outcome safely
    if (partial) {
      // PRESERVE lockdown state so admin can retry lifting the remaining failed channels
      config.security.lockdown = true;
      config.security.lastUnlockFailures = failedChannels.map(
        f => ({ id: f.id, name: f.name, error: f.error }),
      );
      // Keep the snapshot for the failed channels only so retry works
      const remainingSnapshot = {};
      for (const f of failedChannels) {
        if (effectiveSnapshot[f.id]) remainingSnapshot[f.id] = effectiveSnapshot[f.id];
      }
      config.security.preLockdownSnapshot = remainingSnapshot;
    } else {
      // Full unlock success!
      config.security.lockdown         = false;
      config.security.lockdownLiftedAt = Date.now();
      config.security.lockdownLiftedBy = liftedByLabel;
      config.security.preLockdownSnapshot = {};
      delete config.security.lastUnlockFailures;
    }

    delete config.security.preLockdownOverwrites; // keep legacy key cleared
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
  // Exported for tests
  _internals: { isChannelHiddenFromEveryone, isExplicitlyHidden, isCategoryHidden },
};
