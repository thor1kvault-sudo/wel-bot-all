/**
 * test/sevenGroupsAnd247.test.js
 * Comprehensive tests for:
 *  1. Seven Canonical Command Groups in exact source registry order
 *  2. Payload validation against Discord API v10 constraints
 *  3. 24/7 Music subsystem: enable, disable, status, setup, reconnects, persistence, authorization
 */

process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert');
const { PermissionsBitField, ChannelType } = require('discord.js');
const { buildApplicationCommands, validateCommandPayload } = require('../src/commands/commandRegistry');
const { dispatchCommand } = require('../src/commands/commandDispatcher');
const musicService = require('../src/music/musicService');
const { getGuildConfig, saveGuildConfig } = require('../src/config/guildConfig');

// ─────────────────────────────────────────────────────────────
// 1. CANONICAL SEVEN-GROUP AUDIT TESTS
// ─────────────────────────────────────────────────────────────

test('SG-1: All seven canonical groups exist in command registry and are strictly ordered', () => {
  const commands = buildApplicationCommands();
  const names = commands.map(c => c.name);

  // Group 1: SECURITY
  assert.strictEqual(names[0], 'security', 'Group 1 must start with /security');

  // Group 2: SONGS
  const songsIdx = names.indexOf('songs');
  assert.ok(songsIdx > 0, '/songs must exist');

  // Group 3: WELCOME
  const welcomeIdx = names.indexOf('welcome');
  assert.ok(welcomeIdx > songsIdx, '/welcome must be ordered after /songs');

  // Group 4: LEFT
  const leftIdx = names.indexOf('left');
  assert.ok(leftIdx > welcomeIdx, '/left must be ordered after /welcome');

  // Group 5: LOGS
  const logsIdx = names.indexOf('logs');
  assert.ok(logsIdx > leftIdx, '/logs must be ordered after /left');

  // Group 6: INV
  const invIdx = names.indexOf('inv');
  assert.ok(invIdx > logsIdx, '/inv must be ordered after /logs');

  // Group 7: GAMES
  const gamesIdx = names.indexOf('games');
  assert.ok(gamesIdx > invIdx, '/games must be ordered after /inv');

  // Verify exact order of canonical group leaders
  assert.ok(0 < songsIdx, 'Order: Security < Songs');
  assert.ok(songsIdx < welcomeIdx, 'Order: Songs < Welcome');
  assert.ok(welcomeIdx < leftIdx, 'Order: Welcome < Left');
  assert.ok(leftIdx < logsIdx, 'Order: Left < Logs');
  assert.ok(logsIdx < invIdx, 'Order: Logs < Inv');
  assert.ok(invIdx < gamesIdx, 'Order: Inv < Games');
});

test('SG-2: Complete command payload passes Discord API v10 validation with 0 errors', () => {
  const commands = buildApplicationCommands();
  const payload = commands.map(c => (typeof c.toJSON === 'function' ? c.toJSON() : c));

  assert.ok(payload.length <= 100, `Payload command count (${payload.length}) must be <= 100`);

  const result = validateCommandPayload(payload);
  assert.strictEqual(result.valid, true, `Payload validation failed with errors: ${result.errors.join(', ')}`);
  assert.strictEqual(result.errors.length, 0);
});

