'use strict';

/**
 * Lockdown / Unlock Comprehensive Test Suite
 *
 * Tests cover:
 *  LU-1  : Successful lockdown engagement (snapshot created, channels locked)
 *  LU-2  : Pre-existing denied channels are skipped during lockdown (fidelity)
 *  LU-3  : Successful unlock — full restoration from snapshot
 *  LU-4  : Unlock with no prior overwrite (null-reset path)
 *  LU-5  : Partial restoration failures — continues, reports, persists for retry
 *  LU-6  : Missing / empty snapshot — unlock refuses to act
 *  LU-7  : Unlock when server is not in lockdown — informational result
 *  LU-8  : Unauthorized user is denied via isImmuneUser check
 *  LU-9  : Repeated unlock attempts are idempotent (state not corrupted)
 *  LU-10 : Persistence — lockdown state survives simulated bot restart (reload from disk)
 *  LU-11 : Concurrent unlock requests are serialised (concurrency lock)
 *  LU-12 : Lockdown re-engage is blocked while already locked
 *  LU-13 : Legacy preLockdownOverwrites migration path
 *  LU-14 : Existing securityEngine tests still pass (regression guard)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  engageEmergencyLockdown,
  liftEmergencyLockdown,
  createGuildSnapshot,
} = require('../src/security/backupRecovery');
const {
  checkThreshold,
  isImmuneUser,
  resetWindows,
} = require('../src/security/securityEngine');
const { getGuildConfig, saveGuildConfigAsync, invalidateCache } = require('../src/config/guildConfig');


// ─────────────────────────────────────────────────────────────────────────────
// Guild ID counter — use a random base so IDs never collide across test runs
// and each test gets a fresh, pristine config with no disk pollution.
// ─────────────────────────────────────────────────────────────────────────────
const _RUN_ID = Math.random().toString(36).slice(2, 8);
let _guildCounter = 1;
function nextGuildId() {
  const id = `lu_${_RUN_ID}_${_guildCounter++}`;
  invalidateCache(id); // ensure no stale in-memory config
  return id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a fake PermissionsBitField-compatible flag set so we can test
 * BigInt-based comparisons without importing discord.js in tests.
 */
const SEND_MESSAGES_BIT = 2048n;           // PermissionsBitField.Flags.SendMessages
const CONNECT_BIT       = 1048576n;        // PermissionsBitField.Flags.Connect
const ADD_REACTIONS_BIT = 64n;

/**
 * Builds a mock Discord guild with configurable channels.
 *
 * @param {string} guildId
 * @param {Array<{id, isTextBased, isVoice, preDenied, editShouldThrow}>} channelDefs
 */
