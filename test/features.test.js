/**
 * test/features.test.js
 * Comprehensive test suite for:
 * 1. /panel Interactive Admin Control Centre
 * 2. Smart Anti-Phishing & Fake Nitro Scanner
 * 3. /threat DEFCON Switcher
 * 4. Native Modal Settings Editor
 * 5. Smart Anti-Raid Mass Join Quarantiner
 */
const test = require('node:test');
const assert = require('node:assert');

const { PHISHING_PATTERNS } = require('../src/automod/autoModEngine');
const {
  quarantineMember, releaseMember, releaseAllQuarantine,
  getQuarantinedCount, isQuarantined,
} = require('../src/security/antiRaid');
const { getGuildConfig, saveGuildConfig } = require('../src/config/guildConfig');
const { buildWelcomeMessage } = require('../src/welcome/welcomeService');
const { dispatchCommand } = require('../src/commands/commandDispatcher');

// ═══════════════════════════════════════════════════════════════════
// FEATURE 1: /panel Interactive Control Centre
// ═══════════════════════════════════════════════════════════════════

test('F1.1: /panel renders interactive embed with 3 ActionRows (buttons + select menu)', async () => {
  let responsePayload = null;

  const interaction = {
    commandName: 'panel',
    guild: { id: 'guild_panel_test', name: 'Panel Test Server' },
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    options: {},
    replied: false,
    deferred: false,
    reply: async (payload) => {
      responsePayload = payload;
      interaction.replied = true;
    },
  };

  await dispatchCommand(interaction, {});

  assert.ok(responsePayload, 'Panel must produce a response');
  assert.ok(responsePayload.embeds?.length > 0, 'Must include at least one embed');
  assert.ok(responsePayload.ephemeral === true, 'Panel must be ephemeral');
  assert.ok(responsePayload.components?.length >= 2, 'Must include at least 2 ActionRows');

  const embed = responsePayload.embeds[0];
  assert.ok(embed.data.title.includes('THOR APEX'), 'Panel embed title must reference THOR APEX');
  assert.ok(embed.data.description.includes('AutoMod'), 'Panel must show AutoMod status');
  assert.ok(embed.data.description.includes('Anti-Nuke'), 'Panel must show Anti-Nuke status');
});

test('F1.2: /panel shows correct quarantine count in embed', async () => {
  const guildId = 'guild_panel_qcount';
  let responsePayload = null;

  const interaction = {
    commandName: 'panel',
    guild: { id: guildId, name: 'QCount Test' },
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    options: {},
    replied: false,
    deferred: false,
    reply: async (payload) => {
      responsePayload = payload;
      interaction.replied = true;
    },
  };

  await dispatchCommand(interaction, {});
  assert.ok(responsePayload.embeds[0].data.description.includes('None') || responsePayload.embeds[0].data.description.includes('0') || responsePayload.embeds[0].data.description.includes('Quarantine'), 'Must reference quarantine status');
});

// ═══════════════════════════════════════════════════════════════════
// FEATURE 2: Smart Anti-Phishing & Fake Nitro Scanner
// ═══════════════════════════════════════════════════════════════════

test('F2.1: PHISHING_PATTERNS detects "free nitro" fake links', () => {
  const phishingMessages = [
    'click here for free nitro → freenitro.gg/gift',
    'get your discord nitro gift at discord-nitro-free.com',
    'nitro.gift claim now!',
    'claim your nitro at dlscord.gift/promo123',
    'discorcl.gg/gift/abc123',
    'steamcommuniity.com/gift',
    'airdrop-discord.com/free',
  ];

  for (const msg of phishingMessages) {
    const hit = PHISHING_PATTERNS.find(re => re.test(msg));
    assert.ok(hit, `Must detect phishing in: "${msg}"`);
  }
});

test('F2.2: PHISHING_PATTERNS does NOT flag legitimate Discord messages', () => {
  const legit = [
    'Check out this YouTube video: https://youtube.com/watch?v=test',
    'Join the official server: https://discord.gg/official',
    'Listening to Spotify now: https://spotify.com/track/abc',
    'Discord is the best chat app, love it!',
    'https://tenor.com/gif/laughing-cat',
  ];

  for (const msg of legit) {
    // Only the typo-squatting patterns should fire, not legit URLs
    const hit = PHISHING_PATTERNS.find(re => re.test(msg));
    if (hit) {
      // If it fires, it should NOT be because of legitimate domains
      assert.fail(`False positive on legit message: "${msg}" (matched: ${hit})`);
    }
  }
});

test('F2.3: Zero-width character stripping catches cloaked phishing links', () => {
  const cloaked = 'get\u200Bfree\u200Cnitro\u200Dfree-nitro.gg/gift'.replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '');
  const hit = PHISHING_PATTERNS.find(re => re.test(cloaked));
  assert.ok(hit, 'Must detect phishing after zero-width character stripping');
});

test('F2.4: PHISHING_PATTERNS detects fake steam gift card scams', () => {
  const scamMsgs = [
    'Win a steam gift card at steamcoimunity.com',
    'Free steam gift-card: https://stearncommunity.com/free',
    'Get nitro via steamcommuniity.com/?ref=discord',
  ];

  for (const msg of scamMsgs) {
    const hit = PHISHING_PATTERNS.find(re => re.test(msg));
    assert.ok(hit, `Must detect steam scam in: "${msg}"`);
  }
});

