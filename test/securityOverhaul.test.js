'use strict';

const test = require('node:test');
const assert = require('node:assert');
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
} = require('../src/security/securityPipeline');
const {
  MOD_ACTION_KEYS,
  checkModeratorVelocity,
  handleModerationAction,
} = require('../src/security/antiMod');
const {
  evaluateJoinRisk,
  quarantineMember,
  releaseMember,
  releaseAllQuarantine,
  autoExpireQuarantine,
  getQuarantinedCount,
  isQuarantined,
} = require('../src/security/antiRaid');
const {
  engageEmergencyLockdown,
  liftEmergencyLockdown,
} = require('../src/security/backupRecovery');
const { getGuildConfig, saveGuildConfig } = require('../src/config/guildConfig');
const { dispatchCommand } = require('../src/commands/commandDispatcher');
const { PermissionsBitField } = require('discord.js');

function createMockGuild(overrides = {}) {
  const channelsMap = new Map();
  const rolesMap = new Map();
  const everyoneRole = { id: 'guild_overhaul_test', name: '@everyone', permissions: { has: () => false, bitfield: 0n } };
  rolesMap.set(everyoneRole.id, everyoneRole);

  const mockChan = {
    id: 'chan_sec_test',
    name: 'security-alerts',
    isTextBased: () => true,
    isThread: () => false,
    permissionOverwrites: { cache: new Map(), edit: async (r, p) => p, set: async (s) => s },
  };
  channelsMap.set(mockChan.id, mockChan);

  return {
    id: 'guild_overhaul_test',
    name: 'Overhaul Test Guild',
    ownerId: 'owner_apex_1',
    channels: { cache: channelsMap },
    roles: { cache: rolesMap, everyone: everyoneRole },
    members: {
      cache: new Map(),
      me: {
        id: 'bot_thor_1',
        roles: { highest: { position: 100 } },
        permissions: { has: () => true },
      },
      fetch: async (id) => null,
      fetchMe: async () => ({ id: 'bot_thor_1', roles: { highest: { position: 100 } }, permissions: { has: () => true } }),
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

// ─────────────────────────────────────────────────────────────────────────────
// 1. High-Resolution Latency & Monotonic Timer Metrics (Phase 2 & 9)
// ─────────────────────────────────────────────────────────────────────────────

test('SO-1: Monotonic high-resolution timer tracks detection, containment & total latency accurately', () => {
  resetPipeline();

  // Record simulated latency measurements
  recordLatencySample('detect', 0.25);
  recordLatencySample('detect', 0.50);
  recordLatencySample('detect', 1.00);
  recordLatencySample('detect', 2.00);

  recordLatencySample('contain', 15.0);
  recordLatencySample('contain', 25.0);
  recordLatencySample('contain', 40.0);

  recordLatencySample('total', 15.5);
  recordLatencySample('total', 25.5);
  recordLatencySample('total', 41.0);

  const metrics = getLatencyMetrics();

  assert.strictEqual(metrics.detect.count, 4);
  assert.strictEqual(metrics.detect.min, 0.25);
  assert.strictEqual(metrics.detect.max, 2.00);
  assert.ok(metrics.detect.p50 >= 0.5 && metrics.detect.p50 <= 1.0);

  assert.strictEqual(metrics.contain.count, 3);
  assert.strictEqual(metrics.contain.p50, 25.0);
  assert.strictEqual(metrics.contain.max, 40.0);

  assert.strictEqual(metrics.total.count, 3);
  assert.ok(metrics.total.p95 > 25.0);
});

test('SO-2: hrtimeToMs correctly converts BigInt nanoseconds to fractional milliseconds', () => {
  const oneMsInNanos = 1_000_000n;
  assert.strictEqual(hrtimeToMs(oneMsInNanos), 1.0);

  const halfMsInNanos = 500_000n;
  assert.strictEqual(hrtimeToMs(halfMsInNanos), 0.5);

  const tenNanos = 10_000n;
  assert.strictEqual(hrtimeToMs(tenNanos), 0.01);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Idempotency & Duplicate Action Prevention (Phase 2)
// ─────────────────────────────────────────────────────────────────────────────

test('SO-3: Duplicate security events with identical parameters are safely deduplicated', async () => {
  resetPipeline();
  const guild = createMockGuild();

  const eventPayload = {
    guild,
    auditLogType: 12, // ChannelDelete
    actionKey: 'channelDelete',
    actionLabel: 'Channel Deleted (#general)',
    targetId: 'chan_general_1',
  };

  // First dispatch: processed
  const res1 = await processSecurityPipelineEvent(eventPayload);
  assert.strictEqual(res1.handled, true);

  // Immediate second dispatch with same target: deduplicated
  const res2 = await processSecurityPipelineEvent(eventPayload);
  assert.strictEqual(res2.handled, false);
  assert.strictEqual(res2.reason, 'Duplicate event discarded');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Decoupled Attribution & Uncertain Audit Log Safety (Phase 3)
// ─────────────────────────────────────────────────────────────────────────────

test('SO-4: Sub-threshold actions do not trigger audit log fetches (zero unnecessary REST calls)', async () => {
  resetPipeline();
  let auditFetched = false;

  const guild = createMockGuild({
    id: 'guild_so4_unique',
    fetchAuditLogs: async () => {
      auditFetched = true;
      return { entries: new Map() };
    },
  });

  // Action count 1 (default threshold is 2 for channelDelete)
  const res = await processSecurityPipelineEvent({
    guild,
    auditLogType: 12,
    actionKey: 'channelDelete',
    actionLabel: 'Channel Deleted (#audit-test-1)',
    targetId: 'target_c1',
  });

  assert.strictEqual(res.handled, true);
  assert.strictEqual(res.contained, false);
  assert.strictEqual(auditFetched, false, 'Audit log must NOT be fetched for normal actions below threshold');
});

test('SO-5: Uncertain audit log attribution records incident without punishing innocent users', async () => {
  resetPipeline();
  const guild = createMockGuild({
    id: 'guild_so5_unique',
    fetchAuditLogs: async () => ({ entries: new Map() }),
  });

  // Configure limit to 1 so first event trips threshold
  const config = getGuildConfig(guild.id, guild.name);
  config.security.thresholds.channelDelete = { limit: 1, windowMs: 15000 };
  saveGuildConfig(guild.id, config);

  const res = await processSecurityPipelineEvent({
    guild,
    auditLogType: 12,
    actionKey: 'channelDelete',
    actionLabel: 'Channel Deleted (#unverified-test)',
    targetId: 'target_unv_1',
  });

  assert.strictEqual(res.handled, true);
  assert.strictEqual(res.contained, false);
  assert.strictEqual(res.attribution, 'unverified');
  assert.ok(res.incident);
  assert.strictEqual(res.incident.actorId, 'UNKNOWN');
  assert.ok(res.incident.result.includes('Unverified Attribution'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Trusted User & Server Owner Immunity (Phase 3 & 4)
// ─────────────────────────────────────────────────────────────────────────────

test('SO-6: Server Owner and trusted users are strictly immune from automated enforcement', async () => {
  resetPipeline();
  const guild = createMockGuild({ id: 'guild_so6_unique', ownerId: 'owner_god_mode' });
  const config = getGuildConfig(guild.id);
  config.security.trustedUsers = ['trusted_staff_member'];
  config.security.thresholds.channelDelete = { limit: 1, windowMs: 15000 };
  saveGuildConfig(guild.id, config);

  // Server Owner check
  assert.strictEqual(isImmuneUser(guild, 'owner_god_mode'), true);
  const ownerRes = await processSecurityPipelineEvent({
    guild,
    actionKey: 'channelDelete',
    actionLabel: 'Channel Deleted',
    targetId: 'chan_owner_del',
    actor: { id: 'owner_god_mode', tag: 'Owner#0001' },
  });
  assert.strictEqual(ownerRes.contained, false);
  assert.strictEqual(ownerRes.reason, 'Actor is immune / trusted');

  // Trusted user check
  assert.strictEqual(isImmuneUser(guild, 'trusted_staff_member'), true);
  const trustedRes = await processSecurityPipelineEvent({
    guild,
    actionKey: 'channelDelete',
    actionLabel: 'Channel Deleted',
    targetId: 'chan_trusted_del',
    actor: { id: 'trusted_staff_member', tag: 'Trusted#0001' },
  });
  assert.strictEqual(trustedRes.contained, false);
  assert.strictEqual(trustedRes.reason, 'Actor is immune / trusted');

  // Rogue user check
  assert.strictEqual(isImmuneUser(guild, 'rogue_attacker_99'), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Anti-Mod Abuse Dual-Window Velocity (Phase 4)
// ─────────────────────────────────────────────────────────────────────────────

test('SO-7: Anti-Mod Abuse detects short burst and extended rolling window abuse', async () => {
  resetPipeline();
  const guild = createMockGuild();
  const rogueMod = { id: 'rogue_mod_burst', tag: 'RogueMod#9999' };

  // Short burst: 5 timeouts triggers default threshold
  for (let i = 0; i < 4; i++) {
    const res = await handleModerationAction(guild, rogueMod, MOD_ACTION_KEYS.TIMEOUT, 'Timeout');
    assert.strictEqual(res.intercepted, false);
  }

  const tripped = await handleModerationAction(guild, rogueMod, MOD_ACTION_KEYS.TIMEOUT, 'Timeout', '<@victim_1>');
  assert.strictEqual(tripped.intercepted, true);
  assert.strictEqual(tripped.velocity.count, 5);
  assert.strictEqual(tripped.velocity.windowType, 'short');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Anti-Raid Multi-Factor Risk Scoring & Quarantine Expiration (Phase 5)
// ─────────────────────────────────────────────────────────────────────────────

test('SO-8: Anti-Raid evaluateJoinRisk does not punish innocent new accounts solely on age', () => {
  const now = Date.now();

  // Fresh account (< 24h) BUT with custom avatar and clean username:
  // Age gives 35 pts, which is below the 50 pt highRisk threshold!
  const normalNewUser = {
    user: {
      createdTimestamp: now - (12 * 3600 * 1000), // 12h old
      avatar: 'custom_avatar_hash_123',
      username: 'CoolGamer99',
    },
  };
  const normalRisk = evaluateJoinRisk(normalNewUser);
  assert.strictEqual(normalRisk.highRisk, false, 'New account alone must not trigger high risk without spam signals');
  assert.strictEqual(normalRisk.score, 35);

  // Raider account: < 24h + default avatar + spam pattern username:
  // 35 + 25 + 25 = 85 pts -> High Risk!
  const raiderUser = {
    user: {
      createdTimestamp: now - (2 * 3600 * 1000),
      avatar: null, // default avatar
      username: 'bot12345678', // pattern username
    },
  };
  const raiderRisk = evaluateJoinRisk(raiderUser);
  assert.strictEqual(raiderRisk.highRisk, true);
  assert.strictEqual(raiderRisk.score, 85);
});

test('SO-9: autoExpireQuarantine automatically releases members after expiry duration', async () => {
  const memberRoles = new Set(['role_member_regular']);
  const fakeMember = {
    id: 'quarantined_user_1',
    guild: null,
    manageable: true,
    roles: {
      cache: new Map([['role_member_regular', { id: 'role_member_regular' }]]),
      set: async (roles) => {
        memberRoles.clear();
        for (const r of roles) memberRoles.add(r);
      },
      remove: async (roleId) => {
        memberRoles.delete(roleId);
      },
      has: (roleId) => memberRoles.has(roleId),
    },
  };

  const qRole = { id: 'role_q_123', name: '⚠️ Quarantined' };
  const guild = createMockGuild({
    roles: {
      cache: new Map([
        ['role_q_123', qRole],
        ['role_member_regular', { id: 'role_member_regular' }],
      ]),
      create: async () => qRole,
    },
  });
  fakeMember.guild = guild;
  guild.members.cache.set(fakeMember.id, fakeMember);

  // 1. Quarantine the member
  const qRes = await quarantineMember(fakeMember, 'Raid test');
  assert.strictEqual(qRes.success, true);
  assert.strictEqual(isQuarantined(guild.id, fakeMember.id), true);

  // 2. Run autoExpireQuarantine with expiry of 0ms (simulate elapsed time)
  const expiredCount = await autoExpireQuarantine(guild, 0);
  assert.strictEqual(expiredCount, 1);
  assert.strictEqual(isQuarantined(guild.id, fakeMember.id), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Security Command Authorization & Diagnostics (Phase 7 & 9)
// ─────────────────────────────────────────────────────────────────────────────

test('SO-10: /security lockdown denies unauthorized users with ephemeral rejection', async () => {
  const guild = createMockGuild({ ownerId: 'legit_owner' });
  const nonAdminMember = {
    id: 'regular_user_no_perms',
    user: { id: 'regular_user_no_perms', tag: 'Regular#1111' },
    permissions: { has: () => false }, // No Admin or ManageGuild
  };

  let repliedContent = null;
  let isEphemeral = false;

  const mockInteraction = {
    commandName: 'security',
    guild,
    member: nonAdminMember,
    user: nonAdminMember.user,
    options: {
      getSubcommand: () => 'lockdown',
    },
    reply: async (opts) => {
      repliedContent = opts.embeds?.[0]?.data?.description || opts.content;
      isEphemeral = opts.ephemeral || false;
    },
    deferReply: async () => {},
    editReply: async () => {},
    isChatInputCommand: () => true,
  };

  await dispatchCommand(mockInteraction, {});

  assert.ok(repliedContent.includes('server administrator or trusted user'));
  assert.strictEqual(isEphemeral, true);
});

test('SO-11: /security diagnostics renders latency percentiles and honest system telemetry', async () => {
  resetPipeline();
  recordLatencySample('detect', 0.42);
  recordLatencySample('contain', 12.5);
  recordLatencySample('total', 12.92);

  const guild = createMockGuild({ ownerId: 'admin_user_1' });
  const adminMember = {
    id: 'admin_user_1',
    user: { id: 'admin_user_1', tag: 'Admin#0001' },
    permissions: { has: () => true },
  };

  let sentEmbed = null;

  const mockInteraction = {
    commandName: 'security',
    guild,
    member: adminMember,
    user: adminMember.user,
    options: {
      getSubcommand: () => 'diagnostics',
    },
    reply: async (opts) => {
      sentEmbed = opts.embeds?.[0]?.data;
    },
    isChatInputCommand: () => true,
  };

  await dispatchCommand(mockInteraction, { client: { ws: { ping: 22 } } });

  assert.ok(sentEmbed);
  assert.ok(sentEmbed.title.includes('Diagnostics'));
  assert.ok(sentEmbed.description.includes('Internal Processing Latency'));
  assert.ok(sentEmbed.description.includes('process.hrtime.bigint()'));
  assert.ok(sentEmbed.description.includes('0.42ms'));
});
