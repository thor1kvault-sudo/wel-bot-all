const test = require('node:test');
const assert = require('node:assert');
const {
  isAutoModWhitelisted,
  applyAutoModPunishment,
  runAutoModDiagnostic,
} = require('../src/automod/autoModEngine');
const { getGuildConfig, saveGuildConfig } = require('../src/config/guildConfig');
const { dispatchCommand } = require('../src/commands/commandDispatcher');

test('Group B.1: AutoMod Whitelist recognizes Server Owner and Admins', () => {
  const fakeGuild = {
    id: 'guild_am_test',
    name: 'AutoMod Test',
    ownerId: 'owner_100',
  };

  const ownerMember = {
    id: 'owner_100',
    guild: fakeGuild,
    user: { bot: false },
    permissions: { has: () => false },
  };

  assert.strictEqual(isAutoModWhitelisted(ownerMember), true, 'Owner must be whitelisted');

  const adminMember = {
    id: 'admin_200',
    guild: fakeGuild,
    user: { bot: false },
    permissions: { has: () => true },
  };
  assert.strictEqual(isAutoModWhitelisted(adminMember), true, 'Admin must be whitelisted');

  const regularMember = {
    id: 'user_300',
    guild: fakeGuild,
    user: { bot: false },
    permissions: { has: () => false },
    roles: { cache: new Map() },
  };
  assert.strictEqual(isAutoModWhitelisted(regularMember), false, 'Regular member must not be whitelisted');
});

test('Group B.2: AutoMod Timeout punishment respects role hierarchy and permissions', async () => {
  let timeoutCalled = false;
  const fakeGuild = {
    id: 'guild_am_timeout',
    name: 'AM Timeout Guild',
    members: {
      me: { permissions: { has: () => true }, roles: { highest: { position: 10 } } },
    },
  };

  const targetMember = {
    id: 'target_123',
    guild: fakeGuild,
    moderatable: true,
    user: { tag: 'Spammer#0001' },
    timeout: async (duration, reason) => {
      timeoutCalled = true;
    },
  };

  const res = await applyAutoModPunishment(targetMember, 'timeout', 'Spam Flood Test', null, 'antiSpam');
  assert.strictEqual(res.executed, true);
  assert.strictEqual(timeoutCalled, true);
  assert.ok(res.result.includes('Timed out'));
});

test('Group B.3: AutoMod punishment reports failure honestly when role hierarchy prevents action', async () => {
  const fakeGuild = {
    id: 'guild_am_hierarchy_fail',
    name: 'AM Hierarchy Fail Guild',
    members: {
      me: { permissions: { has: () => true }, roles: { highest: { position: 5 } } },
    },
  };

  const unmoderatableMember = {
    id: 'target_456',
    guild: fakeGuild,
    moderatable: false, // Target has higher role!
    user: { tag: 'HighRoleUser#0001' },
  };

  const res = await applyAutoModPunishment(unmoderatableMember, 'timeout', 'Mention Spam', null, 'antiMentionSpam');
  assert.strictEqual(res.executed, false, 'Must not claim success on hierarchy failure');
  assert.ok(res.result.includes('Failed'), 'Result must state failure');
});

test('Group B.4: /automod config returns full dashboard without timing out', async () => {
  let replied = false;
  let responseEmbed = null;

  const interaction = {
    commandName: 'automod',
    guildId: 'guild_am_config_test',
    guild: {
      id: 'guild_am_config_test',
      name: 'Config Test Server',
    },
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    isChatInputCommand: () => true,
    options: {
      getSubcommand: () => 'config',
    },
    reply: async (p) => {
      replied = true;
      responseEmbed = p.embeds?.[0];
    },
  };

  await dispatchCommand(interaction, {});
  assert.strictEqual(replied, true, 'Interaction must be acknowledged');
  assert.ok(responseEmbed, 'Must reply with embed');
  assert.ok(responseEmbed.data.title.includes('AutoMod Configuration Dashboard'));
});

test('Group B.5: /automod test executes safe diagnostic simulation without punishing members', async () => {
  let deferred = false;
  let edited = false;
  let testEmbed = null;

  const interaction = {
    commandName: 'automod',
    guildId: 'guild_am_diag_test',
    guild: {
      id: 'guild_am_diag_test',
      name: 'Diag Test Server',
      members: {
        me: { permissions: { has: () => true }, roles: { highest: { position: 10 } } },
      },
      channels: { cache: new Map() },
    },
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    isChatInputCommand: () => true,
    options: {
      getSubcommand: () => 'test',
    },
    deferReply: async () => { deferred = true; },
    editReply: async (p) => {
      edited = true;
      testEmbed = p.embeds?.[0];
    },
  };

  await dispatchCommand(interaction, {});
  assert.strictEqual(deferred, true, 'Must defer within deadline');
  assert.strictEqual(edited, true, 'Must editReply with results');
  assert.ok(testEmbed, 'Must supply test diagnostic embed');
  assert.ok(testEmbed.data.title.includes('AutoMod Diagnostic & Simulation Suite'));
  assert.ok(testEmbed.data.description.includes('Safe Simulation Test Results'));
});