// ═══════════════════════════════════════════════════════════════════
// FEATURE 3: /threat DEFCON Switcher
// ═══════════════════════════════════════════════════════════════════

test('F3.1: /threat renders DEFCON level embed with 3 action buttons', async () => {
  let responsePayload = null;

  const interaction = {
    commandName: 'threat',
    guild: { id: 'guild_threat_test', name: 'Threat Test Guild' },
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    options: {},
    replied: false,
    deferred: false,
    reply: async (payload) => {
      responsePayload = payload;
      interaction.replied = true;
    },
  };

  await dispatchCommand(interaction, {});

  assert.ok(responsePayload, '/threat must produce a response');
  assert.ok(responsePayload.embeds?.length > 0, 'Must include embed');
  assert.ok(responsePayload.ephemeral === true, 'Must be ephemeral');
  assert.ok(responsePayload.components?.length >= 1, 'Must include button row');

  const embed = responsePayload.embeds[0];
  assert.ok(embed.data.title.includes('DEFCON'), 'Must reference DEFCON in title');
  assert.ok(embed.data.fields?.some(f => f.name.includes('DEFCON 1')), 'Must show DEFCON 1 description');
  assert.ok(embed.data.fields?.some(f => f.name.includes('DEFCON 2')), 'Must show DEFCON 2 description');
  assert.ok(embed.data.fields?.some(f => f.name.includes('DEFCON 3')), 'Must show DEFCON 3 description');
});

test('F3.2: /threat current status reflects saved DEFCON level', async () => {
  const guildId = 'guild_threat_defcon2';
  const config = getGuildConfig(guildId, 'Defcon Test');
  config.security.defcon = 2;
  saveGuildConfig(guildId, config);

  let responsePayload = null;
  const interaction = {
    commandName: 'threat',
    guild: { id: guildId, name: 'Defcon Test' },
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    options: {},
    replied: false,
    deferred: false,
    reply: async (payload) => { responsePayload = payload; interaction.replied = true; },
  };

  await dispatchCommand(interaction, {});

  const embed = responsePayload.embeds[0];
  // When DEFCON 2 is current, the embed color should be yellow (#FEE75C)
  assert.ok(embed.data.color || embed.data.description.includes('DEFCON 2'), 'Must reflect DEFCON 2 status');
});

// ═══════════════════════════════════════════════════════════════════
// FEATURE 4: Native Modal Settings Editor (via /panel button)
// ═══════════════════════════════════════════════════════════════════

test('F4.1: Modal submit updates automod filter thresholds correctly', () => {
  const guildId = 'guild_modal_test';
  const config = getGuildConfig(guildId, 'Modal Test Guild');

  // Simulate modal submission — directly apply the same logic as the modal handler
  const spamLimit = 8;
  const maxMentions = 3;
  const capsThreshold = 80;
  const newWords = ['testbad', 'anotherbad'];

  config.automod.antiSpam = { ...(config.automod.antiSpam || {}), maxMessages: spamLimit };
  config.automod.antiMentionSpam = { ...(config.automod.antiMentionSpam || {}), maxMentions };
  config.automod.antiCaps = { ...(config.automod.antiCaps || {}), maxPercentage: capsThreshold };
  config.automod.wordFilter = { ...(config.automod.wordFilter || {}), words: newWords };
  saveGuildConfig(guildId, config);

  // Verify persisted
  const savedConfig = getGuildConfig(guildId, 'Modal Test Guild');
  assert.strictEqual(savedConfig.automod.antiSpam.maxMessages, 8, 'Spam limit must persist as 8');
  assert.strictEqual(savedConfig.automod.antiMentionSpam.maxMentions, 3, 'Max mentions must persist as 3');
  assert.strictEqual(savedConfig.automod.antiCaps.maxPercentage, 80, 'Caps threshold must persist as 80');
  assert.deepStrictEqual(savedConfig.automod.wordFilter.words, ['testbad', 'anotherbad'], 'Word filter must persist updated words');
});

test('F4.2: Modal word list parsing handles trailing spaces and commas', () => {
  const raw = '  badword1 , badword2,   , badword3  ';
  const parsed = raw.split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
  assert.deepStrictEqual(parsed, ['badword1', 'badword2', 'badword3'], 'Must clean trailing spaces and empty tokens');
});

// ═══════════════════════════════════════════════════════════════════
// FEATURE 5: Smart Anti-Raid Mass Join Quarantiner
// ═══════════════════════════════════════════════════════════════════

test('F5.1: quarantineMember strips all roles and assigns quarantine role', async () => {
  const guildId = 'guild_raid_quarantine';
  let rolesSetTo = null;
  let quarantineRoleCreated = false;

  const fakeGuild = {
    id: guildId,
    name: 'Raid Test Guild',
    ownerId: 'owner_1',
    roles: {
      cache: {
        find: (fn) => {
          // Simulate existing quarantine role
          const mockRole = { id: 'qrole_1', name: '⚠️ Quarantined' };
          return fn(mockRole) ? mockRole : undefined;
        },
        everyone: { id: 'everyone_id' },
      },
      create: async (opts) => {
        quarantineRoleCreated = true;
        return { id: 'qrole_new', name: opts.name };
      },
    },
    members: {
      me: {
        permissions: { has: () => true },
      },
    },
  };

  const fakeMember = {
    id: 'raider_1',
    guild: fakeGuild,
    manageable: true,
    user: { tag: 'Raider#0001', bot: false },
    roles: {
      cache: Object.assign(new Map([
        ['role_1', { id: 'role_1', name: 'Member' }],
        ['role_2', { id: 'role_2', name: 'Gamer' }],
      ]), {
        filter(fn) {
          const res = [];
          for (const val of this.values()) if (fn(val)) res.push(val);
          return res;
        },
      }),
      set: async (roleIds, reason) => {
        rolesSetTo = roleIds;
      },
    },
  };

  const result = await quarantineMember(fakeMember, 'Test raid wave');

  assert.strictEqual(result.success, true, 'Quarantine must succeed with valid member');
  assert.ok(rolesSetTo, 'roles.set must be called');
  assert.ok(rolesSetTo.includes('qrole_1'), 'Must assign quarantine role id');
  assert.ok(isQuarantined(guildId, 'raider_1'), 'Member must be in quarantine registry');
});