test('SG-3: /security maintains all canonical subcommands and groups (lockdown & unlock nested)', () => {
  const commands = buildApplicationCommands();
  const sec = commands.find(c => c.name === 'security');
  assert.ok(sec, '/security must exist');

  const options = (typeof sec.toJSON === 'function' ? sec.toJSON() : sec).options;
  const subNames = options.map(o => o.name);

  // Root subcommands
  assert.ok(subNames.includes('lockdown'), '/security must include lockdown subcommand');
  assert.ok(subNames.includes('unlock'), '/security must include unlock subcommand');
  assert.ok(subNames.includes('status'), '/security must include status subcommand');
  assert.ok(subNames.includes('diagnostics'), '/security must include diagnostics subcommand');
  assert.ok(subNames.includes('incidents'), '/security must include incidents subcommand');
  assert.ok(subNames.includes('audit'), '/security must include audit subcommand');
  assert.ok(subNames.includes('test'), '/security must include test subcommand');

  // Subcommand groups
  assert.ok(subNames.includes('antinuke'), '/security must include antinuke group');
  assert.ok(subNames.includes('antimod'), '/security must include antimod group');
  assert.ok(subNames.includes('antiraid'), '/security must include antiraid group');
  assert.ok(subNames.includes('trust'), '/security must include trust group');
  assert.ok(subNames.includes('config'), '/security must include config group');
});

test('SG-4: /songs contains 24-7 group with enable, disable, status, setup subcommands', () => {
  const commands = buildApplicationCommands();
  const songs = commands.find(c => c.name === 'songs');
  assert.ok(songs, '/songs must exist');

  const payload = typeof songs.toJSON === 'function' ? songs.toJSON() : songs;
  const group247 = payload.options.find(o => o.name === '24-7');
  assert.ok(group247, '/songs must contain subcommand group 24-7');
  assert.strictEqual(group247.type, 2, '24-7 must be a subcommand group (type 2)');

  const subNames = group247.options.map(s => s.name);
  assert.ok(subNames.includes('enable'), '24-7 group must include enable');
  assert.ok(subNames.includes('disable'), '24-7 group must include disable');
  assert.ok(subNames.includes('status'), '24-7 group must include status');
  assert.ok(subNames.includes('setup'), '24-7 group must include setup');
});

// ─────────────────────────────────────────────────────────────
// 2. 24/7 MUSIC SUBSYSTEM & ROUTING TESTS
// ─────────────────────────────────────────────────────────────

function createMockGuild(guildId = 'guild_247_test', ownerId = 'owner_1') {
  const mockVc = {
    id: 'vc_persistent_101',
    name: '24/7 Lounge',
    type: ChannelType.GuildVoice,
    permissionsFor: () => ({
      has: () => true,
    }),
  };

  const guild = {
    id: guildId,
    name: '24/7 Test Guild',
    ownerId,
    channels: {
      cache: new Map([['vc_persistent_101', mockVc]]),
      fetch: async (id) => (id === 'vc_persistent_101' ? mockVc : null),
    },
    members: {
      me: {
        id: 'bot_id',
        permissions: { has: () => true },
      },
    },
    voiceAdapterCreator: () => ({
      sendPayload: () => {},
      destroy: () => {},
    }),
  };

  return { guild, mockVc };
}

test('24-7: enable persists configuration and updates session state', async () => {
  const { guild, mockVc } = createMockGuild('guild_enable_persist');
  const res = await musicService.enable247(guild, mockVc);

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.channel.id, 'vc_persistent_101');

  // Verify persistence in guildConfig
  const saved = getGuildConfig(guild.id);
  assert.strictEqual(saved.music247.enabled, true);
  assert.strictEqual(saved.music247.channelId, 'vc_persistent_101');

  // Verify session state
  const session = musicService.getSession(guild.id);
  assert.strictEqual(session.is247, true);
  assert.strictEqual(session.isPlaying, false, 'Must remain silent on standby');

  musicService.destroySession(guild.id, true);
});

test('24-7: disable restores normal disconnect behavior and updates config', async () => {
  const { guild, mockVc } = createMockGuild('guild_disable_persist');
  await musicService.enable247(guild, mockVc);

  const res = await musicService.disable247(guild.id);
  assert.strictEqual(res.success, true);

  const saved = getGuildConfig(guild.id);
  assert.strictEqual(saved.music247.enabled, false);

  const session = musicService.sessions.get(guild.id);
  assert.strictEqual(session?.is247 || false, false);
});

