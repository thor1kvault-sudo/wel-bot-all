'use strict';

/**
 * THOR APEX — Member Mention Notification DM Test Suite
 *
 * Covers:
 *  - Normal user mention triggers formatted DM
 *  - Multiple mentioned users deliver DMs to all recipients
 *  - Excludes message author (no self-DMs)
 *  - Excludes bot users
 *  - No mention in message produces zero DMs
 *  - Duplicate user mentions in same message deduplicate to 1 DM
 *  - Discord closed DMs (code 50007) and API failures handled gracefully
 *  - Internal rate limiting throttles excessive mention spam
 *  - Feature disabled setting prevents all DMs
 *  - Untrusted text content is safely sanitized (@ mentions escaped)
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  handleMentionNotification,
  sanitizeContent,
  isRateLimited,
  _resetRateLimits,
  MAX_MENTIONS_PER_MESSAGE,
} = require('../src/notifications/mentionNotifier');

function createMockClient() {
  return {
    user: {
      id: 'bot_id_123',
      tag: 'THOR APEX#0001',
      displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/bot.png',
    },
  };
}

function createMockMessage({
  content = 'Hey there!',
  authorId = 'user_author_1',
  authorTag = 'Author#1111',
  guildId = 'guild_mention_test',
  guildName = 'THOR APEX TEST SERVER',
  channelId = 'ch_1',
  channelName = 'general',
  mentionsUsers = [],
} = {}) {
  const usersMap = new Map();
  for (const u of mentionsUsers) {
    usersMap.set(u.id, u);
  }

  return {
    id: 'msg_' + Date.now(),
    content,
    url: `https://discord.com/channels/${guildId}/${channelId}/msg_123`,
    createdAt: new Date(),
    guild: {
      id: guildId,
      name: guildName,
      iconURL: () => 'https://cdn.discordapp.com/icons/guild.png',
    },
    channel: {
      id: channelId,
      name: channelName,
    },
    author: {
      id: authorId,
      username: authorTag.split('#')[0],
      tag: authorTag,
      bot: false,
    },
    mentions: {
      users: usersMap,
    },
  };
}

test('MN-1: sanitizeContent inserts zero-width space after @ to prevent unintended pings in DMs', () => {
  assert.strictEqual(sanitizeContent('Hello @everyone'), 'Hello @\u200beveryone');
  assert.strictEqual(sanitizeContent('@Member check this out'), '@\u200bMember check this out');
  assert.strictEqual(sanitizeContent('Clean text without at-sign'), 'Clean text without at-sign');
  assert.strictEqual(sanitizeContent(''), '');
  assert.strictEqual(sanitizeContent(null), '');
});

test('MN-2: Normal user mention delivers clean DM embed with correct fields', async () => {
  _resetRateLimits();
  const client = createMockClient();
  let dmSent = null;

  const targetUser = {
    id: 'target_u_1',
    username: 'TargetUser',
    tag: 'TargetUser#2222',
    bot: false,
    send: async (payload) => {
      dmSent = payload;
      return true;
    },
  };

  const message = createMockMessage({
    content: '@TargetUser please check this update.',
    mentionsUsers: [targetUser],
  });

  const res = await handleMentionNotification(message, client, {
    customConfig: { mentionDMs: { enabled: true } },
  });

  assert.strictEqual(res.sentCount, 1);
  assert.strictEqual(res.skippedCount, 0);
  assert.strictEqual(res.errors.length, 0);
  assert.ok(dmSent, 'Target user must receive DM payload');
  assert.ok(dmSent.embeds && dmSent.embeds.length === 1);

  const embedData = dmSent.embeds[0].data;
  assert.strictEqual(embedData.title, '⚡ You were mentioned!');
  assert.ok(embedData.description.includes('THOR APEX TEST SERVER'));
  assert.ok(embedData.description.includes('Author'));
  assert.ok(embedData.description.includes('#general'));
  assert.ok(embedData.description.includes('please check this update'));
});

test('MN-3: Multiple mentioned users receive individual notifications', async () => {
  _resetRateLimits();
  const client = createMockClient();
  const sentUsers = [];

  const u1 = {
    id: 'multi_u_1',
    username: 'UserOne',
    bot: false,
    send: async () => { sentUsers.push('multi_u_1'); },
  };
  const u2 = {
    id: 'multi_u_2',
    username: 'UserTwo',
    bot: false,
    send: async () => { sentUsers.push('multi_u_2'); },
  };

  const message = createMockMessage({
    content: 'Pinging @UserOne and @UserTwo for review',
    mentionsUsers: [u1, u2],
  });

  const res = await handleMentionNotification(message, client, {
    customConfig: { mentionDMs: { enabled: true } },
  });

  assert.strictEqual(res.sentCount, 2);
  assert.ok(sentUsers.includes('multi_u_1'));
  assert.ok(sentUsers.includes('multi_u_2'));
});

test('MN-4: Excludes message author (no self-notification DMs)', async () => {
  _resetRateLimits();
  const client = createMockClient();
  let dmAttempted = false;

  const selfAuthor = {
    id: 'self_author_id',
    username: 'SelfAuthor',
    bot: false,
    send: async () => { dmAttempted = true; },
  };

  const message = createMockMessage({
    authorId: 'self_author_id',
    content: 'Pinging myself @SelfAuthor',
    mentionsUsers: [selfAuthor],
  });

  const res = await handleMentionNotification(message, client, {
    customConfig: { mentionDMs: { enabled: true } },
  });

  assert.strictEqual(res.sentCount, 0);
  assert.strictEqual(dmAttempted, false, 'Author must never be sent a self-mention DM');
});

test('MN-5: Excludes bot users and Thor Apex client bot', async () => {
  _resetRateLimits();
  const client = createMockClient();
  let botDmAttempted = false;

  const otherBot = {
    id: 'bot_target_id',
    username: 'MusicBot',
    bot: true,
    send: async () => { botDmAttempted = true; },
  };
  const selfBot = {
    id: client.user.id,
    username: 'THOR APEX',
    bot: true,
    send: async () => { botDmAttempted = true; },
  };

  const message = createMockMessage({
    content: 'Pinging @MusicBot and @THOR APEX',
    mentionsUsers: [otherBot, selfBot],
  });

  const res = await handleMentionNotification(message, client, {
    customConfig: { mentionDMs: { enabled: true } },
  });

  assert.strictEqual(res.sentCount, 0);
  assert.strictEqual(botDmAttempted, false, 'Bots must never receive mention DMs');
});

test('MN-6: No mention in message returns zero sent DMs', async () => {
  _resetRateLimits();
  const client = createMockClient();

  const message = createMockMessage({
    content: 'Ordinary message with no mentions at all.',
    mentionsUsers: [],
  });

  const res = await handleMentionNotification(message, client, {
    customConfig: { mentionDMs: { enabled: true } },
  });

  assert.strictEqual(res.sentCount, 0);
  assert.strictEqual(res.skippedCount, 0);
});

test('MN-7: Duplicate user mention in same message sends only 1 DM', async () => {
  _resetRateLimits();
  const client = createMockClient();
  let sendCount = 0;

  const target = {
    id: 'dup_u_1',
    username: 'DupUser',
    bot: false,
    send: async () => { sendCount++; },
  };

  // Same user referenced multiple times in map
  const message = createMockMessage({
    content: '@DupUser @DupUser @DupUser repeat ping',
    mentionsUsers: [target, target],
  });

  const res = await handleMentionNotification(message, client, {
    customConfig: { mentionDMs: { enabled: true } },
  });

  assert.strictEqual(res.sentCount, 1);
  assert.strictEqual(sendCount, 1, 'Duplicate mention in same message must produce only 1 DM');
});

test('MN-8: Closed DMs (error 50007) and network failures handled gracefully without throwing', async () => {
  _resetRateLimits();
  const client = createMockClient();

  const closedDmUser = {
    id: 'closed_dm_u',
    username: 'PrivateUser',
    bot: false,
    send: async () => {
      const err = new Error('Cannot send messages to this user');
      err.code = 50007;
      throw err;
    },
  };

  const message = createMockMessage({
    content: '@PrivateUser hey check this',
    mentionsUsers: [closedDmUser],
  });

  const res = await handleMentionNotification(message, client, {
    customConfig: { mentionDMs: { enabled: true } },
  });

  assert.strictEqual(res.sentCount, 0);
  assert.strictEqual(res.errors.length, 1);
  assert.ok(res.errors[0].includes('Closed DMs'));
});

test('MN-9: Feature disabled in configuration prevents sending DMs', async () => {
  _resetRateLimits();
  const client = createMockClient();
  let dmAttempted = false;

  const target = {
    id: 'target_disabled_test',
    username: 'Target',
    bot: false,
    send: async () => { dmAttempted = true; },
  };

  const message = createMockMessage({
    content: '@Target ping',
    mentionsUsers: [target],
  });

  // Test mentionDMs.enabled === false
  const res1 = await handleMentionNotification(message, client, {
    customConfig: { mentionDMs: { enabled: false } },
  });
  assert.strictEqual(res1.sentCount, 0);
  assert.strictEqual(dmAttempted, false);

  // Test tagNotify === false (legacy flag)
  const res2 = await handleMentionNotification(message, client, {
    customConfig: { tagNotify: false },
  });
  assert.strictEqual(res2.sentCount, 0);
  assert.strictEqual(dmAttempted, false);
});

test('MN-10: Rate limiting throttles excessive pings to the same recipient', async () => {
  _resetRateLimits();
  const client = createMockClient();
  let sendCount = 0;

  const target = {
    id: 'rate_limited_target',
    username: 'BusyUser',
    bot: false,
    send: async () => { sendCount++; },
  };

  const message = createMockMessage({
    content: '@BusyUser test ping',
    mentionsUsers: [target],
  });

  // Send 3 times (the allowed maximum)
  for (let i = 0; i < 3; i++) {
    await handleMentionNotification(message, client, {
      customConfig: { mentionDMs: { enabled: true } },
    });
  }
  assert.strictEqual(sendCount, 3);

  // 4th attempt should be rate limited
  const res4 = await handleMentionNotification(message, client, {
    customConfig: { mentionDMs: { enabled: true } },
  });
  assert.strictEqual(res4.sentCount, 0);
  assert.strictEqual(res4.skippedCount, 1);
  assert.strictEqual(sendCount, 3, '4th DM must be suppressed by rate limiter');
});

test('MN-11: Mass-mention messages are capped to MAX_MENTIONS_PER_MESSAGE', async () => {
  _resetRateLimits();
  const client = createMockClient();
  const sentUsers = [];

  const targets = Array.from({ length: 6 }, (_, i) => ({
    id: `mass_u_${i}`,
    username: `MassUser${i}`,
    bot: false,
    send: async () => { sentUsers.push(`mass_u_${i}`); },
  }));

  const message = createMockMessage({
    content: 'Mass raid ping to multiple users!',
    mentionsUsers: targets,
  });

  const res = await handleMentionNotification(message, client, {
    customConfig: { mentionDMs: { enabled: true } },
  });

  assert.strictEqual(res.sentCount, MAX_MENTIONS_PER_MESSAGE);
  assert.strictEqual(sentUsers.length, MAX_MENTIONS_PER_MESSAGE);
  assert.strictEqual(res.skippedCount, targets.length - MAX_MENTIONS_PER_MESSAGE);
});