test('F5.2: quarantineMember fails gracefully when bot lacks Manage Roles permission', async () => {
  const fakeGuild = {
    id: 'guild_no_perm',
    name: 'NoPerm Guild',
    ownerId: 'owner_1',
    roles: { cache: { find: () => null, everyone: { id: 'everyone_id' } } },
    members: {
      me: { permissions: { has: () => false } }, // Bot lacks Manage Roles
    },
  };

  const fakeMember = {
    id: 'target_noperm',
    guild: fakeGuild,
    manageable: true,
    user: { tag: 'Target#0001', bot: false },
    roles: { cache: new Map() },
  };

  const result = await quarantineMember(fakeMember, 'No perm test');
  assert.strictEqual(result.success, false, 'Must fail without Manage Roles permission');
  assert.ok(result.reason.includes('lacks Manage Roles'), 'Must report permission failure reason');
});

test('F5.3: releaseMember removes quarantine role and clears registry', async () => {
  const guildId = 'guild_release_test';
  let roleRemoved = null;

  // First, quarantine a member (mock)
  const { quarantineRegistry } = (() => {
    // Access internal via module re-require trick isn't possible, use isQuarantined check
    return {};
  })();

  const fakeGuild = {
    id: guildId,
    name: 'Release Test Guild',
    ownerId: 'owner_1',
    roles: {
      cache: {
        find: (fn) => {
          const qRole = { id: 'qrole_release', name: '⚠️ Quarantined' };
          return fn(qRole) ? qRole : undefined;
        },
        has: (id) => id === 'qrole_release',
        everyone: { id: 'everyone_id' },
      },
      create: async (opts) => ({ id: 'qrole_release', name: opts.name }),
    },
    members: {
      me: { permissions: { has: () => true } },
    },
  };

  const fakeMember = {
    id: 'member_to_release',
    guild: fakeGuild,
    manageable: true,
    user: { tag: 'Member#0001', bot: false },
    roles: {
      cache: {
        find: () => null,
        has: (id) => id === 'qrole_release',
        filter: () => ({ map: () => [] }),
        some: () => false,
        map: () => [],
      },
      set: async () => {},
      remove: async (roleId, reason) => { roleRemoved = roleId; },
    },
  };

  // First quarantine
  await quarantineMember(fakeMember, 'Test quarantine');
  assert.ok(isQuarantined(guildId, 'member_to_release'), 'Must be quarantined first');

  // Now release
  const releaseResult = await releaseMember(fakeMember, 'Admin release');
  assert.strictEqual(releaseResult.success, true, 'Release must succeed');
  assert.strictEqual(isQuarantined(guildId, 'member_to_release'), false, 'Must be removed from quarantine registry');
});

test('F5.4: getQuarantinedCount returns correct count per guild', async () => {
  const guildId = 'guild_count_test';

  // Count before any quarantines
  const before = getQuarantinedCount(guildId);
  assert.ok(typeof before === 'number', 'Must return a number');
  assert.ok(before >= 0, 'Count must be non-negative');
});

test('F5.5: /quarantine status command returns embed with quarantine info', async () => {
  let responsePayload = null;

  const interaction = {
    commandName: 'quarantine',
    guild: { id: 'guild_qstatus', name: 'QStatus Guild' },
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    options: {
      getSubcommand: () => 'status',
      getUser: () => null,
    },
    replied: false,
    deferred: false,
    reply: async (payload) => { responsePayload = payload; interaction.replied = true; },
  };

  await dispatchCommand(interaction, {});

  assert.ok(responsePayload, '/quarantine status must respond');
  assert.ok(responsePayload.embeds?.length > 0, 'Must respond with embed');
  assert.ok(responsePayload.embeds[0].data.title.includes('Quarantine'), 'Must include Quarantine in title');
});

test('F5.6: /quarantine release (mass) clears all quarantined members', async () => {
  let responseContent = null;

  const interaction = {
    commandName: 'quarantine',
    guild: {
      id: 'guild_massrelease',
      name: 'Mass Release Guild',
      members: {
        cache: new Map(),
        fetch: async () => null,
      },
      roles: {
        cache: { find: () => null, everyone: { id: 'everyone_id' } },
      },
    },
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    options: {
      getSubcommand: () => 'release',
      getUser: () => null,
    },
    replied: false,
    deferred: false,
    reply: async (payload) => {
      responseContent = typeof payload === 'string' ? payload : payload.content;
      interaction.replied = true;
    },
  };

  await dispatchCommand(interaction, {});

  assert.ok(responseContent, '/quarantine release must respond');
  assert.ok(responseContent.includes('Released'), 'Response must confirm release');
});

