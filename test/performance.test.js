'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField } = require('discord.js');
const { dispatchCommand } = require('../src/commands/commandDispatcher');
const { recordCommandExecution, getPerformanceReport, getCommandStats } = require('../src/utils/perfMonitor');
const { buildApplicationCommands } = require('../src/commands/commandRegistry');

function createMockInteraction(commandName, options = {}, overrides = {}) {
  const replies = [];
  return {
    commandName,
    guild: {
      id: 'perf_test_guild_1',
      name: 'Performance Test Server',
      ownerId: 'perf_owner_123',
      members: { cache: new Map() },
      roles: { cache: new Map() },
      channels: { cache: new Map() },
    },
    user: { id: overrides.userId || 'perf_owner_123', tag: 'PerfTester#0001' },
    member: {
      permissions: {
        has: (perm) => overrides.isAdmin !== undefined ? overrides.isAdmin : true,
      },
      roles: { cache: new Map() },
    },
    options: {
      getString: (n) => options[n] ?? null,
      getSubcommand: () => options.subcommand ?? null,
      getUser: (n) => options[n] ?? null,
    },
    reply: async (payload) => {
      replies.push(payload);
      return payload;
    },
    editReply: async (payload) => {
      replies.push(payload);
      return payload;
    },
    deferReply: async (payload) => {
      replies.push({ deferred: true, ...payload });
      return payload;
    },
    _replies: replies,
  };
}

test('PERF-1: /performance slash command exists in canonical command registry', () => {
  const commands = buildApplicationCommands();
  const perfCmd = commands.find(c => c.name === 'performance');
  assert.ok(perfCmd, 'Expected /performance command in registry');
  assert.strictEqual(perfCmd.name, 'performance');
  assert.strictEqual(commands.length, 100, 'Command registry must remain within Discord 100-command limit');
});

test('PERF-2: perfMonitor ring buffers record executions and compute p50, p95, p99 accurately', () => {
  // Record 100 deterministic latencies: 1ms to 100ms
  for (let i = 1; i <= 100; i++) {
    recordCommandExecution('unit_test_cmd', i, i * 0.5, true);
  }

  const stats = getCommandStats('unit_test_cmd');
  assert.ok(stats);
  assert.strictEqual(stats.count, 100);
  assert.strictEqual(stats.p50, 50);
  assert.strictEqual(stats.p95, 95);
  assert.strictEqual(stats.p99, 99);
});

test('PERF-3: /performance denies unauthorized non-admin users with ephemeral warning', async () => {
  const interaction = createMockInteraction('performance', {}, {
    userId: 'unauthorized_user_999',
    isAdmin: false,
  });

  await dispatchCommand(interaction, {
    client: { ws: { ping: 25 }, guilds: { cache: new Map() } },
    startTime: Date.now() - 60000,
  });

  assert.strictEqual(interaction._replies.length, 1);
  const reply = interaction._replies[0];
  assert.strictEqual(reply.ephemeral, true);
  assert.ok(reply.content.includes('restricted to the Server Owner and administrators'));
});

test('PERF-4: /performance outputs honest telemetry distinguishing network vs internal latency', async () => {
  const interaction = createMockInteraction('performance', {}, {
    userId: 'perf_owner_123',
    isAdmin: true,
  });

  await dispatchCommand(interaction, {
    client: { ws: { ping: 32 }, guilds: { cache: new Map() } },
    startTime: Date.now() - 3600000,
  });

  assert.strictEqual(interaction._replies.length, 1);
  const reply = interaction._replies[0];
  assert.strictEqual(reply.ephemeral, true);
  assert.ok(reply.embeds && reply.embeds.length === 1);

  const embed = reply.embeds[0];
  assert.strictEqual(embed.data.title, '⚡ THOR APEX — Real-Time Performance & Telemetry');

  // Check distinction between WebSocket ping and internal processing latency
  const fields = embed.data.fields;
  const netVsInternalField = fields.find(f => f.name.includes('Network vs Internal Latency'));
  assert.ok(netVsInternalField, 'Field distinguishing network and internal latency must be present');
  assert.ok(netVsInternalField.value.includes('Discord WebSocket Ping'));
  assert.ok(netVsInternalField.value.includes('Internal Command p50'));
  assert.ok(netVsInternalField.value.includes('Internal Command p95'));
  assert.ok(netVsInternalField.value.includes('Internal Command p99'));

  // Check event loop delay and memory
  const elField = fields.find(f => f.name.includes('Event Loop & Memory'));
  assert.ok(elField, 'Event Loop & Memory field must be present');
  assert.ok(elField.value.includes('Event Loop Delay (p50)'));
  assert.ok(elField.value.includes('RSS Memory'));
});

test('PERF-5: Master dispatcher wrapper automatically tracks execution time into perfMonitor', async () => {
  const interaction = createMockInteraction('uptime');

  await dispatchCommand(interaction, {
    client: { ws: { ping: 10 } },
    startTime: Date.now() - 100000,
  });

  const report = getPerformanceReport({ ws: { ping: 10 } }, Date.now() - 100000);
  assert.ok(report.commands.totalExecuted >= 1);
  assert.ok(typeof report.commands.globalLatencyMs.p95 === 'number');
});
