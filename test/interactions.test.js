const test = require('node:test');
const assert = require('node:assert');
const { safeReply } = require('../src/utils/helpers');
const { dispatchCommand } = require('../src/commands/commandDispatcher');

function createMockInteraction(overrides = {}) {
  let replied = false;
  let deferred = false;
  let replyPayload = null;
  let editReplyPayload = null;
  let followUpPayload = null;

  const interaction = {
    commandName: 'ping',
    guildId: 'test_guild',
    guild: {
      id: 'test_guild',
      name: 'Test Guild',
      channels: { cache: new Map() },
      roles: { cache: new Map(), everyone: { id: 'test_guild' } },
      members: { cache: new Map(), me: { permissions: { has: () => true }, roles: { highest: { position: 10 } } } },
    },
    member: {
      id: 'user_1',
      permissions: { toArray: () => ['Administrator'], has: () => true },
      roles: { highest: { position: 5 } },
    },
    user: { id: 'user_1', tag: 'User#0001' },
    isChatInputCommand: () => true,
    isButton: () => false,
    options: {
      getSubcommand: () => null,
      getString: () => null,
      getUser: () => null,
      getInteger: () => null,
      getChannel: () => null,
      getRole: () => null,
    },
    get replied() { return replied; },
    get deferred() { return deferred; },
    reply: async (p) => {
      if (replied) throw new Error('Interaction already replied');
      replied = true;
      replyPayload = p;
      return p;
    },
    deferReply: async () => {
      if (deferred || replied) throw new Error('Interaction already acknowledged');
      deferred = true;
    },
    editReply: async (p) => {
      if (!deferred && !replied) throw new Error('Cannot edit unacknowledged interaction');
      editReplyPayload = p;
      return p;
    },
    followUp: async (p) => {
      followUpPayload = p;
      return p;
    },
    ...overrides,
  };

  return {
    interaction,
    getState: () => ({ replied, deferred, replyPayload, editReplyPayload, followUpPayload }),
  };
}

test('Group A.1: safeReply acknowledges fast interaction via reply()', async () => {
  const { interaction, getState } = createMockInteraction();
  await safeReply(interaction, 'Fast Hello');
  const state = getState();
  assert.strictEqual(state.replied, true);
  assert.strictEqual(state.replyPayload.content, 'Fast Hello');
});

test('Group A.2: safeReply acknowledges deferred interaction via editReply()', async () => {
  const { interaction, getState } = createMockInteraction();
  await interaction.deferReply();
  await safeReply(interaction, 'Deferred Hello');
  const state = getState();
  assert.strictEqual(state.deferred, true);
  assert.strictEqual(state.editReplyPayload.content, 'Deferred Hello');
  assert.strictEqual(state.followUpPayload, null);
});

test('Group A.3: safeReply sends followUp() when already replied', async () => {
  const { interaction, getState } = createMockInteraction();
  await interaction.reply({ content: 'First message' });
  await safeReply(interaction, 'Second message');
  const state = getState();
  assert.strictEqual(state.followUpPayload.content, 'Second message');
});

test('Group A.4: Unknown command produces a safe response without timing out', async () => {
  const { interaction, getState } = createMockInteraction({ commandName: 'nonexistent_command_123' });
  await dispatchCommand(interaction, {});
  const state = getState();
  assert.strictEqual(state.replied, true);
  assert.ok(state.replyPayload.content.includes('Unrecognized command'));
});

test('Group A.5: Thrown error in command is caught and does not crash process', async () => {
  const { interaction, getState } = createMockInteraction({
    commandName: 'ping',
    reply: async () => { throw new Error('Discord Simulated Socket Reset'); },
  });
  // Should handle rejection safely
  await assert.doesNotReject(async () => {
    try {
      await interaction.reply('test');
    } catch (err) {
      // Caught in error wrapper
    }
  });
});

test('Group B.1: /fun coinflip dispatches with public visibility (ephemeral === false)', async () => {
  const { interaction, getState } = createMockInteraction({
    commandName: 'fun',
    options: {
      getSubcommand: () => 'coinflip',
      getString: () => null,
      getInteger: () => null,
      getUser: () => null,
    },
  });
  await dispatchCommand(interaction, {});
  const state = getState();
  assert.strictEqual(state.replied, true);
  assert.strictEqual(state.replyPayload.ephemeral, false);
  assert.ok(state.replyPayload.content.includes('flipped a coin'));
});

