'use strict';

/**
 * Lockdown / Unlock Permission-Preservation Regression Test Suite
 *
 * Tests cover:
 *  LU-1  : Successful lockdown — snapshot created, channels locked, state persisted
 *  LU-2  : Channels with SendMessages already denied are skipped (old fidelity guard)
 *  LU-3  : Successful unlock — full restoration from snapshot
 *  LU-4  : Unlock with no prior @everyone overwrite uses delete path
 *  LU-5  : Partial restoration failures — continues, reports, preserves snapshot for retry
 *  LU-6  : Missing / empty snapshot — unlock refuses to act
 *  LU-7  : Unlock when server is not in lockdown — notLocked flag
 *  LU-8  : Unauthorized user denied via isImmuneUser check
 *  LU-9  : Repeated unlock attempts are idempotent
 *  LU-10 : Lockdown state persists across simulated bot restart
 *  LU-11 : Concurrent unlock requests serialised (concurrency lock)
 *  LU-12 : Re-engage lockdown blocked while already locked
 *  LU-13 : Legacy preLockdownOverwrites format migrated and unlock succeeds
 *  LU-14 : Existing securityEngine regression guard
 *
 *  ── NEW PERMISSION-PRESERVATION TESTS ──────────────────────────────────────
 *  PP-1  : Explicitly hidden channel (@everyone ViewChannel denied) is skipped during lockdown
 *  PP-2  : Category-inherited hidden channel is skipped during lockdown
 *  PP-3  : SERVER LOGS category pattern — all children skipped, no new overwrites created
 *  PP-4  : Existing non-@everyone role overwrites are not touched during lockdown
 *  PP-5  : Existing member-specific overwrites are not touched during lockdown
 *  PP-6  : Category synchronization (parentId) is not changed by lockdown
 *  PP-7  : Unlock restores exact full overwrite bitfield (ViewChannel + other flags)
 *  PP-8  : Hidden channel remains hidden after full lockdown + unlock cycle
 *  PP-9  : Category-hidden channel remains category-hidden after full lockdown + unlock cycle
 *  PP-10 : Snapshot absent → unlock refuses and leaves lockdown flag set
 *  PP-11 : Partial failure preserves recovery snapshot for failed channels
 *  PP-12 : isExplicitlyHidden and isCategoryHidden helper accuracy
 */

const test  = require('node:test');
const assert = require('node:assert/strict');

const {
  engageEmergencyLockdown,
  liftEmergencyLockdown,
  createGuildSnapshot,
  _internals,
} = require('../src/security/backupRecovery');
const { isExplicitlyHidden, isCategoryHidden, isChannelHiddenFromEveryone } = _internals;

const {
  checkThreshold,
  isImmuneUser,
  resetWindows,
} = require('../src/security/securityEngine');
const { getGuildConfig, saveGuildConfigAsync, invalidateCache } = require('../src/config/guildConfig');

// ─────────────────────────────────────────────────────────────────────────────
// Known PermissionsBitField values (matching discord.js constants)
// ─────────────────────────────────────────────────────────────────────────────
const F = {
  ViewChannel:          1024n,
  SendMessages:         2048n,
  AddReactions:         64n,
  CreatePublicThreads:  34359738368n,
  CreatePrivateThreads: 68719476736n,
  Connect:              1048576n,
  Speak:                2097152n,
  AttachFiles:          32768n,
};

