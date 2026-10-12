const test = require('node:test');
const assert = require('node:assert');
const {
  isTrustedUser,
  recordAndCheckThreshold,
  executeEnforcement,
  handleAntiNukeEvent,
} = require('../src/security/antiNuke');
const { getGuildConfig, saveGuildConfig } = require('../src/config/guildConfig');

test('Group C.1: Anti-Nuke Sliding Window limits actions properly', () => {
  const gId = 'guild_nuke_test_window';
  const actorId = 'actor_evil_99';
  const action = 'channelDelete';

  // Limit 3 within 15 seconds
  const r1 = recordAndCheckThreshold(gId, actorId, action, 3, 15000);
  assert.strictEqual(r1.triggered, false);
  assert.strictEqual(r1.count, 1);

  const r2 = recordAndCheckThreshold(gId, actorId, action, 3, 15000);
  assert.strictEqual(r2.triggered, false);
  assert.strictEqual(r2.count, 2);

  const r3 = recordAndCheckThreshold(gId, actorId, action, 3, 15000);
  assert.strictEqual(r3.triggered, true);
  assert.strictEqual(r3.count, 3);
});

test('Group C.2: Server Owner and Bot are strictly immune to Anti-Nuke', () => {
  const fakeGuild = {
    id: 'guild_immune_check',
    name: 'Immune Check Guild',
    ownerId: 'owner_apex',
    client: { user: { id: 'bot_thor_apex' } },
    members: { cache: new Map() },
  };

  assert.strictEqual(isTrustedUser(fakeGuild, 'owner_apex'), true, 'Server Owner must be immune');
  assert.strictEqual(isTrustedUser(fakeGuild, 'bot_thor_apex'), true, 'Bot itself must be immune');
  assert.strictEqual(isTrustedUser(fakeGuild, 'random_rogue_mod'), false, 'Rogue mod is not immune');
});

test('Group C.3: Anti-Nuke reports ban failure truthfully when bot lacks BanMembers permission', async () => {
  const fakeGuild = {
    id: 'guild_nuke_no_perm',
    name: 'No Perm Guild',
    members: {
      cache: new Map(),
      me: {
        permissions: { has: () => false }, // No BanMembers!
        roles: { highest: { position: 1 } },
      },
      fetch: async () => null,
    },
    bans: {
      create: async () => { throw new Error('Missing Permissions'); },
    },
  };

  const rogueActor = { id: 'rogue_admin_1', tag: 'Rogue#0001' };
  const check = { count: 5, limit: 2, windowMs: 15000 };

  const res = await executeEnforcement(fakeGuild, rogueActor, 'Mass Channel Deletion', check);
  assert.strictEqual(res.executed, true);
  assert.strictEqual(res.success, false, 'Must not report ban success when bot lacks permission');
  assert.ok(res.incident.result.includes('Ban Failed'));
});

test('Group C.4: Anti-Nuke deduplicates punishments within cooldown window', async () => {
  const fakeGuild = {
    id: 'guild_nuke_dedup',
    name: 'Dedup Guild',
    members: {
      cache: new Map(),
      me: { permissions: { has: () => true }, roles: { highest: { position: 10 } } },
      fetch: async () => null,
    },
    bans: { create: async () => {} },
  };

  const actor = { id: 'spammer_attacker', tag: 'Attacker#0001' };
  const check = { count: 3, limit: 2, windowMs: 15000 };

  const first = await executeEnforcement(fakeGuild, actor, 'Mass Role Deletion', check);
  assert.strictEqual(first.executed, true);

  // Immediate second enforcement on same user
  const second = await executeEnforcement(fakeGuild, actor, 'Mass Role Deletion', check);
  assert.strictEqual(second.executed, false);
  assert.strictEqual(second.reason, 'Cooldown active');
});