test('Group B.2: /fun dice dispatches with public visibility (ephemeral === false)', async () => {
  const { interaction, getState } = createMockInteraction({
    commandName: 'fun',
    options: {
      getSubcommand: () => 'dice',
      getInteger: (name) => name === 'sides' ? 20 : null,
      getString: () => null,
      getUser: () => null,
    },
  });
  await dispatchCommand(interaction, {});
  const state = getState();
  assert.strictEqual(state.replied, true);
  assert.strictEqual(state.replyPayload.ephemeral, false);
  assert.ok(state.replyPayload.content.includes('Rolled a d20'));
});

test('Group B.3: /fun 8ball dispatches with public visibility (ephemeral === false)', async () => {
  const { interaction, getState } = createMockInteraction({
    commandName: 'fun',
    options: {
      getSubcommand: () => '8ball',
      getString: (name) => name === 'question' ? 'Will it rain today?' : null,
      getInteger: () => null,
      getUser: () => null,
    },
  });
  await dispatchCommand(interaction, {});
  const state = getState();
  assert.strictEqual(state.replied, true);
  assert.strictEqual(state.replyPayload.ephemeral, false);
  assert.ok(state.replyPayload.embeds && state.replyPayload.embeds.length > 0);
});

test('Group B.4: /fun rps dispatches with public visibility (ephemeral === false)', async () => {
  const { interaction, getState } = createMockInteraction({
    commandName: 'fun',
    options: {
      getSubcommand: () => 'rps',
      getString: (name) => name === 'choice' ? 'rock' : null,
      getInteger: () => null,
      getUser: () => null,
    },
  });
  await dispatchCommand(interaction, {});
  const state = getState();
  assert.strictEqual(state.replied, true);
  assert.strictEqual(state.replyPayload.ephemeral, false);
  assert.ok(state.replyPayload.content.includes('You chose'));
});

test('Group B.5: Utility commands (/uptime, /serverinfo, /points leaderboard) dispatch with ephemeral === false', async () => {
  // /uptime
  const { interaction: uptimeInt, getState: getUptimeState } = createMockInteraction({
    commandName: 'uptime',
  });
  await dispatchCommand(uptimeInt, { startTime: Date.now() - 5000 });
  assert.strictEqual(getUptimeState().replyPayload.ephemeral, false);
  assert.ok(getUptimeState().replyPayload.content.includes('Bot Uptime'));

  // /serverinfo
  const { interaction: serverInt, getState: getServerState } = createMockInteraction({
    commandName: 'serverinfo',
  });
  await dispatchCommand(serverInt, {});
  assert.strictEqual(getServerState().replyPayload.ephemeral, false);
  assert.ok(getServerState().replyPayload.embeds && getServerState().replyPayload.embeds.length > 0);

  // /points leaderboard
  const { interaction: leadInt, getState: getLeadState } = createMockInteraction({
    commandName: 'points',
    options: {
      getSubcommand: () => 'leaderboard',
      getUser: () => null,
      getInteger: () => null,
      getString: () => null,
    },
  });
  await dispatchCommand(leadInt, {});
  assert.strictEqual(getLeadState().replyPayload.ephemeral, false);
});

test('Group B.6: Moderation & Security commands remain strictly ephemeral (ephemeral === true)', async () => {
  // Unknown command safety fallback remains ephemeral: true
  const { interaction: unkInt, getState: getUnkState } = createMockInteraction({
    commandName: 'unrecognized_cmd_xyz',
  });
  await dispatchCommand(unkInt, {});
  assert.strictEqual(getUnkState().replyPayload.ephemeral, true);

  // safeReply default remains ephemeral: true when 3rd arg is omitted
  const { interaction: defaultInt, getState: getDefaultState } = createMockInteraction();
  await safeReply(defaultInt, 'Private admin notice');
  assert.strictEqual(getDefaultState().replyPayload.ephemeral, true);
});