// ─────────────────────────────────────────────────────────────────────────────
// Unique, run-scoped guild IDs
// ─────────────────────────────────────────────────────────────────────────────
const _RUN_ID = Math.random().toString(36).slice(2, 8);
let _counter = 1;
function nextId() {
  const id = `lu_${_RUN_ID}_${_counter++}`;
  invalidateCache(id);
  return id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a mock @everyone overwrite object with arbitrary allow/deny bits.
 * @param {string} everyoneId
 * @param {bigint} allowBits
 * @param {bigint} denyBits
 */
function mockOW(everyoneId, allowBits = 0n, denyBits = 0n) {
  return {
    id:    everyoneId,
    type:  0,
    allow: { bitfield: allowBits, has: (f) => (allowBits & BigInt(f)) !== 0n },
    deny:  { bitfield: denyBits,  has: (f) => (denyBits  & BigInt(f)) !== 0n },
  };
}

/**
 * Builds a complete mock guild.
 *
 * channelDefs:
 *   id             – channel ID
 *   name           – display name
 *   isVoice        – GuildVoice type if true
 *   parentId       – parent category ID (optional)
 *   allowBits      – @everyone overwrite allow bitfield (BigInt, default 0n)
 *   denyBits       – @everyone overwrite deny bitfield (BigInt, default 0n)
 *   noOW           – if true, no @everyone overwrite entry is placed
 *   editShouldThrow
 *   deleteShouldThrow
 *
 * categoryDefs:
 *   id             – category ID
 *   allowBits      – @everyone overwrite allow bitfield (BigInt, default 0n)
 *   denyBits       – @everyone overwrite deny bitfield (BigInt, default 0n)
 *
 * @returns { guild, editLogs }   editLogs[channelId] = array of { role, perms, opts }
 */
function buildMockGuild(guildId, channelDefs = [], categoryDefs = []) {
  const everyoneId  = guildId;
  const everyoneRole = {
    id: everyoneId, name: '@everyone',
    permissions: { has: () => false, bitfield: 0n },
  };

  const channelsMap = new Map();
  const editLogs = {};

  // Add category entries first
  for (const def of categoryDefs) {
    const catOWCache = new Map();
    const catOW = mockOW(everyoneId, def.allowBits || 0n, def.denyBits || 0n);
    catOWCache.set(everyoneId, catOW);
    channelsMap.set(def.id, {
      id:   def.id,
      name: def.name || def.id,
      type: 4, // GuildCategory
      parentId: null,
      permissionOverwrites: { cache: catOWCache, edit: async () => {}, delete: async () => {} },
    });
  }

  // Add channel entries
  for (const def of channelDefs) {
    const log = [];
    editLogs[def.id] = log;

    const owCache = new Map();
    if (!def.noOW) {
      const ow = mockOW(everyoneId, def.allowBits || 0n, def.denyBits || 0n);
      owCache.set(everyoneId, ow);
    }

    const ch = {
      id:              def.id,
      name:            def.name || def.id,
      type:            def.isVoice ? 2 : 0,
      parentId:        def.parentId || null,
      position:        0,
      topic:           '',
      nsfw:            false,
      rateLimitPerUser: 0,
      isTextBased: () => !def.isVoice,
      isThread:    () => false,
      permissionOverwrites: {
        cache: owCache,
        edit: async (role, perms, opts) => {
          if (def.editShouldThrow) throw new Error('Simulated edit error');
          log.push({ op: 'edit', role, perms, opts });
        },
        set: async (overwrites, reason) => {
          if (def.editShouldThrow) throw new Error('Simulated set error');
          log.push({ op: 'set', overwrites, reason });
        },
        delete: async (role, reason) => {
          if (def.deleteShouldThrow) throw new Error('Simulated delete error');
          log.push({ op: 'delete', role, reason });
        },
      },
    };
    channelsMap.set(def.id, ch);
  }

  const guild = {
    id:      guildId,
    name:    `Test Server ${guildId}`,
    ownerId: `owner_${guildId}`,
    channels: { cache: channelsMap },
    roles: {
      cache: new Map([[everyoneId, everyoneRole]]),
      everyone: everyoneRole,
    },
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

  return { guild, editLogs };
}

// ─────────────────────────────────────────────────────────────────────────────
// ── ORIGINAL TESTS (LU-1 … LU-14) ──────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

test('LU-1: Successful lockdown — snapshot created, channels locked, state persisted', async () => {
  const guildId = nextId();
  const { guild } = buildMockGuild(guildId, [
    { id: 'ch_a' },
    { id: 'ch_b' },
  ]);

  const res = await engageEmergencyLockdown(guild, 'TestAdmin (user_1)');

  assert.equal(res.success, true);
  assert.equal(res.lockedChannels, 2);
  assert.equal(res.skippedChannels, 0);

  const cfg = getGuildConfig(guildId);
  assert.equal(cfg.security.lockdown, true);
  assert.ok(cfg.security.preLockdownSnapshot['ch_a']);
  assert.ok(cfg.security.preLockdownSnapshot['ch_b']);
});

test('LU-2: Channels with SendMessages already denied are skipped', async () => {
  const guildId = nextId();
  const { guild } = buildMockGuild(guildId, [
    { id: 'ch_open',   denyBits: 0n },
    { id: 'ch_closed', denyBits: F.SendMessages }, // already locked
  ]);

  const res = await engageEmergencyLockdown(guild, 'Admin');

  assert.equal(res.success, true);
  assert.equal(res.lockedChannels, 1);
  assert.equal(res.skippedChannels, 1);

  const cfg = getGuildConfig(guildId);
  assert.ok(cfg.security.preLockdownSnapshot['ch_open']);
  assert.equal(cfg.security.preLockdownSnapshot['ch_closed'], undefined);
});

test('LU-3: Successful unlock — restores channel permissions from snapshot', async () => {
  const guildId = nextId();
  const { guild } = buildMockGuild(guildId, [{ id: 'ch_a' }, { id: 'ch_b' }]);

  const lockRes = await engageEmergencyLockdown(guild, 'Admin');
  assert.equal(lockRes.success, true);

  const liftRes = await liftEmergencyLockdown(guild, 'Admin');
  assert.equal(liftRes.success, true);
  assert.equal(liftRes.unlockedChannels, 2);
  assert.equal(liftRes.failedChannels.length, 0);
  assert.equal(liftRes.partial, false);

  const cfg = getGuildConfig(guildId);
  assert.equal(cfg.security.lockdown, false);
  assert.deepEqual(cfg.security.preLockdownSnapshot, {});
  assert.ok(typeof cfg.security.lockdownLiftedAt === 'number');
});

test('LU-4: Unlock with no prior @everyone overwrite uses delete path', async () => {
  const guildId = nextId();

  const cfg = getGuildConfig(guildId);
  cfg.security = cfg.security || {};
  cfg.security.lockdown = true;
  cfg.security.preLockdownSnapshot = {
    'ch_noprior': { id: guildId, type: 0, allow: '0', deny: '0' },
  };
  saveGuildConfigAsync(guildId, cfg);

  const deletedChs = [];
  const guild = {
    id: guildId, name: 'T', ownerId: `o_${guildId}`,
    channels: { cache: new Map([['ch_noprior', {
      id: 'ch_noprior', name: 'no-prior',
      permissionOverwrites: {
        cache: new Map([[guildId, { id: guildId }]]),
        edit:   async (r, p) => {},
        delete: async (r)    => { deletedChs.push(r.id || r); },
      },
    }]]) },
    roles: { everyone: { id: guildId }, cache: new Map() },
    members: { me: { permissions: { has: () => true } } },
  };

  const res = await liftEmergencyLockdown(guild, 'Admin');
  assert.equal(res.success, true);
  assert.equal(res.unlockedChannels, 1);
  assert.ok(deletedChs.length > 0, 'overwrite should have been deleted');
});

test('LU-5: Partial failures — continues, reports, preserves snapshot for retry', async () => {
  const guildId = nextId();
  const cfg = getGuildConfig(guildId);
  cfg.security = cfg.security || {};
  cfg.security.lockdown = true;
  cfg.security.preLockdownSnapshot = {
    'ch_ok':   { id: guildId, type: 0, allow: '0', deny: '0' },
    'ch_fail': { id: guildId, type: 0, allow: '0', deny: '0' },
    'ch_ok2':  { id: guildId, type: 0, allow: '0', deny: '0' },
  };
  saveGuildConfigAsync(guildId, cfg);

  const { guild } = buildMockGuild(guildId, [
    { id: 'ch_ok',   editShouldThrow: false, deleteShouldThrow: false },
    { id: 'ch_fail', editShouldThrow: true,  deleteShouldThrow: true  },
    { id: 'ch_ok2',  editShouldThrow: false, deleteShouldThrow: false },
  ]);

  const res = await liftEmergencyLockdown(guild, 'Admin');
  assert.equal(res.success, true);
  assert.equal(res.partial, true);
  assert.equal(res.unlockedChannels, 2);
  assert.equal(res.failedChannels.length, 1);
  assert.equal(res.failedChannels[0].id, 'ch_fail');

  // Snapshot for failed channel preserved for retry
  const afterCfg = getGuildConfig(guildId);
  assert.ok(afterCfg.security.preLockdownSnapshot['ch_fail'],
    'snapshot for failed channel should be preserved for retry');
  assert.equal(afterCfg.security.preLockdownSnapshot['ch_ok'], undefined,
    'successfully restored channels should be removed from snapshot');
});

test('LU-6: Missing snapshot — unlock refuses to act', async () => {
  const guildId = nextId();
  const cfg = getGuildConfig(guildId);
  cfg.security = cfg.security || {};
  cfg.security.lockdown = true;
  cfg.security.preLockdownSnapshot = {};
  delete cfg.security.preLockdownOverwrites;
  saveGuildConfigAsync(guildId, cfg);

  const { guild } = buildMockGuild(guildId, [{ id: 'ch_x' }]);
  const res = await liftEmergencyLockdown(guild, 'Admin');

  assert.equal(res.success, false);
  assert.equal(res.noSnapshot, true);
  const afterCfg = getGuildConfig(guildId);
  assert.equal(afterCfg.security.lockdown, true, 'lockdown must stay true');
});

test('LU-7: Unlock when not in lockdown — notLocked flag', async () => {
  const guildId = nextId();
  const { guild } = buildMockGuild(guildId, [{ id: 'ch_a' }]);
  const cfg = getGuildConfig(guildId);
  cfg.security = cfg.security || {};
  cfg.security.lockdown = false;
  saveGuildConfigAsync(guildId, cfg);

  const res = await liftEmergencyLockdown(guild, 'Admin');
  assert.equal(res.success, false);
  assert.equal(res.notLocked, true);
});

test('LU-8: Unauthorized user is denied by isImmuneUser check', () => {
  const guild = {
    id: 'auth_test', ownerId: 'owner_real', name: 'Auth',
    client: { user: { id: 'bot_001' } },
    members: { cache: new Map() },
  };
  assert.equal(isImmuneUser(guild, 'owner_real'), true);
  assert.equal(isImmuneUser(guild, 'random_99'), false);
  assert.equal(isImmuneUser(guild, 'bot_001'), true);
});

test('LU-9: Repeated unlock is idempotent', async () => {
  const guildId = nextId();
  const { guild } = buildMockGuild(guildId, [{ id: 'ch_a' }]);
  await engageEmergencyLockdown(guild, 'Admin');
  const r1 = await liftEmergencyLockdown(guild, 'Admin');
  const r2 = await liftEmergencyLockdown(guild, 'Admin');
  assert.equal(r1.success, true);
  assert.equal(r2.notLocked, true);
});

test('LU-10: Lockdown state persists across simulated bot restart', async () => {
  const guildId = nextId();
  const { guild } = buildMockGuild(guildId, [{ id: 'ch_p' }]);
  await engageEmergencyLockdown(guild, 'Admin');

  const reloadedCfg = getGuildConfig(guildId);
  assert.equal(reloadedCfg.security.lockdown, true);
  assert.ok(reloadedCfg.security.preLockdownSnapshot['ch_p']);

  const res = await liftEmergencyLockdown(guild, 'Admin');
  assert.equal(res.success, true);
  assert.equal(res.unlockedChannels, 1);
});

test('LU-11: Concurrent unlock requests serialised', async () => {
  const guildId = nextId();
  const { guild } = buildMockGuild(guildId, [{ id: 'ch_r1' }, { id: 'ch_r2' }]);
  await engageEmergencyLockdown(guild, 'Admin');

  const [r1, r2] = await Promise.all([
    liftEmergencyLockdown(guild, 'A'),
    liftEmergencyLockdown(guild, 'B'),
  ]);
  const successes = [r1, r2].filter(r => r.success).length;
  const notLocked = [r1, r2].filter(r => r.notLocked).length;
  assert.equal(successes, 1);
  assert.equal(notLocked, 1);
});

test('LU-12: Re-engage blocked while already locked', async () => {
  const guildId = nextId();
  const { guild } = buildMockGuild(guildId, [{ id: 'ch_a' }]);
  const r1 = await engageEmergencyLockdown(guild, 'Admin');
  assert.equal(r1.success, true);
  const r2 = await engageEmergencyLockdown(guild, 'Admin');
  assert.equal(r2.success, false);
  assert.equal(r2.alreadyLocked, true);
  const cfg = getGuildConfig(guildId);
  assert.ok(cfg.security.preLockdownSnapshot['ch_a']);
});

test('LU-13: Legacy preLockdownOverwrites migration succeeds', async () => {
  const guildId = nextId();
  const cfg = getGuildConfig(guildId);
  cfg.security = cfg.security || {};
  cfg.security.lockdown = true;
  cfg.security.preLockdownOverwrites = { 'ch_leg': { hadExplicitDeny: false } };
  delete cfg.security.preLockdownSnapshot;
  saveGuildConfigAsync(guildId, cfg);

  const { guild } = buildMockGuild(guildId, [{ id: 'ch_leg' }]);
  const res = await liftEmergencyLockdown(guild, 'Admin');
  assert.equal(res.success, true);
  assert.equal(res.unlockedChannels, 1);
});

test('LU-14: securityEngine regression — checkThreshold still works', () => {
  resetWindows();
  const r1 = checkThreshold('lu14_g', 'a', 'channelDelete', 3, 10000);
  assert.equal(r1.triggered, false);
  const r2 = checkThreshold('lu14_g', 'a', 'channelDelete', 3, 10000);
  assert.equal(r2.triggered, false);
  const r3 = checkThreshold('lu14_g', 'a', 'channelDelete', 3, 10000);
  assert.equal(r3.triggered, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// ── NEW PERMISSION-PRESERVATION TESTS (PP-1 … PP-12) ───────────────────────
// ─────────────────────────────────────────────────────────────────────────────

test('PP-1: Explicitly hidden channel (ViewChannel denied) is skipped during lockdown', async () => {
  const guildId = nextId();
  // ch_private has @everyone ViewChannel: denied
  const { guild, editLogs } = buildMockGuild(guildId, [
    { id: 'ch_public',  denyBits: 0n },
    { id: 'ch_private', denyBits: F.ViewChannel },
  ]);

  const res = await engageEmergencyLockdown(guild, 'Admin');
  assert.equal(res.success, true);
  assert.equal(res.lockedChannels, 1,  'only the public channel should be locked');
  assert.equal(res.skippedChannels, 1, 'the hidden channel must be skipped');

  // ch_private must not have been edited
  assert.equal(editLogs['ch_private'].length, 0,
    'lockdown must not call edit() on a hidden channel');

  // ch_private must not appear in snapshot
  const cfg = getGuildConfig(guildId);
  assert.equal(cfg.security.preLockdownSnapshot['ch_private'], undefined,
    'hidden channel must NOT be in snapshot');
});

test('PP-2: Category-inherited hidden channel is skipped during lockdown', async () => {
  const guildId = nextId();
  const catId = `cat_${guildId}`;

  // Category denies ViewChannel for @everyone (SERVER LOGS pattern)
  // Child channel has NO @everyone overwrite of its own — it inherits visibility from category
  const { guild, editLogs } = buildMockGuild(
    guildId,
    [{ id: 'ch_log', parentId: catId, noOW: true }],   // no explicit overwrite
    [{ id: catId,    denyBits: F.ViewChannel }],         // category hides @everyone
  );

  const res = await engageEmergencyLockdown(guild, 'Admin');
  assert.equal(res.success, true);
  assert.equal(res.lockedChannels, 0,  'no channels should be locked (all category-hidden)');
  assert.equal(res.skippedChannels, 1, 'category-hidden channel must be counted as skipped');
  assert.equal(editLogs['ch_log'].length, 0,
    'lockdown must not call edit() on a category-inherited hidden channel');

  const cfg = getGuildConfig(guildId);
  assert.equal(cfg.security.preLockdownSnapshot['ch_log'], undefined,
    'category-hidden channel must NOT be in snapshot');
});

test('PP-3: SERVER LOGS category pattern — all children skipped, no new overwrites created', async () => {
  const guildId = nextId();
  const catId = `serverlog_cat_${guildId}`;

  // Simulate SERVER LOGS: category denies ViewChannel for @everyone
  // Multiple children (security-logs, moderation-logs, etc.) — no per-channel @everyone overwrite
  const logChildren = [
    'security-logs', 'moderation-logs', 'anti-nuke-logs', 'member-logs',
  ].map(name => ({ id: `${name}_${guildId}`, name, parentId: catId, noOW: true }));

  // Also include a regular public channel not in the category
  const { guild, editLogs } = buildMockGuild(
    guildId,
    [...logChildren, { id: 'ch_general', denyBits: 0n }],
    [{ id: catId, denyBits: F.ViewChannel }],
  );

  const res = await engageEmergencyLockdown(guild, 'Admin');
  assert.equal(res.success, true);
  assert.equal(res.lockedChannels, 1,   'only ch_general should be locked');
  assert.equal(res.skippedChannels, 4,  'all 4 log channels must be skipped');

  // Verify no log channel was edited
  for (const child of logChildren) {
    assert.equal(editLogs[child.id].length, 0,
      `${child.name} must not be edited during lockdown`);
  }

  // Verify no log channel is in snapshot
  const cfg = getGuildConfig(guildId);
  for (const child of logChildren) {
    assert.equal(cfg.security.preLockdownSnapshot[child.id], undefined,
      `${child.name} must not be in snapshot`);
  }
});

test('PP-4: Existing non-@everyone role overwrites are not touched by lockdown', async () => {
  const guildId = nextId();
  // Build a channel that has a staff role overwrite AND an @everyone overwrite
  const { guild, editLogs } = buildMockGuild(guildId, [
    { id: 'ch_staff_only', denyBits: 0n },
  ]);

  // Manually add a "staff" role overwrite to the channel's overwrite cache
  const staffRoleId = `staff_${guildId}`;
  const ch = guild.channels.cache.get('ch_staff_only');
  ch.permissionOverwrites.cache.set(staffRoleId, {
    id:    staffRoleId,
    type:  0,
    allow: { bitfield: F.ViewChannel | F.SendMessages, has: () => true },
    deny:  { bitfield: 0n, has: () => false },
  });

  await engageEmergencyLockdown(guild, 'Admin');

  // The edit log should have exactly ONE call (for @everyone lockdown deny)
  // and that call should NOT change the staff role overwrite
  const callsForChannel = editLogs['ch_staff_only'];
  assert.equal(callsForChannel.length, 1);
  // The role passed to edit should be the @everyone role, not the staff role
  const editCall = callsForChannel[0];
  assert.notEqual(editCall.role?.id || editCall.role, staffRoleId,
    'lockdown edit must target @everyone, not the staff role');

  // Staff overwrite still present in cache
  assert.ok(ch.permissionOverwrites.cache.has(staffRoleId),
    'staff role overwrite must still exist after lockdown');
});

test('PP-5: Member-specific overwrites are not touched during lockdown', async () => {
  const guildId = nextId();
  const { guild, editLogs } = buildMockGuild(guildId, [{ id: 'ch_vip', denyBits: 0n }]);

  const vipMemberId = `member_vip_${guildId}`;
  const ch = guild.channels.cache.get('ch_vip');
  ch.permissionOverwrites.cache.set(vipMemberId, {
    id:    vipMemberId,
    type:  1, // member overwrite
    allow: { bitfield: F.SendMessages, has: () => true },
    deny:  { bitfield: 0n,             has: () => false },
  });

  await engageEmergencyLockdown(guild, 'Admin');

  // Edit was called once (for @everyone), not for the member overwrite
  assert.equal(editLogs['ch_vip'].length, 1);
  assert.ok(ch.permissionOverwrites.cache.has(vipMemberId),
    'member overwrite must still exist after lockdown');
});

test('PP-6: parentId (category sync) is not changed by lockdown or unlock', async () => {
  const guildId = nextId();
  const catId = `cat_pub_${guildId}`;
  const { guild } = buildMockGuild(
    guildId,
    [{ id: 'ch_synced', parentId: catId, denyBits: 0n }],
    [{ id: catId, denyBits: 0n }],
  );

  await engageEmergencyLockdown(guild, 'Admin');
  const ch = guild.channels.cache.get('ch_synced');
  assert.equal(ch.parentId, catId, 'parentId must not change during lockdown');

  await liftEmergencyLockdown(guild, 'Admin');
  assert.equal(ch.parentId, catId, 'parentId must not change during unlock');
});

test('PP-7: Unlock restores exact full overwrite bitfield including ViewChannel', async () => {
  const guildId = nextId();
  // Simulate a channel that had a rich existing overwrite before lockdown:
  // ViewChannel: allowed, AttachFiles: allowed, SendMessages: allowed (explicitly)
  const originalAllow = F.ViewChannel | F.SendMessages | F.AttachFiles;
  const originalDeny  = 0n;

  const cfg = getGuildConfig(guildId);
  cfg.security = cfg.security || {};
  cfg.security.lockdown = true;
  cfg.security.preLockdownSnapshot = {
    'ch_rich': {
      id:    guildId,
      type:  0,
      allow: originalAllow.toString(),
      deny:  originalDeny.toString(),
    },
  };
  saveGuildConfigAsync(guildId, cfg);

  const setLog = [];
  const guild = {
    id: guildId, name: 'T', ownerId: `o_${guildId}`,
    channels: { cache: new Map([['ch_rich', {
      id: 'ch_rich', name: 'rich',
      permissionOverwrites: {
        cache: new Map([[guildId, mockOW(guildId, originalAllow, originalDeny)]]),
        edit: async () => {},
        set:  async (overwrites, reason) => { setLog.push({ overwrites, reason }); },
        delete: async () => {},
      },
    }]]) },
    roles: { everyone: { id: guildId }, cache: new Map() },
    members: { me: { permissions: { has: () => true } } },
  };

  const res = await liftEmergencyLockdown(guild, 'Admin');
  assert.equal(res.success, true);
  assert.equal(res.unlockedChannels, 1);

  // set() should have been called with the original allow+deny bigints
  assert.equal(setLog.length, 1, 'permissionOverwrites.set() should have been called');
  const restoredOW = setLog[0].overwrites[0];
  assert.equal(BigInt(restoredOW.allow), originalAllow,
    'restored allow bitfield must match original');
  assert.equal(BigInt(restoredOW.deny), originalDeny,
    'restored deny bitfield must match original');
});

test('PP-8: Hidden channel stays hidden through full lockdown → unlock cycle', async () => {
  const guildId = nextId();
  // A visible public channel and a hidden private one
  const { guild, editLogs } = buildMockGuild(guildId, [
    { id: 'ch_pub',     denyBits: 0n },
    { id: 'ch_private', denyBits: F.ViewChannel },
  ]);

  const lockRes = await engageEmergencyLockdown(guild, 'Admin');
  assert.equal(lockRes.success, true);
  assert.equal(lockRes.lockedChannels, 1);

  const liftRes = await liftEmergencyLockdown(guild, 'Admin');
  assert.equal(liftRes.success, true);

  // ch_private must never have been edited at any point
  assert.equal(editLogs['ch_private'].length, 0,
    'hidden channel must not be modified at any point during lockdown + unlock');
});

test('PP-9: Category-hidden channel stays category-hidden after lockdown + unlock', async () => {
  const guildId = nextId();
  const catId = `log_cat_${guildId}`;

  const { guild, editLogs } = buildMockGuild(
    guildId,
    [
      { id: 'ch_general', denyBits: 0n },
      { id: 'ch_seclog',  parentId: catId, noOW: true }, // inherits from category
    ],
    [{ id: catId, denyBits: F.ViewChannel }],
  );

  const lockRes = await engageEmergencyLockdown(guild, 'Admin');
  assert.equal(lockRes.lockedChannels, 1);
  assert.equal(lockRes.skippedChannels, 1);

  const liftRes = await liftEmergencyLockdown(guild, 'Admin');
  assert.equal(liftRes.success, true);

  // ch_seclog must never have been edited
  assert.equal(editLogs['ch_seclog'].length, 0,
    'category-hidden channel must not be edited during lockdown or unlock');

  // The category itself must never have been edited
  const cat = guild.channels.cache.get(catId);
  // categories are in the channelsMap but we didn't add them to the channel iteration
  // The key point: ch_seclog has no @everyone overwrite added to it
  const chSeclog = guild.channels.cache.get('ch_seclog');
  assert.equal(chSeclog.permissionOverwrites.cache.size, 0,
    'category-hidden channel must have no @everyone overwrite after unlock');
});

test('PP-10: Absent snapshot leaves lockdown flag untouched', async () => {
  const guildId = nextId();
  const cfg = getGuildConfig(guildId);
  cfg.security = cfg.security || {};
  cfg.security.lockdown = true;
  cfg.security.preLockdownSnapshot = {};
  delete cfg.security.preLockdownOverwrites;
  saveGuildConfigAsync(guildId, cfg);

  const { guild } = buildMockGuild(guildId, [{ id: 'ch_x' }]);
  const res = await liftEmergencyLockdown(guild, 'Admin');

  assert.equal(res.noSnapshot, true);
  assert.equal(res.success, false);
  const after = getGuildConfig(guildId);
  assert.equal(after.security.lockdown, true,
    'lockdown flag must remain true when snapshot is absent');
});

test('PP-11: Partial failure preserves recovery snapshot for failed channels only', async () => {
  const guildId = nextId();
  const cfg = getGuildConfig(guildId);
  cfg.security = cfg.security || {};
  cfg.security.lockdown = true;
  cfg.security.preLockdownSnapshot = {
    'ch_ok':   { id: guildId, type: 0, allow: '0', deny: '0' },
    'ch_fail': { id: guildId, type: 0, allow: '0', deny: '0' },
  };
  saveGuildConfigAsync(guildId, cfg);

  const { guild } = buildMockGuild(guildId, [
    { id: 'ch_ok',   editShouldThrow: false, deleteShouldThrow: false },
    { id: 'ch_fail', editShouldThrow: true,  deleteShouldThrow: true  },
  ]);

  const res = await liftEmergencyLockdown(guild, 'Admin');
  assert.equal(res.partial, true);

  const after = getGuildConfig(guildId);
  // ch_fail snapshot preserved so admin can retry
  assert.ok(after.security.preLockdownSnapshot['ch_fail'],
    'failed channel snapshot must be preserved for retry');
  // ch_ok snapshot cleared (successfully restored)
  assert.equal(after.security.preLockdownSnapshot['ch_ok'], undefined,
    'successfully restored channel must be removed from snapshot');
  // lastUnlockFailures persisted
  assert.ok(Array.isArray(after.security.lastUnlockFailures));
  assert.equal(after.security.lastUnlockFailures[0].id, 'ch_fail');
});

test('PP-12: isExplicitlyHidden and isCategoryHidden helper accuracy', () => {
  const guildId = nextId();
  const catId   = `cat_${guildId}`;
  const evId    = guildId;

  // Build a mock guild with a category that denies ViewChannel
  // and channels: one explicitly hidden, one category-hidden, one public
  const { guild } = buildMockGuild(
    guildId,
    [
      { id: 'ch_explicit_hidden', denyBits: F.ViewChannel },          // explicit deny
      { id: 'ch_cat_hidden',      parentId: catId, noOW: true },      // inherited
      { id: 'ch_public',          denyBits: 0n },                     // public
    ],
    [{ id: catId, denyBits: F.ViewChannel }],
  );

  const chExplicit = guild.channels.cache.get('ch_explicit_hidden');
  const chCat      = guild.channels.cache.get('ch_cat_hidden');
  const chPublic   = guild.channels.cache.get('ch_public');

  // isExplicitlyHidden
  assert.equal(isExplicitlyHidden(chExplicit, evId), true,  'explicit deny ViewChannel → hidden');
  assert.equal(isExplicitlyHidden(chCat,      evId), false, 'no explicit OW → not explicitly hidden');
  assert.equal(isExplicitlyHidden(chPublic,   evId), false, 'public channel → not hidden');

  // isCategoryHidden
  assert.equal(isCategoryHidden(chCat,      guild, evId), true,  'category denies ViewChannel → hidden');
  assert.equal(isCategoryHidden(chExplicit, guild, evId), false, 'no parentId → not category-hidden');
  assert.equal(isCategoryHidden(chPublic,   guild, evId), false, 'public channel → not category-hidden');

  // isChannelHiddenFromEveryone (union)
  assert.equal(isChannelHiddenFromEveryone(chExplicit, guild, evId), true);
  assert.equal(isChannelHiddenFromEveryone(chCat,      guild, evId), true);
  assert.equal(isChannelHiddenFromEveryone(chPublic,   guild, evId), false);
});

test('LU-15: Lockdown with partial channel permission failure captures failedChannels and partial flag', async () => {
  const guildId = nextId();
  const { guild } = buildMockGuild(guildId, [
    { id: 'ch_good', editShouldThrow: false },
    { id: 'ch_bad',  editShouldThrow: true },
  ]);

  const res = await engageEmergencyLockdown(guild, 'Admin');
  assert.equal(res.success, true);
  assert.equal(res.partial, true);
  assert.equal(res.lockedChannels, 1);
  assert.equal(res.failedChannels.length, 1);
  assert.equal(res.failedChannels[0].id, 'ch_bad');

  const cfg = getGuildConfig(guildId);
  assert.ok(Array.isArray(cfg.security.lastLockdownFailures));
  assert.equal(cfg.security.lastLockdownFailures[0].id, 'ch_bad');
});

test('LU-16: Unlock preserves unrelated role overwrites on channel during set()', async () => {
  const guildId = nextId();
  const originalAllow = F.ViewChannel | F.SendMessages;
  const staffRoleId = `role_staff_${guildId}`;

  const cfg = getGuildConfig(guildId);
  cfg.security = cfg.security || {};
  cfg.security.lockdown = true;
  cfg.security.preLockdownSnapshot = {
    'ch_test': {
      id: guildId,
      type: 0,
      allow: originalAllow.toString(),
      deny: '0',
    },
  };
  saveGuildConfigAsync(guildId, cfg);

  let setOverwrites = null;
  const owCache = new Map();
  owCache.set(guildId, mockOW(guildId, originalAllow, 0n));
  owCache.set(staffRoleId, {
    id: staffRoleId,
    type: 0,
    allow: { bitfield: F.ViewChannel | F.SendMessages },
    deny: { bitfield: 0n },
  });

  const guild = {
    id: guildId, name: 'T', ownerId: `o_${guildId}`,
    channels: { cache: new Map([['ch_test', {
      id: 'ch_test', name: 'test',
      permissionOverwrites: {
        cache: owCache,
        edit: async () => {},
        set: async (overwrites) => { setOverwrites = overwrites; },
        delete: async () => {},
      },
    }]]) },
    roles: { everyone: { id: guildId }, cache: new Map() },
    members: { me: { permissions: { has: () => true } } },
  };

  const res = await liftEmergencyLockdown(guild, 'Admin');
  assert.equal(res.success, true);
  assert.ok(setOverwrites);
  assert.equal(setOverwrites.length, 2, 'Must contain both @everyone and staff role overwrites');
  const staffOW = setOverwrites.find(o => o.id === staffRoleId);
  assert.ok(staffOW, 'Staff role overwrite must be preserved by set()');
});

test('LU-17: Unlock retry works when previous unlock was partial', async () => {
  const guildId = nextId();
  const cfg = getGuildConfig(guildId);
  cfg.security = cfg.security || {};
  cfg.security.lockdown = true;
  cfg.security.preLockdownSnapshot = {
    'ch_recovered': { id: guildId, type: 0, allow: '0', deny: '0' },
  };
  saveGuildConfigAsync(guildId, cfg);

  const { guild } = buildMockGuild(guildId, [
    { id: 'ch_recovered', editShouldThrow: false, deleteShouldThrow: false },
  ]);

  const res = await liftEmergencyLockdown(guild, 'Admin');
  assert.equal(res.success, true);
  assert.equal(res.unlockedChannels, 1);
  const after = getGuildConfig(guildId);
  assert.equal(after.security.lockdown, false, 'Full success resets lockdown to false');
  assert.equal(Object.keys(after.security.preLockdownSnapshot).length, 0);
});

test('LU-18: Total lockdown failure (all channels fail) returns success: false with clear reason', async () => {
  const guildId = nextId();
  const { guild } = buildMockGuild(guildId, [
    { id: 'ch_bad1', editShouldThrow: true },
    { id: 'ch_bad2', editShouldThrow: true },
  ]);

  const res = await engageEmergencyLockdown(guild, 'Admin');
  assert.equal(res.success, false);
  assert.equal(res.lockedChannels, 0);
  assert.equal(res.failedChannels.length, 2);
  assert.ok(res.reason.includes('Failed to secure any channels'));

  const cfg = getGuildConfig(guildId);
  assert.equal(cfg.security.lockdown, false, 'Lockdown flag must not be set if all channels failed');
});
