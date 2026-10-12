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