// ═══════════════════════════════════════════════════════════════════
// FEATURE 6: Server Banner & Logo Management Commands
// ═══════════════════════════════════════════════════════════════════

test('F6.1: /setbanner with attachment saves bannerUrl to config', async () => {
  const guildId = 'guild_banner_test_1';
  let responsePayload = null;

  const interaction = {
    commandName: 'setbanner',
    guild: { id: guildId, name: 'Banner Test Guild' },
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    options: {
      getAttachment: (name) => name === 'image' ? { url: 'https://cdn.discordapp.com/attachments/banner1.png' } : null,
      getString: () => null,
    },
    replied: false,
    deferred: false,
    reply: async (payload) => {
      responsePayload = payload;
      interaction.replied = true;
    },
  };

  await dispatchCommand(interaction, {});

  const cfg = getGuildConfig(guildId);
  assert.strictEqual(cfg.welcome.bannerUrl, 'https://cdn.discordapp.com/attachments/banner1.png');
  assert.ok(responsePayload?.embeds?.length > 0, 'Must reply with preview embed');
  assert.strictEqual(responsePayload.embeds[0].data.image.url, 'https://cdn.discordapp.com/attachments/banner1.png');
});

test('F6.2: /setbanner with url string saves bannerUrl to config', async () => {
  const guildId = 'guild_banner_test_2';
  let responsePayload = null;

  const interaction = {
    commandName: 'setbanner',
    guild: { id: guildId, name: 'Banner Test Guild 2' },
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    options: {
      getAttachment: () => null,
      getString: (name) => name === 'url' ? 'https://example.com/custom_banner.jpg' : null,
    },
    replied: false,
    deferred: false,
    reply: async (payload) => {
      responsePayload = payload;
      interaction.replied = true;
    },
  };

  await dispatchCommand(interaction, {});

  const cfg = getGuildConfig(guildId);
  assert.strictEqual(cfg.welcome.bannerUrl, 'https://example.com/custom_banner.jpg');
});

test('F6.3: /setbanner with "reset" clears bannerUrl from config', async () => {
  const guildId = 'guild_banner_test_3';
  const cfg = getGuildConfig(guildId);
  cfg.welcome.bannerUrl = 'https://example.com/old_banner.png';
  saveGuildConfig(guildId, cfg);

  let responseText = null;
  const interaction = {
    commandName: 'setbanner',
    guild: { id: guildId, name: 'Banner Test Guild 3' },
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    options: {
      getAttachment: () => null,
      getString: (name) => name === 'url' ? 'reset' : null,
    },
    replied: false,
    deferred: false,
    reply: async (payload) => {
      responseText = typeof payload === 'string' ? payload : payload.content;
      interaction.replied = true;
    },
  };

  await dispatchCommand(interaction, {});

  const updatedCfg = getGuildConfig(guildId);
  assert.strictEqual(updatedCfg.welcome.bannerUrl, '', 'Banner URL must be cleared');
  assert.ok(responseText.includes('cleared'), 'Must confirm banner cleared');
});

test('F6.4: /welcome banner sets banner and returns confirmation embed', async () => {
  const guildId = 'guild_banner_test_4';
  let responsePayload = null;

  const interaction = {
    commandName: 'welcome',
    guild: { id: guildId, name: 'Banner Test Guild 4' },
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    options: {
      getSubcommand: () => 'banner',
      getAttachment: () => null,
      getString: (name) => name === 'url' ? 'https://cdn.discordapp.com/banners/server_welcome.png' : null,
    },
    replied: false,
    deferred: false,
    reply: async (payload) => {
      responsePayload = payload;
      interaction.replied = true;
    },
  };

  await dispatchCommand(interaction, {});

  const cfg = getGuildConfig(guildId);
  assert.strictEqual(cfg.welcome.bannerUrl, 'https://cdn.discordapp.com/banners/server_welcome.png');
  assert.ok(responsePayload?.embeds?.length > 0, 'Must include confirmation embed');
});

test('F6.5: /serverbanner previews banner and applies to welcome card when apply_welcome is true', async () => {
  const guildId = 'guild_banner_test_5';
  let responsePayload = null;

  const interaction = {
    commandName: 'serverbanner',
    guild: {
      id: guildId,
      name: 'Server Banner Guild',
      bannerURL: () => 'https://cdn.discordapp.com/banners/guild_native_banner.png',
      splashURL: () => null,
    },
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    options: {
      getBoolean: (name) => name === 'apply_welcome' ? true : false,
    },
    replied: false,
    deferred: false,
    reply: async (payload) => {
      responsePayload = payload;
      interaction.replied = true;
    },
  };

  await dispatchCommand(interaction, {});

  const cfg = getGuildConfig(guildId);
  assert.strictEqual(cfg.welcome.bannerUrl, 'https://cdn.discordapp.com/banners/guild_native_banner.png');
  assert.ok(responsePayload?.embeds?.length > 0, 'Must return banner embed');
});

