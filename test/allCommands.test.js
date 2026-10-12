const test = require('node:test');
const assert = require('node:assert');
const { buildApplicationCommands } = require('../src/commands/commandRegistry');
const { dispatchCommand } = require('../src/commands/commandDispatcher');

function createFullMockInteraction(commandName, subcommandName = null) {
  let replied = false;
  let deferred = false;

  const mockChannel = {
    id: 'chan_general_99',
    name: 'general',
    isTextBased: () => true,
    setRateLimitPerUser: async () => {},
    send: async () => ({ delete: async () => {} }),
    permissionOverwrites: { create: async () => {} },
  };

  const mockMember = {
    id: 'user_admin_1',
    user: { id: 'user_admin_1', tag: 'Admin#0001', username: 'Admin' },
    guild: null,
    moderatable: true,
    kickable: true,
    bannable: true,
    manageable: true,
    permissions: {
      has: () => true,
      toArray: () => ['Administrator', 'ManageGuild', 'ModerateMembers'],
    },
    roles: {
      cache: new Map([['role_admin', { id: 'role_admin', name: 'Admin', position: 10 }]]),
      highest: { position: 10 },
      remove: async () => {},
    },
    timeout: async () => {},
    kick: async () => {},
    setNickname: async () => {},
  };

  const mockGuild = {
    id: 'guild_all_cmd_audit',
    name: 'THOR APEX AUDIT',
    ownerId: 'owner_apex_1',
    memberCount: 500,
    createdTimestamp: Date.now() - 100000000,
    iconURL: () => 'https://cdn.discordapp.com/icons/sample.png',
    bannerURL: () => 'https://cdn.discordapp.com/banners/sample.png',
    channels: {
      cache: new Map([
        ['chan_general_99', mockChannel],
        ['rules_1', { id: 'rules_1', name: 'rules', isTextBased: () => true }],
      ]),
      fetch: async (id) => mockChannel,
    },
    roles: {
      cache: new Map([
        ['role_admin', { id: 'role_admin', name: 'Admin', position: 10 }],
        ['guild_all_cmd_audit', { id: 'guild_all_cmd_audit', name: '@everyone', position: 0 }],
      ]),
      everyone: { id: 'guild_all_cmd_audit' },
    },
    members: {
      cache: new Map([['user_admin_1', mockMember]]),
      fetch: async () => mockMember,
      me: {
        permissions: { has: () => true },
        roles: { highest: { position: 99 } },
      },
    },
    bans: {
      create: async () => {},
      remove: async () => {},
    },
    invites: {
      fetch: async () => new Map(),
    },
  };

  mockMember.guild = mockGuild;

  const interaction = {
    commandName,
    guildId: mockGuild.id,
    guild: mockGuild,
    member: mockMember,
    user: mockMember.user,
    channel: mockChannel,
    isChatInputCommand: () => true,
    options: {
      getSubcommand: () => subcommandName,
      getString: (name) => {
        if (name === 'action') return 'list';
        if (name === 'toggle') return 'on';
        if (name === 'song') return 'lofi hip hop';
        if (name === 'category') return 'automod';
        if (name === 'mode') return 'track';
        if (name === 'duration') return '10m';
        if (name === 'reason') return 'Audit Test';
        if (name === 'color') return '#FF0000';
        if (name === 'message') return 'Goodbye {user}';
        if (name === 'word') return 'testbadword';
        if (name === 'userid') return '123456789';
        return 'test';
      },
      getUser: () => mockMember.user,
      getInteger: (name) => {
        if (name === 'amount') return 10;
        if (name === 'seconds') return 5;
        if (name === 'limit') return 3;
        if (name === 'level') return 50;
        if (name === 'delete_days') return 1;
        return 5;
      },
      getChannel: () => mockChannel,
      getRole: () => ({ id: 'role_admin', name: 'Admin' }),
    },
    get replied() { return replied; },
    get deferred() { return deferred; },
    reply: async () => { replied = true; },
    deferReply: async () => { deferred = true; },
    editReply: async () => { replied = true; },
    followUp: async () => { replied = true; },
  };

  return { interaction, getState: () => ({ replied, deferred }) };
}

const registeredCommands = buildApplicationCommands();

test('Group D: Every single declared command and subcommand executes and acknowledges without timing out', async () => {
  let auditedEndpoints = 0;

  for (const cmd of registeredCommands) {
    const subcommands = (cmd.options || []).filter(o => o.type === 1);

    if (subcommands.length === 0) {
      auditedEndpoints++;
      const { interaction, getState } = createFullMockInteraction(cmd.name, null);
      await dispatchCommand(interaction, {
        client: { ws: { ping: 25 }, user: { tag: 'THOR APEX#0001' }, guilds: { cache: new Map() }, users: { cache: new Map() } },
        getQ: () => ({ queue: [], history: [], isPlaying: false, player: null, currentTrack: null }),
        stopMusicSession: () => {},
      });
      const state = getState();
      assert.ok(
        state.replied || state.deferred,
        `Command /${cmd.name} was not acknowledged (would result in "The application did not respond")`
      );
    } else {
      for (const sub of subcommands) {
        auditedEndpoints++;
        const { interaction, getState } = createFullMockInteraction(cmd.name, sub.name);
        await dispatchCommand(interaction, {
          client: { ws: { ping: 25 }, user: { tag: 'THOR APEX#0001' }, guilds: { cache: new Map() }, users: { cache: new Map() } },
          getQ: () => ({ queue: [], history: [], isPlaying: false, player: null, currentTrack: null }),
          stopMusicSession: () => {},
        });
        const state = getState();
        assert.ok(
          state.replied || state.deferred,
          `Subcommand /${cmd.name} ${sub.name} was not acknowledged (would result in "The application did not respond")`
        );
      }
    }
  }

  assert.strictEqual(auditedEndpoints, 101, 'All 101 command and subcommand endpoints must be audited');
});
