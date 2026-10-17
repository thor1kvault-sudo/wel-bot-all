'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateSecurityPosture,
  scanWebhooks,
  cleanWebhooks,
  handlePanicMode,
} = require('../src/security/highSecuritySuite');
const { PermissionsBitField } = require('discord.js');

test('HSS-1: evaluateSecurityPosture returns valid score, grade, and embed', () => {
  const mockGuild = {
    id: 'guild_posture_test',
    name: 'Posture Test Guild',
    mfaLevel: 1,
    verificationLevel: 2,
    explicitContentFilter: 2,
    defaultMessageNotifications: 1,
    members: {
      me: {
        permissions: new PermissionsBitField(PermissionsBitField.Flags.Administrator),
        roles: { highest: { position: 10 } }
      }
    }
  };

  const res = evaluateSecurityPosture(mockGuild);
  assert.ok(res.score >= 0 && res.score <= 100, `Score must be between 0 and 100, got: ${res.score}`);
  assert.ok(res.grade, 'Must return a grade');
  assert.ok(res.embed, 'Must return an embed');
  assert.ok(Array.isArray(res.components), 'Must return components array');
});

test('HSS-2: scanWebhooks flags orphan and unauthorized webhooks', async () => {
  const mockWebhooks = new Map([
    [
      'wh_safe',
      {
        id: 'wh_safe',
        name: 'Safe Webhook',
        channelId: 'chan_1',
        owner: { id: 'owner_123', tag: 'Owner#0001' },
      }
    ],
    [
      'wh_rogue',
      {
        id: 'wh_rogue',
        name: 'Rogue Webhook',
        channelId: 'chan_2',
        owner: null, // Orphan
      }
    ]
  ]);

  const mockGuild = {
    id: 'guild_wh_test',
    name: 'Webhook Test Guild',
    ownerId: 'owner_123',
    client: { user: { id: 'bot_999' } },
    members: {
      me: {
        permissions: new PermissionsBitField(PermissionsBitField.Flags.ManageWebhooks)
      },
      cache: new Map(),
      fetch: async () => null,
    },
    fetchWebhooks: async () => mockWebhooks,
  };

  const res = await scanWebhooks(mockGuild, {
    permissions: new PermissionsBitField(PermissionsBitField.Flags.ManageWebhooks)
  });

  assert.equal(res.success, true);
  assert.equal(res.rogueCount, 1, 'Should find exactly 1 rogue (orphan) webhook');
  assert.equal(res.components.length, 1, 'Should attach cleanup button when rogue webhooks exist');
});

test('HSS-3: handlePanicMode snapshots, strips, and lifts permissions idempotently', async () => {
  let role1Perms = PermissionsBitField.Flags.Administrator | PermissionsBitField.Flags.SendMessages;
  const mockRole1 = {
    id: 'role_mod_1',
    name: 'Moderator',
    position: 5,
    permissions: new PermissionsBitField(role1Perms),
    setPermissions: async (newBits) => { role1Perms = newBits; }
  };

  const mockGuild = {
    id: 'guild_panic_test',
    name: 'Panic Test Guild',
    roles: {
      cache: new Map([['role_mod_1', mockRole1]])
    },
    members: {
      me: {
        permissions: new PermissionsBitField(PermissionsBitField.Flags.ManageRoles),
        roles: { highest: { position: 10 } }
      }
    }
  };

  const mockActor = { id: 'admin_1', tag: 'Admin#0001' };

  // 1. Activate Panic Mode
  const actRes = await handlePanicMode(mockGuild, mockActor, 'activate');
  assert.equal(actRes.success, true);
  assert.equal(actRes.affectedRolesCount, 1);
  assert.equal(role1Perms & PermissionsBitField.Flags.Administrator, 0n, 'Administrator must be stripped during panic');

  // 2. Status Check
  const statusRes = await handlePanicMode(mockGuild, mockActor, 'status');
  assert.equal(statusRes.success, true);
  assert.equal(statusRes.active, true);

  // 3. Lift Panic Mode
  const liftRes = await handlePanicMode(mockGuild, mockActor, 'lift');
  assert.equal(liftRes.success, true);
  assert.equal(liftRes.restored, 1);
  assert.ok((role1Perms & PermissionsBitField.Flags.Administrator) !== 0n, 'Administrator must be restored after lifting panic');
});