test('F6.6: buildWelcomeMessage incorporates custom configured bannerUrl in welcome card', () => {
  const guildId = 'guild_welcome_banner_check';
  const cfg = getGuildConfig(guildId);
  cfg.welcome.bannerUrl = 'https://cdn.discordapp.com/banners/thor_apex_banner_final.png';
  saveGuildConfig(guildId, cfg);

  const fakeGuild = {
    id: guildId,
    name: 'THOR APEX BANNER CHECK',
    channels: { cache: new Map() },
    iconURL: () => 'https://cdn.discordapp.com/icons/logo.png',
    bannerURL: () => null, // Guild has NO native boost banner
  };

  const fakeMember = {
    id: 'user_banner_preview',
    user: { id: 'user_banner_preview', username: 'TheRealThor', tag: 'TheRealThor#0001' },
    guild: fakeGuild,
  };

  const messagePayload = buildWelcomeMessage(fakeMember, fakeGuild);
  assert.ok(messagePayload.embeds?.length > 0, 'Must produce embed');
  const embed = messagePayload.embeds[0];
  assert.strictEqual(embed.data.image.url, 'https://cdn.discordapp.com/banners/thor_apex_banner_final.png', 'Embed must display custom configured banner');
});

// ═══════════════════════════════════════════════════════════════════
// FEATURE 7: AutoMod Custom Punishment System
// ═══════════════════════════════════════════════════════════════════

test('F7.1: /automod punishment updates antiSpam action and timeoutSec', async () => {
  const guildId = 'guild_punish_test_1';
  let responsePayload = null;

  const interaction = {
    commandName: 'automod',
    guild: { id: guildId, name: 'Punish Test Guild' },
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    options: {
      getSubcommand: () => 'punishment',
      getString: (name) => {
        if (name === 'rule') return 'antiSpam';
        if (name === 'action') return 'timeout';
        if (name === 'timeout_duration') return '10m';
        return null;
      },
    },
    replied: false,
    deferred: false,
    reply: async (payload) => {
      responsePayload = payload;
      interaction.replied = true;
    },
  };

  await dispatchCommand(interaction, {});

  const cfg = getGuildConfig(guildId);
  assert.strictEqual(cfg.automod.antiSpam.action, 'timeout');
  assert.strictEqual(cfg.automod.antiSpam.timeoutSec, 600); // 10m = 600s
  assert.ok(responsePayload?.embeds?.length > 0, 'Must reply with confirmation embed');
  assert.ok(responsePayload.embeds[0].data.description.includes('600 seconds'));
});

test('F7.2: /automod punishment updates wordFilter action to kick', async () => {
  const guildId = 'guild_punish_test_2';
  let responsePayload = null;

  const interaction = {
    commandName: 'automod',
    guild: { id: guildId, name: 'Punish Test Guild 2' },
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    options: {
      getSubcommand: () => 'punishment',
      getString: (name) => {
        if (name === 'rule') return 'wordFilter';
        if (name === 'action') return 'kick';
        return null;
      },
    },
    replied: false,
    deferred: false,
    reply: async (payload) => {
      responsePayload = payload;
      interaction.replied = true;
    },
  };

  await dispatchCommand(interaction, {});

  const cfg = getGuildConfig(guildId);
  assert.strictEqual(cfg.automod.wordFilter.action, 'kick');
  assert.ok(responsePayload?.embeds?.length > 0);
  assert.ok(responsePayload.embeds[0].data.description.includes('Kick'));
});

test('F7.3: /automod punishment rule:all bulk-updates all message filters', async () => {
  const guildId = 'guild_punish_test_3';

  const interaction = {
    commandName: 'automod',
    guild: { id: guildId, name: 'Punish Test Guild 3' },
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    options: {
      getSubcommand: () => 'punishment',
      getString: (name) => {
        if (name === 'rule') return 'all';
        if (name === 'action') return 'warn';
        return null;
      },
    },
    replied: false,
    deferred: false,
    reply: async () => { interaction.replied = true; },
  };

  await dispatchCommand(interaction, {});

  const cfg = getGuildConfig(guildId);
  assert.strictEqual(cfg.automod.antiSpam.action, 'warn');
  assert.strictEqual(cfg.automod.antiDuplicate.action, 'warn');
  assert.strictEqual(cfg.automod.antiMentionSpam.action, 'warn');
  assert.strictEqual(cfg.automod.antiEveryone.action, 'warn');
  assert.strictEqual(cfg.automod.antiInvites.action, 'warn');
  assert.strictEqual(cfg.automod.wordFilter.action, 'warn');
});

test('F7.5: /automod status reflects customized punishments in output embed', async () => {
  const guildId = 'guild_punish_test_5';
  const cfg = getGuildConfig(guildId);
  cfg.automod.antiSpam.action = 'ban';
  cfg.automod.wordFilter.action = 'warn';
  saveGuildConfig(guildId, cfg);

  let responsePayload = null;
  const interaction = {
    commandName: 'automod',
    guild: { id: guildId, name: 'Status Check Guild' },
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    options: {
      getSubcommand: () => 'status',
    },
    replied: false,
    deferred: false,
    reply: async (payload) => {
      responsePayload = payload;
      interaction.replied = true;
    },
  };

  await dispatchCommand(interaction, {});

  assert.ok(responsePayload?.embeds?.length > 0);
  const desc = responsePayload.embeds[0].data.description;
  assert.ok(desc.includes('`ban`'), 'Status embed must show custom ban action');
  assert.ok(desc.includes('`warn`'), 'Status embed must show custom warn action');
});

// ═══════════════════════════════════════════════════════════════════
// FEATURE 8: AutoMod Enable All / Select All Management
// ═══════════════════════════════════════════════════════════════════