test('24-7: setup designates target voice channel without starting random playback', async () => {
  const { guild, mockVc } = createMockGuild('guild_setup_test');
  const res = musicService.setup247(guild, mockVc);

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.channel.id, 'vc_persistent_101');

  const saved = getGuildConfig(guild.id);
  assert.strictEqual(saved.music247.channelId, 'vc_persistent_101');
});

test('24-7: status returns comprehensive telemetry and connection health', async () => {
  const { guild, mockVc } = createMockGuild('guild_status_telemetry');
  await musicService.enable247(guild, mockVc);

  const status = musicService.get247Status(guild.id, guild);
  assert.strictEqual(status.enabled, true);
  assert.strictEqual(status.channelId, 'vc_persistent_101');
  assert.strictEqual(status.channelName, '24/7 Lounge');
  assert.strictEqual(typeof status.isConnected, 'boolean');
  assert.strictEqual(typeof status.status, 'string');
  assert.strictEqual(typeof status.stateLabel, 'string');
  assert.ok(['Disabled', 'Connecting', 'Connected and ready', 'Reconnecting', 'Failed'].includes(status.stateLabel));
  assert.strictEqual(status.isPlaying, false);

  musicService.destroySession(guild.id, true);
});

test('24-7: Slash commands reject unauthorized non-admin users with ephemeral reply', async () => {
  const { guild, mockVc } = createMockGuild('guild_unauth_test', 'actual_owner_id');

  const nonAdminMember = {
    id: 'user_regular_99',
    user: { id: 'user_regular_99', tag: 'Regular#9999' },
    permissions: {
      has: () => false, // Deny ManageGuild and Administrator
    },
    voice: { channel: mockVc },
  };

  let replyContent = '';
  let replyEphemeral = false;

  const interaction = {
    commandName: 'songs',
    guild,
    member: nonAdminMember,
    user: nonAdminMember.user,
    channel: { id: 'text_chan_1', send: async () => {} },
    options: {
      getSubcommandGroup: () => '24-7',
      getSubcommand: () => 'enable',
      getChannel: () => mockVc,
    },
    reply: async (opts) => {
      replyContent = opts.content || '';
      replyEphemeral = opts.ephemeral || false;
    },
    deferReply: async () => {},
    editReply: async () => {},
    isChatInputCommand: () => true,
  };

  await dispatchCommand(interaction, { client: { ws: { ping: 20 } } });

  assert.ok(replyContent.includes('Only server administrators or members with `Manage Server` permission'));
  assert.strictEqual(replyEphemeral, true);
});

test('24-7: Reconnection handles missing channels safely without infinite loops', async () => {
  const guild = {
    id: 'guild_missing_vc',
    name: 'Missing VC Guild',
    channels: {
      cache: new Map(),
      fetch: async () => null, // Channel deleted
    },
  };

  const session = musicService.getSession(guild.id);
  session.is247 = true;
  session.voiceChannel = { id: 'nonexistent_vc_id' };

  // Trigger reconnect logic
  musicService.handle247Reconnect(guild, session.voiceChannel);
  assert.ok(session.reconnectAttempts >= 1);
  assert.ok(session.reconnectAttempts <= session.maxReconnectAttempts);

  // Clear timeout and cleanup
  if (session.reconnectTimeout) clearTimeout(session.reconnectTimeout);
  musicService.destroySession(guild.id, true);
});

test('24-7: Multi-guild isolation preserves individual 24/7 configs independently', async () => {
  const { guild: gA, mockVc: vcA } = createMockGuild('guild_iso_A');
  const { guild: gB, mockVc: vcB } = createMockGuild('guild_iso_B');

  await musicService.enable247(gA, vcA);
  await musicService.disable247(gB.id);

  const statusA = musicService.get247Status(gA.id, gA);
  const statusB = musicService.get247Status(gB.id, gB);

  assert.strictEqual(statusA.enabled, true);
  assert.strictEqual(statusB.enabled, false);

  musicService.destroySession(gA.id, true);
  musicService.destroySession(gB.id, true);
});
