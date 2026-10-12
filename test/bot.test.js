const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const {
  getDefaultGuildConfig,
  getGuildConfig,
  saveGuildConfig,
  invalidateCache
} = require('../src/config/guildConfig');

const {
  isTrustedUser,
  recordAndCheckThreshold
} = require('../src/security/antiNuke');

const {
  applyPlaceholders,
  buildWelcomeMessage,
  buildGoodbyeMessage
} = require('../src/welcome/welcomeService');

const {
  checkModerationHierarchy
} = require('../src/moderation/modService');

test('1. Multi-Guild Config Isolation', () => {
  invalidateCache();
  const guildA = 'test_guild_111';
  const guildB = 'test_guild_222';

  const cfgA = getGuildConfig(guildA, 'Alpha Server');
  const cfgB = getGuildConfig(guildB, 'Beta Server');

  assert.strictEqual(cfgA.guildName, 'Alpha Server');
  assert.strictEqual(cfgB.guildName, 'Beta Server');

  // Mutate guild A
  cfgA.welcome.channelId = '999888777';
  cfgA.security.lockdown = true;
  saveGuildConfig(guildA, cfgA);

  // Guild B must remain isolated
  const checkB = getGuildConfig(guildB);
  assert.strictEqual(checkB.welcome.channelId, '');
  assert.strictEqual(checkB.security.lockdown, false);

  // Guild A retains its settings
  const checkA = getGuildConfig(guildA);
  assert.strictEqual(checkA.welcome.channelId, '999888777');
  assert.strictEqual(checkA.security.lockdown, true);
});

test('2. Anti-Nuke Sliding Window Rate Tracking', () => {
  const guildId = 'test_guild_nuke';
  const actorId = 'attacker_123';
  const actionKey = 'channelDelete';

  // Threshold: limit 2 in 15000ms
  const r1 = recordAndCheckThreshold(guildId, actorId, actionKey, 2, 15000);
  assert.strictEqual(r1.triggered, false);
  assert.strictEqual(r1.count, 1);

  const r2 = recordAndCheckThreshold(guildId, actorId, actionKey, 2, 15000);
  assert.strictEqual(r2.triggered, true);
  assert.strictEqual(r2.count, 2);
});

test('3. Trusted User Immunity Check', () => {
  const fakeGuild = {
    id: 'guild_trust_test',
    name: 'Trust Test Guild',
    ownerId: 'owner_999',
    client: { user: { id: 'bot_888' } },
    members: { cache: new Map() }
  };

  assert.strictEqual(isTrustedUser(fakeGuild, 'owner_999'), true, 'Owner should always be immune');
  assert.strictEqual(isTrustedUser(fakeGuild, 'bot_888'), true, 'Bot itself should always be immune');
  assert.strictEqual(isTrustedUser(fakeGuild, 'random_123'), false, 'Random user should not be immune');
});

test('4. Welcome Placeholders & Layout Formatting (THOR APEX Restoration)', () => {
  const fakeMember = {
    id: '123456',
    user: { id: '123456', username: 'King', tag: 'King#0001' }
  };
  const fakeGuild = {
    id: 'guild_welcome_demo',
    name: 'THOR APEX ⚡',
    memberCount: 150,
    channels: { cache: new Map() },
    iconURL: () => 'https://cdn.discordapp.com/icons/fake_tx.png',
    bannerURL: () => 'https://cdn.discordapp.com/banners/fake_thor_apex.png'
  };

  const payload = buildWelcomeMessage(fakeMember, fakeGuild);
  assert.strictEqual(payload.content, 'Welcome <@123456> to **THOR APEX ⚡**! 🎉');
  assert.strictEqual(payload.embeds.length, 1);
  const embed = payload.embeds[0];
  assert.strictEqual(embed.data.author.name, 'THOR APEX !');
  assert.strictEqual(embed.data.color, 0xFF0000);
  assert.ok(embed.data.description.includes('**HEY BUDDY!** <@123456>'));
  assert.ok(embed.data.description.includes('**Welcome To THOR APEX !**'));
  assert.ok(embed.data.description.includes('**Get started with below:**'));
  assert.ok(embed.data.description.includes('**Follow The Server Guidelines:**'));
  assert.ok(embed.data.description.includes('**Fun With Us:**'));
  assert.ok(embed.data.description.includes('**Editing Zone:**'));
  assert.ok(embed.data.description.includes('**Gaming Zone:**'));
  assert.ok(embed.data.description.includes('**Join And Chill With Us!:**'));
  assert.ok(embed.data.description.includes('**Thanks For Joining. Hope You Have A\nGreat Time Here!**'));
  assert.strictEqual(embed.data.image.url, 'https://cdn.discordapp.com/banners/fake_thor_apex.png');
  assert.strictEqual(embed.data.thumbnail.url, 'https://cdn.discordapp.com/icons/fake_tx.png');
});