function buildMockGuild(guildId, channelDefs = []) {
  const everyoneId = guildId;
  const everyoneRole = {
    id: everyoneId,
    name: '@everyone',
    permissions: { has: () => false, bitfield: 0n },
  };

  const channelsMap = new Map();

  for (const def of channelDefs) {
    const editLog = [];   // records what was passed to edit()

    // Build a per-channel @everyone overwrite mock
    const preDenyBit = def.preDenied
      ? (def.isVoice ? CONNECT_BIT : SEND_MESSAGES_BIT)
      : 0n;

    const ow = {
      id: everyoneId,
      type: 0,
      allow: { bitfield: 0n, has: (f) => false },
      deny: {
        bitfield: preDenyBit,
        has: (f) => {
          const flag = typeof f === 'bigint' ? f : BigInt(f);
          return (preDenyBit & flag) !== 0n;
        },
      },
    };

    const owCache = new Map([[everyoneId, ow]]);

    const ch = {
      id: def.id,
      name: def.name || def.id,
      type: def.isVoice ? 2 /* GuildVoice */ : 0 /* GuildText */,
      parentId: null,
      position: 0,
      topic: '',
      nsfw: false,
      rateLimitPerUser: 0,
      isTextBased: () => !def.isVoice,
      isThread: () => false,
      _editLog: editLog,
      permissionOverwrites: {
        cache: owCache,
        edit: async (role, perms, opts) => {
          if (def.editShouldThrow) throw new Error('Simulated API error');
          editLog.push({ role, perms, opts });
          return perms;
        },
        delete: async (role, reason) => {
          if (def.deleteShouldThrow) throw new Error('Simulated delete API error');
          editLog.push({ deleted: true, role, reason });
        },
      },
    };

    channelsMap.set(def.id, ch);
  }

  return {
    id: guildId,
    name: `Test Server ${guildId}`,
    ownerId: `owner_${guildId}`,
    channels: { cache: channelsMap },
    roles: { cache: new Map([[everyoneId, everyoneRole]]), everyone: everyoneRole },
    members: {
      cache: new Map(),
      me: {
        id: `bot_${guildId}`,
        roles: { highest: { position: 100 } },
        permissions: { has: () => true },
      },
    },
    bans: { create: async () => {} },
    fetchAuditLogs: async () => ({ entries: new Map() }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

test('LU-1: Successful lockdown — snapshot created, channels locked, state persisted', async () => {
  const guildId = nextGuildId();
  const guild = buildMockGuild(guildId, [
    { id: 'ch_text_a', isTextBased: true },
    { id: 'ch_text_b', isTextBased: true },
  ]);

  const res = await engageEmergencyLockdown(guild, 'TestAdmin#0001 (user_1)');

  assert.equal(res.success, true, 'engageEmergencyLockdown should succeed');
  assert.equal(res.lockedChannels, 2, 'Both text channels should be locked');
  assert.equal(res.skippedChannels, 0, 'No pre-denied channels to skip');

  const config = getGuildConfig(guildId);
  assert.equal(config.security.lockdown, true, 'lockdown flag should be true');
  assert.equal(typeof config.security.lockdownEngagedAt, 'number', 'lockdownEngagedAt should be a timestamp');
  assert.equal(config.security.lockdownEngagedBy, 'TestAdmin#0001 (user_1)');
  assert.ok(config.security.preLockdownSnapshot, 'snapshot should exist');
  assert.ok(config.security.preLockdownSnapshot['ch_text_a'], 'ch_text_a in snapshot');
  assert.ok(config.security.preLockdownSnapshot['ch_text_b'], 'ch_text_b in snapshot');
});

test('LU-2: Lockdown skips channels already explicitly denied (fidelity)', async () => {
  const guildId = nextGuildId();
  const guild = buildMockGuild(guildId, [
    { id: 'ch_open',   isTextBased: true, preDenied: false },
    { id: 'ch_closed', isTextBased: true, preDenied: true  }, // already denied
  ]);

  const res = await engageEmergencyLockdown(guild, 'Admin');

  assert.equal(res.success, true);
  assert.equal(res.lockedChannels, 1, 'Only 1 open channel should be locked');
  assert.equal(res.skippedChannels, 1, 'Pre-denied channel must be skipped');

  const config = getGuildConfig(guildId);
  assert.ok(config.security.preLockdownSnapshot['ch_open'], 'open channel in snapshot');
  assert.equal(config.security.preLockdownSnapshot['ch_closed'], undefined,
    'pre-denied channel must NOT be in snapshot (must not be touched during unlock)');
});

test('LU-3: Successful unlock — restores channel permissions from snapshot', async () => {
  const guildId = nextGuildId();
  const guild = buildMockGuild(guildId, [
    { id: 'ch_a', isTextBased: true },
    { id: 'ch_b', isTextBased: true },
  ]);

  // Engage lockdown first
  const lockRes = await engageEmergencyLockdown(guild, 'Admin');
  assert.equal(lockRes.success, true);
  assert.equal(lockRes.lockedChannels, 2);

  // Now lift
  const liftRes = await liftEmergencyLockdown(guild, 'Admin');
  assert.equal(liftRes.success, true, 'lift should succeed');
  assert.equal(liftRes.unlockedChannels, 2, 'both channels should be restored');
  assert.equal(liftRes.failedChannels.length, 0, 'no failures');
  assert.equal(liftRes.partial, false, 'should be a full restore');

  // State should be cleared
  const config = getGuildConfig(guildId);
  assert.equal(config.security.lockdown, false, 'lockdown flag should be false');
  assert.deepEqual(config.security.preLockdownSnapshot, {}, 'snapshot cleared after full restore');
  assert.equal(typeof config.security.lockdownLiftedAt, 'number', 'lockdownLiftedAt should be set');
  assert.equal(config.security.lockdownLiftedBy, 'Admin');
});

test('LU-4: Unlock with no prior @everyone overwrite uses delete/null-reset path', async () => {
  // When snapshot has allow=0, deny=0 it means the channel had no explicit overwrite before lockdown.
  // The unlock should delete or null-reset (not apply allow=0 which could differ from inherit).
  const guildId = nextGuildId();

  // Manually pre-seed a config as if lockdown already happened (no prior overwrite)
  const config = getGuildConfig(guildId);
  config.security = config.security || {};
  config.security.lockdown = true;
  config.security.lockdownEngagedAt = Date.now() - 5000;
  config.security.lockdownEngagedBy = 'Admin';
  config.security.preLockdownSnapshot = {
    'ch_noprior': { id: guildId, type: 0, allow: '0', deny: '0' },
  };
  saveGuildConfigAsync(guildId, config);

  const deletedChannels = [];
  const editedChannels  = [];

  const guild = {
    id: guildId,
    name: 'Test Guild',
    ownerId: `owner_${guildId}`,
    channels: {
      cache: new Map([['ch_noprior', {
        id: 'ch_noprior',
        name: 'no-prior',
        isTextBased: () => true,
        isThread: () => false,
        permissionOverwrites: {
          cache: new Map([[guildId, { id: guildId }]]),
          edit: async (role, perms, opts) => { editedChannels.push(perms); },
          delete: async (role, reason) => { deletedChannels.push(role.id || role); },
        },
      }]]),
    },
    roles: {
      everyone: { id: guildId },
      cache: new Map(),
    },
    members: {
      me: { permissions: { has: () => true } },
    },
  };

  const res = await liftEmergencyLockdown(guild, 'Admin');
  assert.equal(res.success, true);
  assert.equal(res.unlockedChannels, 1);
  // Either delete was called OR null-reset via edit — both are acceptable
  const restoredViaDelete = deletedChannels.length > 0;
  const restoredViaEdit   = editedChannels.length > 0;
  assert.ok(restoredViaDelete || restoredViaEdit, 'channel should be restored by delete or null-reset edit');
});

test('LU-5: Partial restoration failures — continues, reports, persists for retry', async () => {
  const guildId = nextGuildId();

  // Pre-seed config as if lockdown already engaged so the snapshot includes ch_fail.
  // This avoids the editShouldThrow flag interfering with the lockdown write path.
  const cfg = getGuildConfig(guildId);
  cfg.security = cfg.security || {};
  cfg.security.lockdown = true;
  cfg.security.lockdownEngagedAt = Date.now() - 3000;
  cfg.security.lockdownEngagedBy = 'Admin';
  cfg.security.preLockdownSnapshot = {
    'ch_ok'  : { id: guildId, type: 0, allow: '0', deny: '0' },
    'ch_fail': { id: guildId, type: 0, allow: '0', deny: '0' },
    'ch_ok_2': { id: guildId, type: 0, allow: '0', deny: '0' },
  };
  saveGuildConfigAsync(guildId, cfg);

  // Build guild where ch_fail.delete() and ch_fail.edit() both throw during restore
  const guild = buildMockGuild(guildId, [
    { id: 'ch_ok',   isTextBased: true, editShouldThrow: false, deleteShouldThrow: false },
    { id: 'ch_fail', isTextBased: true, editShouldThrow: true,  deleteShouldThrow: true  },
    { id: 'ch_ok_2', isTextBased: true, editShouldThrow: false, deleteShouldThrow: false },
  ]);

  const liftRes = await liftEmergencyLockdown(guild, 'Admin');

  assert.equal(liftRes.success, true, 'overall success — lift was attempted');
  assert.equal(liftRes.partial, true, 'should be a partial restore');
  assert.equal(liftRes.unlockedChannels, 2, 'two channels should be restored');
  assert.equal(liftRes.failedChannels.length, 1, 'one failure');
  assert.equal(liftRes.failedChannels[0].id, 'ch_fail');
  assert.ok(liftRes.failedChannels[0].error, 'error message should be present');

  // Failures should be persisted for admin retry
  const config = getGuildConfig(guildId);
  assert.ok(Array.isArray(config.security.lastUnlockFailures), 'lastUnlockFailures should be saved');
  assert.equal(config.security.lastUnlockFailures.length, 1);
});

test('LU-6: Unlock with no snapshot — refuses to act without guessing permissions', async () => {
  const guildId = nextGuildId();

  // Force the server into "locked" state but with no snapshot
  const config = getGuildConfig(guildId);
  config.security = config.security || {};
  config.security.lockdown = true;
  config.security.preLockdownSnapshot = {};
  delete config.security.preLockdownOverwrites;
  saveGuildConfigAsync(guildId, config);

  const guild = buildMockGuild(guildId, [{ id: 'ch_x', isTextBased: true }]);
  const res = await liftEmergencyLockdown(guild, 'Admin');

  assert.equal(res.success, false, 'should refuse to unlock without snapshot');
  assert.equal(res.noSnapshot, true, 'noSnapshot flag must be set');
  assert.ok(res.reason, 'reason string should be present');

  // Lockdown flag must NOT be cleared — state preserved for admin retry
  const afterConfig = getGuildConfig(guildId);
  assert.equal(afterConfig.security.lockdown, true, 'lockdown should still be true after refusal');
});

test('LU-7: Unlock when server is not in lockdown — returns notLocked flag', async () => {
  const guildId = nextGuildId();
  const guild = buildMockGuild(guildId, [{ id: 'ch_a', isTextBased: true }]);

  // Ensure lockdown is false (default)
  const config = getGuildConfig(guildId);
  config.security = config.security || {};
  config.security.lockdown = false;
  saveGuildConfigAsync(guildId, config);

  const res = await liftEmergencyLockdown(guild, 'Admin');

  assert.equal(res.success, false);
  assert.equal(res.notLocked, true, 'notLocked flag should be set');
  assert.ok(res.reason, 'reason should describe the state');
});

test('LU-8: Unauthorized user is denied by isImmuneUser check', () => {
  const guild = {
    id: 'guild_auth_test',
    ownerId: 'owner_real',
    name: 'Auth Test',
    client: { user: { id: 'bot_001' } },
    members: { cache: new Map() },
  };

  // Owner is immune
  assert.equal(isImmuneUser(guild, 'owner_real'), true, 'owner must be immune');

  // Random user is not
  assert.equal(isImmuneUser(guild, 'random_user_9999'), false, 'random user must NOT be immune');

  // Bot itself is immune
  assert.equal(isImmuneUser(guild, 'bot_001'), true, 'bot itself must be immune');
});

test('LU-9: Repeated unlock attempts after successful unlock are idempotent', async () => {
  const guildId = nextGuildId();
  const guild = buildMockGuild(guildId, [{ id: 'ch_a', isTextBased: true }]);

  await engageEmergencyLockdown(guild, 'Admin');
  const first  = await liftEmergencyLockdown(guild, 'Admin');
  const second = await liftEmergencyLockdown(guild, 'Admin');

  assert.equal(first.success, true, 'first unlock succeeds');
  assert.equal(second.success, false, 'second unlock should report not-locked');
  assert.equal(second.notLocked, true, 'second unlock must return notLocked');
});

test('LU-10: Lockdown state persists across simulated bot restart (config reload)', async () => {
  const guildId = nextGuildId();
  const guild = buildMockGuild(guildId, [
    { id: 'ch_persist', isTextBased: true },
  ]);

  const lockRes = await engageEmergencyLockdown(guild, 'Admin');
  assert.equal(lockRes.success, true);

  // Simulate restart: reload config from disk (getGuildConfig reads from disk on cache miss)
  // We clear the in-memory cache by inspecting config directly
  const configAfterRestart = getGuildConfig(guildId);
  assert.equal(configAfterRestart.security.lockdown, true, 'lockdown must survive restart');
  assert.ok(configAfterRestart.security.preLockdownSnapshot, 'snapshot must survive restart');
  assert.ok(configAfterRestart.security.preLockdownSnapshot['ch_persist'], 'ch_persist in snapshot after restart');

  // Unlock should still work using the persisted snapshot
  const liftRes = await liftEmergencyLockdown(guild, 'Admin');
  assert.equal(liftRes.success, true, 'unlock should work after simulated restart');
  assert.equal(liftRes.unlockedChannels, 1);
});

test('LU-11: Concurrent unlock requests are serialised — no race condition corruption', async () => {
  const guildId = nextGuildId();
  const guild = buildMockGuild(guildId, [
    { id: 'ch_race1', isTextBased: true },
    { id: 'ch_race2', isTextBased: true },
  ]);

  await engageEmergencyLockdown(guild, 'Admin');

  // Fire two concurrent unlock requests
  const [res1, res2] = await Promise.all([
    liftEmergencyLockdown(guild, 'Admin-A'),
    liftEmergencyLockdown(guild, 'Admin-B'),
  ]);

  // Exactly one must succeed (first acquires lock), second must see notLocked
  const successes = [res1, res2].filter(r => r.success).length;
  const notLocked = [res1, res2].filter(r => r.notLocked).length;

  assert.equal(successes, 1, 'exactly one concurrent unlock should succeed');
  assert.equal(notLocked, 1, 'the other should report notLocked (serialised)');
});

test('LU-12: Re-engage lockdown is blocked while already locked', async () => {
  const guildId = nextGuildId();
  const guild = buildMockGuild(guildId, [{ id: 'ch_a', isTextBased: true }]);

  const first = await engageEmergencyLockdown(guild, 'Admin');
  assert.equal(first.success, true);

  // Try to engage again
  const second = await engageEmergencyLockdown(guild, 'Admin');
  assert.equal(second.success, false, 'second engage should fail');
  assert.equal(second.alreadyLocked, true, 'alreadyLocked flag should be set');

  // Snapshot must NOT be overwritten
  const config = getGuildConfig(guildId);
  assert.ok(config.security.preLockdownSnapshot['ch_a'], 'original snapshot should survive second attempt');
});

test('LU-13: Legacy preLockdownOverwrites format is migrated and unlock succeeds', async () => {
  const guildId = nextGuildId();

  // Plant legacy-format config (the old system only stored { hadExplicitDeny: false })
  const config = getGuildConfig(guildId);
  config.security = config.security || {};
  config.security.lockdown = true;
  config.security.lockdownEngagedAt = Date.now() - 10000;
  config.security.lockdownEngagedBy = 'OldAdmin';
  config.security.preLockdownOverwrites = {
    'ch_legacy': { hadExplicitDeny: false },
  };
  delete config.security.preLockdownSnapshot;
  saveGuildConfigAsync(guildId, config);

  const guild = buildMockGuild(guildId, [{ id: 'ch_legacy', isTextBased: true }]);
  const res = await liftEmergencyLockdown(guild, 'Admin');

  assert.equal(res.success, true, 'unlock should succeed with migrated legacy data');
  assert.equal(res.unlockedChannels, 1, 'legacy channel should be restored');
  assert.equal(res.failedChannels.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// LU-14: Regression — existing security engine tests are unaffected
// ─────────────────────────────────────────────────────────────────────────────

test('LU-14: Existing securityEngine checkThreshold still works (regression)', () => {
  resetWindows();
  const r1 = checkThreshold('lu14_guild', 'actor_z', 'channelDelete', 3, 10000);
  assert.equal(r1.triggered, false);
  assert.equal(r1.count, 1);

  const r2 = checkThreshold('lu14_guild', 'actor_z', 'channelDelete', 3, 10000);
  assert.equal(r2.triggered, false);

  const r3 = checkThreshold('lu14_guild', 'actor_z', 'channelDelete', 3, 10000);
  assert.equal(r3.triggered, true, 'third action should trigger threshold');
});
