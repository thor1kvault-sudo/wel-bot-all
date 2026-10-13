const test = require('node:test');
const assert = require('node:assert');
const { ChannelType, PermissionsBitField, EmbedBuilder } = require('discord.js');
const {
  setupAllLogChannels,
  resolveLogChannel,
  logDrag,
  LOG_CATEGORIES,
} = require('../src/logging/loggerService');
const { getGuildConfig } = require('../src/config/guildConfig');

function createMockLoggingGuild(overrides = {}) {
  const channelsMap = new Map();
  const createdChannels = [];
  const everyoneRole = { id: 'guild_log_1', name: '@everyone', permissions: { has: () => false } };

  const guild = {
    id: 'guild_log_1',
    name: 'Logging Test Guild',
    channels: {
      cache: channelsMap,
      create: async (data) => {
        const id = `ch_${data.name.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
        const ch = {
          id,
          name: data.name,
          type: data.type,
          parentId: data.parent || null,
          topic: data.topic || '',
          isTextBased: () => data.type !== ChannelType.GuildCategory,
          permissionsFor: () => ({
            has: (perm) => true,
          }),
          manageable: true,
          setParent: async (pId) => { ch.parentId = pId; },
          send: async (payload) => {
            ch.sentMessages = ch.sentMessages || [];
            ch.sentMessages.push(payload);
            return { id: 'msg_1', ...payload };
          },
        };
        channelsMap.set(id, ch);
        createdChannels.push(ch);
        return ch;
      },
      fetch: async (id) => channelsMap.get(id) || null,
    },
    members: {
      me: {
        id: 'bot_id',
        permissions: {
          has: (perm) => true,
        },
      },
    },
    roles: {
      everyone: everyoneRole,
    },
    ...overrides,
  };

  return { guild, channelsMap, createdChannels };
}

test('DragLogs-1: setupAllLogChannels creates category "SERVER LOGS" and includes drag-logs in 15 channels', async () => {
  const { guild, channelsMap, createdChannels } = createMockLoggingGuild();

  const res = await setupAllLogChannels(guild);
  assert.strictEqual(res.success, true);

  // Category must exist
  const cat = [...channelsMap.values()].find(c => c.type === ChannelType.GuildCategory);
  assert.ok(cat, 'SERVER LOGS category must be created');
  assert.ok(/SERVER LOGS/i.test(cat.name));

  // #drag-logs must exist under that category
  const dragChannel = [...channelsMap.values()].find(c => c.name === 'drag-logs');
  assert.ok(dragChannel, '#drag-logs channel must be created');
  assert.strictEqual(dragChannel.parentId, cat.id);

  // Verify total log channels created includes all 15 defined in LOG_CATEGORIES
  assert.strictEqual(LOG_CATEGORIES.length, 15);
  const dragDef = LOG_CATEGORIES.find(c => c.key === 'drag');
  assert.ok(dragDef);
  assert.strictEqual(dragDef.name, 'drag-logs');
});

test('DragLogs-2: setupAllLogChannels is idempotent and reuses existing #drag-logs channel without duplicating', async () => {
  const { guild, channelsMap } = createMockLoggingGuild();

  // First run
  await setupAllLogChannels(guild);
  const countBefore = channelsMap.size;

  // Second run
  const res2 = await setupAllLogChannels(guild);
  assert.strictEqual(res2.success, true);
  const countAfter = channelsMap.size;

  assert.strictEqual(countBefore, countAfter, 'Must not duplicate category or channels');
});

test('DragLogs-3: resolveLogChannel correctly resolves configured or named drag-logs channel', async () => {
  const { guild, channelsMap } = createMockLoggingGuild();
  await setupAllLogChannels(guild);

  const resolved = await resolveLogChannel(guild, 'drag');
  assert.ok(resolved);
  assert.strictEqual(resolved.name, 'drag-logs');
});

test('DragLogs-4: logDrag sends formatted embed to resolved #drag-logs channel gracefully', async () => {
  const { guild, channelsMap } = createMockLoggingGuild();
  await setupAllLogChannels(guild);

  const dragChannel = [...channelsMap.values()].find(c => c.name === 'drag-logs');
  const embed = new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle('🎯 Member Dragged / Moved')
    .setDescription('**Member:** TestUser#0001\n**From:** <#vc_1>\n**To:** <#vc_2>\n**Responsible Moderator:** Staff#9999');

  logDrag(guild, embed);

  // Wait for queue dispatch loop (micro-task / timer)
  await new Promise(r => setTimeout(r, 100));

  assert.ok(dragChannel.sentMessages && dragChannel.sentMessages.length > 0);
  const sentEmbed = dragChannel.sentMessages.find(m => m.embeds?.[0]?.data?.title === '🎯 Member Dragged / Moved');
  assert.ok(sentEmbed, 'Sent messages must contain the drag log embed');
});

test('DragLogs-5: logDrag handles missing log channel and permission denial without throwing', async () => {
  // Guild without channels or send permissions
  const { guild } = createMockLoggingGuild({
    channels: {
      cache: new Map(),
      fetch: async () => null,
    },
    members: {
      me: {
        permissions: { has: () => false },
      },
    },
  });

  const embed = new EmbedBuilder().setTitle('Test Missing Channel');
  // Should not throw or crash
  assert.doesNotThrow(() => {
    logDrag(guild, embed);
  });
});
