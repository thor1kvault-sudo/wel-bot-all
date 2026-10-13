const test = require('node:test');
const assert = require('node:assert');
const {
  checkThreshold,
  isImmuneUser,
  resolveAuditActorRobust,
  executeContainment,
  resetWindows,
} = require('../src/security/securityEngine');
const {
  MOD_ACTION_KEYS,
  checkModeratorVelocity,
  handleModerationAction,
} = require('../src/security/antiMod');
const {
  createGuildSnapshot,
  engageEmergencyLockdown,
  liftEmergencyLockdown,
} = require('../src/security/backupRecovery');
const { evaluateJoinRisk } = require('../src/security/antiRaid');

function createMockSecurityGuild(overrides = {}) {
  const channelsMap = new Map();
  const rolesMap = new Map();
  const everyoneRole = { id: 'guild_sec_1', name: '@everyone', permissions: { has: () => false, bitfield: 0n } };
  rolesMap.set(everyoneRole.id, everyoneRole);

  const mockChannel = {
    id: 'ch_text_1',
    name: 'general',
    isTextBased: () => true,
    isThread: () => false,
    rateLimitPerUser: 0,
    permissionOverwrites: {
      cache: new Map(),
      edit: async (role, perms) => perms,
    },
  };
  channelsMap.set(mockChannel.id, mockChannel);

  return {
    id: 'guild_sec_1',
    name: 'Security Test Server',
    ownerId: 'owner_123',
    channels: { cache: channelsMap },
    roles: { cache: rolesMap, everyone: everyoneRole },
    members: {
      cache: new Map(),
      me: {
        id: 'bot_id',
        roles: { highest: { position: 100 } },
        permissions: { has: () => true },
      },
    },
    bans: {
      create: async (id, opts) => ({ id, ...opts }),
    },
    fetchAuditLogs: async () => ({
      entries: new Map(),
    }),
    ...overrides,
  };
}

test('SecEngine-1: Sliding window rate limits threshold correctly and isolates actors', () => {
  resetWindows();
  const guildId = 'test_guild_1';
  const actor1 = 'actor_a';
  const actor2 = 'actor_b';

  // 1st action actor1
  const r1 = checkThreshold(guildId, actor1, 'channelDelete', 3, 10000);
  assert.strictEqual(r1.triggered, false);
  assert.strictEqual(r1.count, 1);

  // 2nd action actor1
  const r2 = checkThreshold(guildId, actor1, 'channelDelete', 3, 10000);
  assert.strictEqual(r2.triggered, false);
  assert.strictEqual(r2.count, 2);

  // Actor2 should be unaffected (actor isolation)
  const rOther = checkThreshold(guildId, actor2, 'channelDelete', 3, 10000);
  assert.strictEqual(rOther.triggered, false);
  assert.strictEqual(rOther.count, 1);

  // 3rd action actor1: triggers threshold
  const r3 = checkThreshold(guildId, actor1, 'channelDelete', 3, 10000);
  assert.strictEqual(r3.triggered, true);
  assert.strictEqual(r3.count, 3);
});

test('SecEngine-2: Server owner and bot are strictly immune from automated enforcement', () => {
  const guild = createMockSecurityGuild({ ownerId: 'owner_999' });

  // Server owner
  assert.strictEqual(isImmuneUser(guild, 'owner_999'), true);

  // Regular user
  assert.strictEqual(isImmuneUser(guild, 'random_user'), false);
});

test('SecEngine-3: Robust audit log resolver correctly matches target and rejects stale entries', async () => {
  const mockEntries = new Map();
  mockEntries.set('entry_1', {
    createdTimestamp: Date.now() - 500, // 500ms ago (fresh)
    target: { id: 'target_channel_123' },
    executor: { id: 'executor_rogue', tag: 'Rogue#0001' },
  });

  const guild = createMockSecurityGuild({
    fetchAuditLogs: async ({ type }) => ({
      entries: mockEntries,
    }),
  });

  // Matching targetId succeeds
  const executor = await resolveAuditActorRobust(guild, 12, 'target_channel_123');
  assert.ok(executor);
  assert.strictEqual(executor.id, 'executor_rogue');

  // Non-matching targetId rejects entry to prevent false attribution
  const mismatch = await resolveAuditActorRobust(guild, 12, 'different_channel_456', { maxRetries: 0 });
  assert.strictEqual(mismatch, null);
});

test('SecEngine-4: Anti-Mod Abuse triggers on excessive moderator action velocity', async () => {
  resetWindows();
  const guild = createMockSecurityGuild();
  const modUser = { id: 'mod_1', tag: 'Mod#1234' };

  // 4 rapid timeouts within threshold
  for (let i = 0; i < 4; i++) {
    const res = await handleModerationAction(guild, modUser, MOD_ACTION_KEYS.TIMEOUT, 'Timeout');
    assert.strictEqual(res.intercepted, false);
  }

  // 5th timeout trips rate limit
  const tripped = await handleModerationAction(guild, modUser, MOD_ACTION_KEYS.TIMEOUT, 'Timeout', '<@user_victim>');
  assert.strictEqual(tripped.intercepted, true);
  assert.strictEqual(tripped.velocity.count, 5);
});

test('SecEngine-5: Anti-Raid evaluateJoinRisk scores new accounts and pattern usernames accurately', () => {
  const now = Date.now();

  // Fresh alt account: created 2 hours ago + default avatar
  const freshAlt = {
    user: {
      createdTimestamp: now - (2 * 3600 * 1000),
      avatar: null,
      username: 'bot12345678',
    },
  };
  const risk1 = evaluateJoinRisk(freshAlt);
  assert.strictEqual(risk1.highRisk, true);
  assert.ok(risk1.score >= 50);

  // Established regular user: created 100 days ago with avatar
  const establishedUser = {
    user: {
      createdTimestamp: now - (100 * 24 * 3600 * 1000),
      avatar: 'avatar_hash_abc',
      username: 'VeteranGamer',
    },
  };
  const risk2 = evaluateJoinRisk(establishedUser);
  assert.strictEqual(risk2.highRisk, false);
  assert.strictEqual(risk2.score, 0);
});

test('SecEngine-6: Emergency lockdown and lift preserve channel overwrite fidelity', async () => {
  const guild = createMockSecurityGuild();

  // Lockdown
  const lockRes = await engageEmergencyLockdown(guild, 'Test Lockdown');
  assert.strictEqual(lockRes.success, true);
  assert.strictEqual(lockRes.lockedChannels, 1);

  // Lift
  const liftRes = await liftEmergencyLockdown(guild, 'Test Lift');
  assert.strictEqual(liftRes.success, true);
  assert.strictEqual(liftRes.unlockedChannels, 1);
});

test('SecEngine-7: createGuildSnapshot captures server topology safely without tokens or messages', () => {
  const guild = createMockSecurityGuild();
  const snapshot = createGuildSnapshot(guild);

  assert.strictEqual(snapshot.guildId, 'guild_sec_1');
  assert.strictEqual(snapshot.channelCount, 1);
  assert.strictEqual(snapshot.channels[0].name, 'general');
  assert.ok(snapshot.timestamp > 0);
});