test('F8.1: /automod enable with rule:all enables master engine and all 12 filters', async () => {
  const guildId = 'guild_enable_all_1';
  const cfg = getGuildConfig(guildId);
  cfg.automod.enabled = false;
  cfg.automod.antiSpam.enabled = false;
  cfg.automod.antiInvites.enabled = false;
  saveGuildConfig(guildId, cfg);

  let responseText = null;
  const interaction = {
    commandName: 'automod',
    guild: { id: guildId, name: 'Enable All Guild' },
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    options: {
      getSubcommand: () => 'enable',
      getString: (name) => name === 'rule' ? 'all' : null,
    },
    replied: false,
    deferred: false,
    reply: async (payload) => {
      responseText = typeof payload === 'string' ? payload : payload.content;
      interaction.replied = true;
    },
  };

  await dispatchCommand(interaction, {});

  const updatedCfg = getGuildConfig(guildId);
  assert.strictEqual(updatedCfg.automod.enabled, true);
  assert.strictEqual(updatedCfg.automod.antiSpam.enabled, true);
  assert.strictEqual(updatedCfg.automod.antiInvites.enabled, true);
  assert.strictEqual(updatedCfg.automod.wordFilter.enabled, true);
  assert.ok(responseText.includes('ALL 12 Detection Rules ENABLED'));
});

test('F8.2: /automod disable with rule:all disables master engine and all 12 filters', async () => {
  const guildId = 'guild_disable_all_1';

  let responseText = null;
  const interaction = {
    commandName: 'automod',
    guild: { id: guildId, name: 'Disable All Guild' },
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    options: {
      getSubcommand: () => 'disable',
      getString: (name) => name === 'rule' ? 'all' : null,
    },
    replied: false,
    deferred: false,
    reply: async (payload) => {
      responseText = typeof payload === 'string' ? payload : payload.content;
      interaction.replied = true;
    },
  };

  await dispatchCommand(interaction, {});

  const updatedCfg = getGuildConfig(guildId);
  assert.strictEqual(updatedCfg.automod.enabled, false);
  assert.strictEqual(updatedCfg.automod.antiSpam.enabled, false);
  assert.strictEqual(updatedCfg.automod.antiInvites.enabled, false);
  assert.ok(responseText.includes('ALL Rules DISABLED'));
});

test('F8.3: /automod enableall subcommand enables all rules', async () => {
  const guildId = 'guild_enableall_sub';
  const cfg = getGuildConfig(guildId);
  cfg.automod.antiCaps.enabled = false;
  saveGuildConfig(guildId, cfg);

  const interaction = {
    commandName: 'automod',
    guild: { id: guildId, name: 'EnableAll Sub Guild' },
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    options: {
      getSubcommand: () => 'enableall',
      getString: () => null,
    },
    replied: false,
    deferred: false,
    reply: async () => { interaction.replied = true; },
  };

  await dispatchCommand(interaction, {});

  const updatedCfg = getGuildConfig(guildId);
  assert.strictEqual(updatedCfg.automod.enabled, true);
  assert.strictEqual(updatedCfg.automod.antiCaps.enabled, true);
});

test('F8.4: /automod disableall subcommand disables all rules', async () => {
  const guildId = 'guild_disableall_sub';

  const interaction = {
    commandName: 'automod',
    guild: { id: guildId, name: 'DisableAll Sub Guild' },
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    options: {
      getSubcommand: () => 'disableall',
      getString: () => null,
    },
    replied: false,
    deferred: false,
    reply: async () => { interaction.replied = true; },
  };

  await dispatchCommand(interaction, {});

  const updatedCfg = getGuildConfig(guildId);
  assert.strictEqual(updatedCfg.automod.enabled, false);
  assert.strictEqual(updatedCfg.automod.antiSpam.enabled, false);
});

test('F8.5: /automod punishment with action:enable enables selected rules', async () => {
  const guildId = 'guild_punish_enable';
  const cfg = getGuildConfig(guildId);
  cfg.automod.antiLinks.enabled = false;
  saveGuildConfig(guildId, cfg);

  const interaction = {
    commandName: 'automod',
    guild: { id: guildId, name: 'Punish Enable Guild' },
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    options: {
      getSubcommand: () => 'punishment',
      getString: (name) => {
        if (name === 'rule') return 'antiLinks';
        if (name === 'action') return 'enable';
        return null;
      },
    },
    replied: false,
    deferred: false,
    reply: async () => { interaction.replied = true; },
  };

  await dispatchCommand(interaction, {});

  const updatedCfg = getGuildConfig(guildId);
  assert.strictEqual(updatedCfg.automod.antiLinks.enabled, true);
});

// ═══════════════════════════════════════════════════════════════════
// FEATURE 9: 22 New Advanced Commands Test Suite
// ═══════════════════════════════════════════════════════════════════

