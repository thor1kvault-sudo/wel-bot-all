/**
 * Benchmark Suite for THOR APEX Slash Commands
 * Measures internal processing time (p50, p95, p99) before and after optimizations.
 */

const { performance } = require('node:perf_hooks');
const { dispatchCommand } = require('../src/commands/commandDispatcher');
const { getGuildConfig } = require('../src/config/guildConfig');
const { PermissionsBitField } = require('discord.js');

function createMockInteraction(commandName, subGroup = null, subCmd = null, options = {}) {
  const replies = [];
  return {
    commandName,
    guild: {
      id: 'bench_guild_100',
      name: 'Benchmark Server',
      ownerId: 'owner_123',
      members: {
        me: {
          permissions: new PermissionsBitField(PermissionsBitField.Flags.Administrator),
        },
      },
      channels: {
        cache: new Map([
          ['chan_1', { id: 'chan_1', name: 'general', isTextBased: () => true }],
        ]),
      },
    },
    member: {
      id: 'owner_123',
      user: { id: 'owner_123', tag: 'Owner#0001' },
      permissions: new PermissionsBitField(PermissionsBitField.Flags.Administrator),
      voice: { channel: null },
    },
    user: { id: 'owner_123', tag: 'Owner#0001' },
    channel: { id: 'chan_1', send: async () => {} },
    options: {
      getSubcommandGroup: () => subGroup,
      getSubcommand: () => subCmd,
      getString: (key) => options[key] || null,
      getInteger: (key) => options[key] || null,
      getBoolean: (key) => options[key] || null,
      getUser: (key) => options[key] || null,
      getChannel: (key) => options[key] || null,
    },
    replied: false,
    deferred: false,
    reply: async (payload) => {
      replies.push(payload);
      return payload;
    },
    deferReply: async () => {},
    editReply: async (payload) => {
      replies.push(payload);
      return payload;
    },
    isChatInputCommand: () => true,
  };
}

function calcPercentiles(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const n = sorted.length;
  const p50 = sorted[Math.floor(n * 0.50)];
  const p95 = sorted[Math.floor(n * 0.95)];
  const p99 = sorted[Math.floor(n * 0.99)];
  const min = sorted[0];
  const max = sorted[n - 1];
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  return { min, p50, p95, p99, max, mean, count: n };
}

async function runBenchmark(iterations = 200) {
  const context = {
    client: { ws: { ping: 15 } },
    startTime: Date.now() - 3600000,
    getQ: () => null,
    RADIO_STREAMS: { lofi: { name: 'Lofi', url: 'http://stream' } },
  };

  // Warm up
  for (let i = 0; i < 20; i++) {
    await dispatchCommand(createMockInteraction('ping'), context);
  }

  const targets = [
    { name: '/ping', fn: () => createMockInteraction('ping') },
    { name: '/uptime', fn: () => createMockInteraction('uptime') },
    { name: '/help', fn: () => createMockInteraction('help') },
    { name: '/botinfo', fn: () => createMockInteraction('botinfo') },
    { name: '/games coinflip', fn: () => createMockInteraction('games', null, 'coinflip') },
    { name: '/inv me', fn: () => createMockInteraction('inv', null, 'me') },
    { name: '/welcome config', fn: () => createMockInteraction('welcome', null, 'config') },
    { name: '/left config', fn: () => createMockInteraction('left', null, 'config') },
    { name: '/security status', fn: () => createMockInteraction('security', null, 'status') },
    { name: '/songs 24-7 status', fn: () => createMockInteraction('songs', '24-7', 'status') },
  ];

  const results = {};

  for (const t of targets) {
    const latencies = [];
    for (let i = 0; i < iterations; i++) {
      const interaction = t.fn();
      const start = performance.now();
      await dispatchCommand(interaction, context);
      const end = performance.now();
      latencies.push(end - start);
    }
    results[t.name] = calcPercentiles(latencies);
  }

  console.log('========================================================================================');
  console.log('BENCHMARK RESULTS (Internal Processing Latency in Milliseconds)');
  console.log('Command                | Samples | Mean (ms) | Min (ms) | p50 (ms) | p95 (ms) | p99 (ms)');
  console.log('-----------------------+---------+-----------+----------+----------+----------+---------');
  for (const [cmd, stats] of Object.entries(results)) {
    console.log(
      `${cmd.padEnd(22)} | ${String(stats.count).padStart(7)} | ${stats.mean.toFixed(3).padStart(9)} | ${stats.min.toFixed(3).padStart(8)} | ${stats.p50.toFixed(3).padStart(8)} | ${stats.p95.toFixed(3).padStart(8)} | ${stats.p99.toFixed(3).padStart(8)}`
    );
  }
  console.log('========================================================================================');
  return results;
}

if (require.main === module) {
  runBenchmark();
}

module.exports = { runBenchmark, calcPercentiles };