test('5. Moderation Hierarchy Validation', () => {
  const fakeGuild = {
    ownerId: 'owner_1',
    client: { user: { id: 'bot_1' } }
  };

  const executor = {
    id: 'mod_1',
    guild: fakeGuild,
    roles: { highest: { position: 10 } }
  };

  const ownerTarget = {
    id: 'owner_1',
    roles: { highest: { position: 100 } }
  };

  const checkOwner = checkModerationHierarchy(executor, ownerTarget, 'kick');
  assert.strictEqual(checkOwner.allowed, false);
  assert.ok(checkOwner.reason.includes('Server Owner'));

  const selfTarget = {
    id: 'mod_1',
    roles: { highest: { position: 10 } }
  };
  const checkSelf = checkModerationHierarchy(executor, selfTarget, 'ban');
  assert.strictEqual(checkSelf.allowed, false);
  assert.ok(checkSelf.reason.includes('yourself'));

  const higherTarget = {
    id: 'admin_1',
    roles: { highest: { position: 20 } }
  };
  const checkHigher = checkModerationHierarchy(executor, higherTarget, 'timeout');
  assert.strictEqual(checkHigher.allowed, false);
  assert.ok(checkHigher.reason.includes('higher than or equal to yours'));

  const lowerTarget = {
    id: 'user_1',
    roles: { highest: { position: 5 } }
  };
  const checkLower = checkModerationHierarchy(executor, lowerTarget, 'timeout');
  assert.strictEqual(checkLower.allowed, true);
});

test('6. Goodbye Partial Member Safe Handling', () => {
  // Simulating a partial member where member.fetch() is NOT called and member.user is minimal
  const partialMember = {
    id: 'leaving_user_777',
    user: {
      id: 'leaving_user_777',
      username: 'DepartedUser',
      tag: 'DepartedUser#1234',
      displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/777/abc.png'
    }
  };

  const fakeGuild = {
    id: 'guild_leave_test',
    name: 'OBITO HOMIES',
    memberCount: 99,
    iconURL: () => 'https://cdn.discordapp.com/icons/fake.png'
  };

  const goodbyePayload = buildGoodbyeMessage(partialMember, fakeGuild);
  assert.strictEqual(goodbyePayload.embeds.length, 1);
  const embed = goodbyePayload.embeds[0];
  assert.ok(embed.data.description.includes('DepartedUser'));
  assert.ok(embed.data.description.includes('99'));
});

test('7. AutoMod Word Filter Boundary Check', () => {
  const badWords = ['ass', 'fuck'];
  // Word boundary regex check: "class" should not trigger "ass"
  function matchesBadWord(text, list) {
    const lower = text.toLowerCase();
    for (const w of list) {
      const regex = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (regex.test(lower)) return true;
    }
    return false;
  }

  assert.strictEqual(matchesBadWord('Hello class, welcome!', badWords), false, 'Should not match substring');
  assert.strictEqual(matchesBadWord('What an ass move', badWords), true, 'Should match exact word');
  assert.strictEqual(matchesBadWord('Don\'t do this, fuck off', badWords), true, 'Should match bad word');
});

test('8. Invite Link Regex Detection', () => {
  const inviteRegex = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite|dsc\.gg|invite\.gg)\/[a-zA-Z0-9]+/i;

  assert.ok(inviteRegex.test('Join my server: discord.gg/abcdef'));
  assert.ok(inviteRegex.test('https://discord.com/invite/coolserver'));
  assert.ok(inviteRegex.test('Check dsc.gg/coolbot'));
  assert.strictEqual(inviteRegex.test('Check out https://google.com'), false);
});