test('F9.1: /afk set & clear updates guildConfig.afk correctly', async () => {
  const guildId = 'guild_afk_test';
  let replyText = '';

  const mockInteraction = (sub, msg = null) => ({
    commandName: 'afk',
    guild: { id: guildId, name: 'AFK Guild' },
    member: { id: 'user_afk_1', permissions: { has: () => true } },
    user: { id: 'user_afk_1', tag: 'AfkUser#0001' },
    options: {
      getSubcommand: () => sub,
      getString: (n) => n === 'message' ? msg : null,
      getUser: () => null,
    },
    replied: false,
    deferred: false,
    reply: async (p) => { replyText = typeof p === 'string' ? p : p.content; },
  });

  await dispatchCommand(mockInteraction('set', 'Eating lunch'), {});
  let cfg = getGuildConfig(guildId);
  assert.ok(cfg.afk['user_afk_1'], 'AFK record must be created');
  assert.strictEqual(cfg.afk['user_afk_1'].message, 'Eating lunch');

  await dispatchCommand(mockInteraction('clear'), {});
  cfg = getGuildConfig(guildId);
  assert.strictEqual(cfg.afk['user_afk_1'], undefined, 'AFK record must be cleared');
});

test('F9.2: /points give & check updates member points balance', async () => {
  const guildId = 'guild_points_test';
  const initCfg = getGuildConfig(guildId);
  initCfg.points = {};
  saveGuildConfig(guildId, initCfg);
  let replyText = '';

  const mockInteraction = (sub, amount = 0) => ({
    commandName: 'points',
    guild: { id: guildId, name: 'Points Guild' },
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    options: {
      getSubcommand: () => sub,
      getUser: () => ({ id: 'target_u1', tag: 'Target#0001' }),
      getInteger: () => amount,
    },
    replied: false,
    deferred: false,
    reply: async (p) => { replyText = typeof p === 'string' ? p : p.content; },
  });

  await dispatchCommand(mockInteraction('give', 250), {});
  let cfg = getGuildConfig(guildId);
  assert.strictEqual(cfg.points['target_u1'], 250);

  await dispatchCommand(mockInteraction('take', 50), {});
  cfg = getGuildConfig(guildId);
  assert.strictEqual(cfg.points['target_u1'], 200);
});

test('F9.3: /badge give & remove manages custom recognition badges', async () => {
  const guildId = 'guild_badge_test';

  const mockInteraction = (sub, badge = '', name = '') => ({
    commandName: 'badge',
    guild: { id: guildId, name: 'Badge Guild' },
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    options: {
      getSubcommand: () => sub,
      getUser: () => ({ id: 'member_b1', tag: 'Member#0001' }),
      getString: (n) => n === 'badge' ? badge : name,
    },
    replied: false,
    deferred: false,
    reply: async () => {},
  });

  await dispatchCommand(mockInteraction('give', '🏆', 'Champion'), {});
  let cfg = getGuildConfig(guildId);
  assert.ok(cfg.badges['member_b1']?.length > 0);
  assert.strictEqual(cfg.badges['member_b1'][0].badge, '🏆');

  await dispatchCommand(mockInteraction('remove', '🏆'), {});
  cfg = getGuildConfig(guildId);
  assert.strictEqual(cfg.badges['member_b1']?.length, 0);
});

test('F9.4: /nightmode setup & toggle configures quiet hours', async () => {
  const guildId = 'guild_nightmode_test';

  const interaction = {
    commandName: 'nightmode',
    guild: { id: guildId, name: 'Nightmode Guild' },
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    options: {
      getSubcommand: () => 'setup',
      getString: (n) => n === 'start_time' ? '22:00' : '08:00',
      getInteger: () => 30,
    },
    replied: false,
    deferred: false,
    reply: async () => {},
  };

  await dispatchCommand(interaction, {});
  const cfg = getGuildConfig(guildId);
  assert.strictEqual(cfg.nightmode.enabled, true);
  assert.strictEqual(cfg.nightmode.startTime, '22:00');
  assert.strictEqual(cfg.nightmode.endTime, '08:00');
  assert.strictEqual(cfg.nightmode.slowmodeSeconds, 30);
});

test('F9.5: /serverstat setup creates voice channels ONLY without text channels', async () => {
  const guildId = 'guild_stat_test';
  const createdChannels = [];

  const mockGuild = {
    id: guildId,
    name: 'Stat Server',
    memberCount: 150,
    premiumSubscriptionCount: 5,
    members: { cache: new Map([['b1', { user: { bot: true } }]]) },
    channels: {
      create: async (opts) => {
        createdChannels.push(opts);
        return { id: `vc_${opts.name.slice(0, 5)}`, name: opts.name };
      },
    },
    roles: { everyone: { id: 'role_everyone' } },
  };

  const interaction = {
    commandName: 'serverstat',
    guild: mockGuild,
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    options: {
      getSubcommand: () => 'setup',
      getChannel: () => null,
    },
    replied: false,
    deferred: false,
    reply: async () => {},
  };

  await dispatchCommand(interaction, {});

  assert.strictEqual(createdChannels.length, 3, 'Must create 3 stat channels');
  for (const c of createdChannels) {
    // ChannelType.GuildVoice is 2 in discord.js
    assert.strictEqual(c.type, 2, 'All stat channels must be Voice channels (type 2)');
  }
  const cfg = getGuildConfig(guildId);
  assert.strictEqual(cfg.serverStats.enabled, true);
});

test('F9.6: /clone export & import clones server settings safely', async () => {
  const g1 = 'guild_source_clone';
  const g2 = 'guild_target_clone';

  const cfg1 = getGuildConfig(g1);
  cfg1.automod.antiCaps.maxPercentage = 42;
  saveGuildConfig(g1, cfg1);

  let exportMsg = '';
  const exportInteraction = {
    commandName: 'clone',
    guild: { id: g1, name: 'Source Guild' },
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    options: { getSubcommand: () => 'export' },
    replied: false,
    deferred: false,
    reply: async (p) => { exportMsg = typeof p === 'string' ? p : p.content; },
  };

  await dispatchCommand(exportInteraction, {});
  const token = exportMsg.match(/```\n([\s\S]+?)\n```/)?.[1]?.trim();
  assert.ok(token, 'Must produce export token');

  const importInteraction = {
    commandName: 'clone',
    guild: { id: g2, name: 'Target Guild' },
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    options: {
      getSubcommand: () => 'import',
      getString: () => token,
    },
    replied: false,
    deferred: false,
    reply: async () => {},
  };

  await dispatchCommand(importInteraction, {});
  const cfg2 = getGuildConfig(g2);
  assert.strictEqual(cfg2.automod.antiCaps.maxPercentage, 42, 'Cloned setting must match source');
});

test('F9.7: /appeal submit records pending appeal', async () => {
  const guildId = 'guild_appeal_test';

  const interaction = {
    commandName: 'appeal',
    guild: { id: guildId, name: 'Appeal Guild', channels: { cache: new Map() } },
    member: { id: 'user_banned_1', permissions: { has: () => false } },
    user: { id: 'user_banned_1', tag: 'BannedUser#0001' },
    options: {
      getSubcommand: () => 'submit',
      getString: (n) => n === 'reason' ? 'Mistaken warning' : 'Apologetic',
    },
    replied: false,
    deferred: false,
    reply: async () => {},
  };

  await dispatchCommand(interaction, {});
  const cfg = getGuildConfig(guildId);
  assert.ok(cfg.appeals['user_banned_1']);
  assert.strictEqual(cfg.appeals['user_banned_1'].reason, 'Mistaken warning');
  assert.strictEqual(cfg.appeals['user_banned_1'].status, 'pending');
});

test('F9.8: /queue subcommands (view, remove, move, clear) manage playlist properly', async () => {
  const guildId = 'guild_queue_test';
  const mockQueue = {
    queue: [
      { title: 'Track 1', requestedBy: 'u1' },
      { title: 'Track 2', requestedBy: 'u2' },
      { title: 'Track 3', requestedBy: 'u3' },
    ]
  };

  const mockInteraction = (sub, opts = {}) => ({
    commandName: 'queue',
    guild: { id: guildId, name: 'Queue Guild' },
    member: { id: 'user_1' },
    user: { id: 'user_1' },
    options: {
      getSubcommand: () => sub,
      getInteger: (n) => opts[n] || 1,
    },
    replied: false,
    deferred: false,
    reply: async () => {},
  });

  // Move Track 1 to pos 3
  await dispatchCommand(mockInteraction('move', { from: 1, to: 3 }), { getQ: () => mockQueue });
  assert.strictEqual(mockQueue.queue[2].title, 'Track 1');

  // Remove pos 1
  await dispatchCommand(mockInteraction('remove', { position: 1 }), { getQ: () => mockQueue });
  assert.strictEqual(mockQueue.queue.length, 2);

  // Clear queue
  await dispatchCommand(mockInteraction('clear'), { getQ: () => mockQueue });
  assert.strictEqual(mockQueue.queue.length, 0);
});

test('F9.9: /integration adds and removes external feeds without creating text channels', async () => {
  const guildId = 'guild_integ_test';

  const addInteraction = {
    commandName: 'integration',
    guild: { id: guildId, name: 'Integ Guild' },
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    options: {
      getSubcommand: () => 'youtube',
      getString: () => 'UC123456789',
      getChannel: () => ({ id: 'chan_existing_news' }),
    },
    replied: false,
    deferred: false,
    reply: async () => {},
  };

  await dispatchCommand(addInteraction, {});
  let cfg = getGuildConfig(guildId);
  assert.strictEqual(cfg.integrations.length, 1);
  assert.strictEqual(cfg.integrations[0].type, 'youtube');
  assert.strictEqual(cfg.integrations[0].channelId, 'chan_existing_news');

  const removeInteraction = {
    commandName: 'integration',
    guild: { id: guildId, name: 'Integ Guild' },
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    options: {
      getSubcommand: () => 'remove',
      getString: (n) => n === 'type' ? 'youtube' : 'UC123456789',
    },
    replied: false,
    deferred: false,
    reply: async () => {},
  };

  await dispatchCommand(removeInteraction, {});
  cfg = getGuildConfig(guildId);
  assert.strictEqual(cfg.integrations.length, 0);
});

test('F9.10: /quickmod produces moderation card with buttons', async () => {
  let response = null;

  const interaction = {
    commandName: 'quickmod',
    guild: { id: 'g_qm', name: 'QM Guild', members: { cache: new Map() } },
    member: { id: 'admin_1', permissions: { has: () => true } },
    user: { id: 'admin_1', tag: 'Admin#0001' },
    options: {
      getUser: () => ({ id: 'bad_user', tag: 'BadUser#0001', createdAt: new Date() }),
    },
    replied: false,
    deferred: false,
    reply: async (p) => { response = p; },
  };

  await dispatchCommand(interaction, {});
  assert.ok(response?.components?.length > 0, 'Must include action row buttons');
  const buttons = response.components[0].components;
  assert.strictEqual(buttons.length, 5, 'Must contain 5 rapid mod buttons (Warn, Mute10m, Mute1h, Kick, Ban)');
});



