'use strict';

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
  GuildDefaultMessageNotifications,
  GuildExplicitContentFilter,
  GuildMFALevel,
  GuildVerificationLevel,
} = require('discord.js');
const { getGuildConfig, saveGuildConfig } = require('../config/guildConfig');

/**
 * High-Security Suite for THOR APEX
 * - Webhook Scanner & 1-Click Cleaner
 * - Security Posture Evaluator (0-100 Score & Quick-Harden)
 * - Emergency Panic Button & Permission Quarantine
 *
 * Designed for ZERO extra channels, pure in-place embeds and button components.
 */

/**
 * Scan all webhooks in the guild and identify rogue / orphan webhooks.
 */
async function scanWebhooks(guild, member) {
  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageWebhooks)) {
    return {
      success: false,
      error: 'Bot is missing `Manage Webhooks` permission to audit server webhooks.',
    };
  }

  const webhooks = await guild.fetchWebhooks().catch(() => null);
  if (!webhooks) {
    return { success: false, error: 'Could not fetch webhooks from Discord API.' };
  }

  const config = getGuildConfig(guild.id, guild.name);
  const trustedUsers = new Set(config.security?.trustedUsers || []);

  const analyzed = [];
  let rogueCount = 0;

  for (const wh of webhooks.values()) {
    const creator = wh.owner;
    let isRogue = false;
    let reason = 'Authorized';

    if (!creator) {
      isRogue = true;
      reason = 'Orphan Webhook (Creator unknown or account deleted)';
    } else if (creator.id === guild.ownerId || creator.id === guild.client.user.id) {
      reason = 'Owner / Bot Created';
    } else if (trustedUsers.has(creator.id)) {
      reason = 'Trusted Admin Created';
    } else {
      // Check if creator is still in the server
      const creatorMember = guild.members.cache.get(creator.id) || await guild.members.fetch(creator.id).catch(() => null);
      if (!creatorMember) {
        isRogue = true;
        reason = 'Orphan (Creator left server)';
      } else if (!creatorMember.permissions.has(PermissionsBitField.Flags.ManageWebhooks) && !creatorMember.permissions.has(PermissionsBitField.Flags.Administrator)) {
        isRogue = true;
        reason = 'Unauthorized (Creator lacks Webhook/Admin permissions)';
      } else {
        reason = 'Staff Member Created';
      }
    }

    if (isRogue) rogueCount++;

    analyzed.push({
      id: wh.id,
      name: wh.name || 'Unnamed',
      channelId: wh.channelId,
      creatorTag: creator ? (creator.tag || creator.username) : 'Unknown',
      creatorId: creator ? creator.id : 'N/A',
      isRogue,
      reason,
      webhook: wh,
    });
  }

  const embed = new EmbedBuilder()
    .setTitle(`🎣 Webhook Security Audit — ${guild.name}`)
    .setColor(rogueCount > 0 ? '#ED4245' : '#57F287')
    .setTimestamp()
    .setFooter({ text: 'THOR APEX High-Security Suite • Zero Extra Channels' });

  if (analyzed.length === 0) {
    embed.setDescription('✅ **Zero webhooks found in this server.** Your server has no active webhook attack surface.');
    return { success: true, embed, rogueCount: 0, components: [] };
  }

  const lines = analyzed.slice(0, 15).map((w, idx) => {
    const statusIcon = w.isRogue ? '🚨 **[ROGUE]**' : '✅ **[SAFE]**';
    return `**${idx + 1}. ${w.name}** in <#${w.channelId}>\n• Status: ${statusIcon} — *${w.reason}*\n• Creator: \`${w.creatorTag}\` (\`${w.creatorId}\`)`;
  });

  embed.setDescription(
    `Found **${analyzed.length}** total webhook(s). **${rogueCount}** flagged as unauthorized or orphan.\n\n` +
    lines.join('\n\n') +
    (analyzed.length > 15 ? `\n\n*...and ${analyzed.length - 15} more webhooks.*` : '')
  );

  const components = [];
  if (rogueCount > 0 && member.permissions.has(PermissionsBitField.Flags.ManageWebhooks)) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('sec_clean_webhooks')
        .setLabel(`Delete ${rogueCount} Rogue Webhook(s)`)
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🗑️')
    );
    components.push(row);
  }

  return { success: true, embed, rogueCount, components, analyzed };
}

/**
 * Delete all rogue / unauthorized webhooks.
 */
async function cleanWebhooks(guild, actor) {
  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageWebhooks)) {
    return { success: false, error: 'Missing `Manage Webhooks` permission.' };
  }

  const scan = await scanWebhooks(guild, guild.members.me);
  if (!scan.success) return scan;

  let deleted = 0;
  let failed = 0;

  for (const item of scan.analyzed || []) {
    if (item.isRogue) {
      try {
        await item.webhook.delete(`Rogue webhook purged by ${actor.tag || actor.username} via THOR APEX`);
        deleted++;
      } catch (_) {
        failed++;
      }
    }
  }

  return { success: true, deleted, failed };
}

/**
 * Comprehensive Server Security Posture Assessment (0-100 Score)
 */
function evaluateSecurityPosture(guild) {
  const config = getGuildConfig(guild.id, guild.name);
  const me = guild.members.me;

  let score = 0;
  const checks = [];

  // 1. 2FA Moderation Requirement (20 pts)
  if (guild.mfaLevel === GuildMFALevel.Elevated || guild.mfaLevel === 1) {
    score += 20;
    checks.push({ status: 'PASS', score: '+20', text: 'Server 2FA Moderation requirement is **ENABLED**' });
  } else {
    checks.push({ status: 'WARN', score: '+0/20', text: '2FA Moderation requirement is **DISABLED** (Vulnerable to hijacked staff accounts)' });
  }

  // 2. Verification Level (15 pts)
  if (guild.verificationLevel >= GuildVerificationLevel.Medium) {
    score += 15;
    checks.push({ status: 'PASS', score: '+15', text: `Verification level is **${GuildVerificationLevel[guild.verificationLevel] || 'SECURE'}**` });
  } else {
    checks.push({ status: 'WARN', score: '+0/15', text: `Verification level is **${GuildVerificationLevel[guild.verificationLevel] || 'LOW'}** (Vulnerable to raid bots)` });
  }

  // 3. Explicit Content Filter (10 pts)
  if (guild.explicitContentFilter === GuildExplicitContentFilter.AllMembers) {
    score += 10;
    checks.push({ status: 'PASS', score: '+10', text: 'Explicit media scanning enabled for **ALL MEMBERS**' });
  } else {
    checks.push({ status: 'WARN', score: '+5/10', text: 'Explicit media filter is not set to scan all members' });
    score += 5;
  }

  // 4. Default Notifications (10 pts)
  if (guild.defaultMessageNotifications === GuildDefaultMessageNotifications.OnlyMentions) {
    score += 10;
    checks.push({ status: 'PASS', score: '+10', text: 'Default notifications set to **Only @mentions**' });
  } else {
    checks.push({ status: 'INFO', score: '+0/10', text: 'Default notifications set to **All Messages** (High spam risk)' });
  }

  // 5. Bot Permissions & Hierarchy (15 pts)
  if (me.permissions.has(PermissionsBitField.Flags.Administrator)) {
    score += 15;
    checks.push({ status: 'PASS', score: '+15', text: 'THOR APEX has **Administrator** for instant threat containment' });
  } else {
    checks.push({ status: 'WARN', score: '+5/15', text: 'THOR APEX is missing Administrator (Containment may be slowed by granular perms)' });
    score += 5;
  }

  // 6. Anti-Nuke Status (15 pts)
  if (config.security?.antiNuke !== false) {
    score += 15;
    checks.push({ status: 'PASS', score: '+15', text: 'THOR APEX **Anti-Nuke Protection** is active' });
  } else {
    checks.push({ status: 'FAIL', score: '+0/15', text: 'Anti-Nuke Protection is currently **DISABLED**' });
  }

  // 7. AutoMod Core Status (15 pts)
  if (config.automod?.enabled !== false) {
    score += 15;
    checks.push({ status: 'PASS', score: '+15', text: 'THOR APEX **AutoMod Engine** is active' });
  } else {
    checks.push({ status: 'FAIL', score: '+0/15', text: 'AutoMod Engine is currently **DISABLED**' });
  }

  // Assign grade
  let grade = 'F';
  let color = '#ED4245';
  if (score >= 90) { grade = 'A+ (Optimal)'; color = '#57F287'; }
  else if (score >= 80) { grade = 'A (Strong)'; color = '#57F287'; }
  else if (score >= 70) { grade = 'B (Good)'; color = '#FEE75C'; }
  else if (score >= 50) { grade = 'C (Fair)'; color = '#E67E22'; }
  else if (score >= 35) { grade = 'D (Vulnerable)'; color = '#ED4245'; }

  const checklistText = checks.map(c => {
    const icon = c.status === 'PASS' ? '✅' : c.status === 'WARN' ? '⚠️' : c.status === 'FAIL' ? '❌' : 'ℹ️';
    return `${icon} \`[${c.score}]\` ${c.text}`;
  }).join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`🛡️ Server Security Posture Rating — ${guild.name}`)
    .setColor(color)
    .setDescription(
      `### Overall Security Rating: **${score} / 100** [${grade}]\n\n` +
      `**Evaluation Checklist:**\n${checklistText}\n\n` +
      `> *Rating is calculated dynamically from Discord guild settings and THOR APEX real-time defense posture.*`
    )
    .setFooter({ text: 'THOR APEX Security Engine • Zero Extra Channels' })
    .setTimestamp();

  const components = [];
  if (score < 80 && me.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('sec_quick_harden')
        .setLabel('1-Click Quick Harden (Safe)')
        .setStyle(ButtonStyle.Success)
        .setEmoji('🛡️')
    );
    components.push(row);
  }

  return { score, grade, embed, components };
}

/**
 * 1-Click Quick Harden for server safety
 */
async function quickHarden(guild, actor) {
  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    return { success: false, error: 'Missing `Manage Server` permission to adjust settings.' };
  }

  const config = getGuildConfig(guild.id, guild.name);
  const changes = [];

  try {
    // Raise verification level if low
    if (guild.verificationLevel < GuildVerificationLevel.Medium) {
      await guild.setVerificationLevel(GuildVerificationLevel.Medium, `Quick-Harden applied by ${actor.tag || actor.username}`);
      changes.push('Verification Level set to **Medium** (Account must be 5+ min old)');
    }

    // Set default notifications to mentions
    if (guild.defaultMessageNotifications !== GuildDefaultMessageNotifications.OnlyMentions) {
      await guild.setDefaultMessageNotifications(GuildDefaultMessageNotifications.OnlyMentions, `Quick-Harden applied by ${actor.tag || actor.username}`);
      changes.push('Default Notifications set to **Only @mentions**');
    }

    // Ensure Anti-Nuke and AutoMod are enabled in config
    if (config.security) config.security.antiNuke = true;
    if (config.automod) config.automod.enabled = true;
    saveGuildConfig(guild.id, config);
    changes.push('THOR APEX **Anti-Nuke** and **AutoMod** verified active');

    return { success: true, changes };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Emergency Panic Mode: Temporary Quarantine of Dangerous Administrative Permissions
 */
async function handlePanicMode(guild, actor, action = 'activate') {
  const config = getGuildConfig(guild.id, guild.name);
  const me = guild.members.me;

  if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    return { success: false, error: 'Bot lacks `Manage Roles` permission to manage panic containment.' };
  }

  if (action === 'status') {
    const active = !!config.security?.panicMode?.active;
    const snap = config.security?.panicMode;
    const embed = new EmbedBuilder()
      .setTitle(`🚨 Emergency Panic Mode Status — ${guild.name}`)
      .setColor(active ? '#ED4245' : '#57F287')
      .setDescription(
        active
          ? `⚠️ **PANIC MODE IS CURRENTLY ACTIVE**\n` +
            `• Activated by: \`${snap.activatedBy}\`\n` +
            `• Activated at: <t:${Math.floor(snap.activatedAt / 1000)}:R>\n` +
            `• Quarantined Roles: **${snap.roles?.length || 0}**\n\n` +
            `*Administrative permissions on managed roles remain suspended until Panic Mode is lifted.*`
          : `✅ **Panic Mode is NOT active.** Server roles are operating normally.`
      )
      .setTimestamp();

    const components = [];
    if (active) {
      components.push(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('sec_panic_lift')
            .setLabel('Deactivate Panic & Restore Roles')
            .setStyle(ButtonStyle.Success)
            .setEmoji('🔓')
        )
      );
    }
    return { success: true, embed, components, active };
  }

  if (action === 'activate') {
    if (config.security?.panicMode?.active) {
      return { success: false, error: 'Panic Mode is ALREADY active on this server.' };
    }

    const dangerousFlags = [
      PermissionsBitField.Flags.Administrator,
      PermissionsBitField.Flags.ManageGuild,
      PermissionsBitField.Flags.ManageRoles,
      PermissionsBitField.Flags.ManageChannels,
      PermissionsBitField.Flags.BanMembers,
    ];

    const affectedRoles = [];
    const botHighest = me.roles.highest.position;

    for (const role of guild.roles.cache.values()) {
      if (role.managed || role.id === guild.id) continue;
      if (role.position >= botHighest) continue; // Cannot modify roles at or above bot

      const hasDangerous = dangerousFlags.some(flag => role.permissions.has(flag));
      if (hasDangerous) {
        affectedRoles.push({
          id: role.id,
          name: role.name,
          originalBitfield: role.permissions.bitfield.toString(),
        });

        // Strip dangerous permissions
        let newBits = role.permissions.bitfield;
        for (const flag of dangerousFlags) {
          if (role.permissions.has(flag)) {
            newBits &= ~flag;
          }
        }

        try {
          await role.setPermissions(newBits, `THOR APEX Panic Mode activated by ${actor.tag || actor.username}`);
        } catch (_) {}
      }
    }

    if (!config.security) config.security = {};
    config.security.panicMode = {
      active: true,
      activatedBy: actor.tag || actor.username || actor.id,
      activatedAt: Date.now(),
      roles: affectedRoles,
    };
    saveGuildConfig(guild.id, config);

    const embed = new EmbedBuilder()
      .setTitle(`🚨 Emergency Panic Mode ACTIVATED — ${guild.name}`)
      .setColor('#ED4245')
      .setDescription(
        `### All Administrative Permissions Quarantined\n\n` +
        `• **Target:** Suspended dangerous permissions (` +
        `Administrator, ManageRoles, ManageChannels, BanMembers) on **${affectedRoles.length}** role(s) below bot.\n` +
        `• **Actor:** \`${actor.tag || actor.username}\`\n` +
        `• **Safety:** All original permissions have been snapshot and can be restored with 1 click.\n\n` +
        `**Affected Roles:**\n` +
        (affectedRoles.slice(0, 10).map(r => `• <@&${r.id}> (\`${r.name}\`)`).join('\n') || 'None below bot') +
        (affectedRoles.length > 10 ? `\n*...and ${affectedRoles.length - 10} more roles.*` : '')
      )
      .setFooter({ text: 'Click button below to restore server permissions once safe' })
      .setTimestamp();

    const components = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('sec_panic_lift')
          .setLabel('Lift Panic & Restore Roles')
          .setStyle(ButtonStyle.Success)
          .setEmoji('🔓')
      )
    ];

    return { success: true, embed, components, affectedRolesCount: affectedRoles.length };
  }

  if (action === 'lift') {
    const snap = config.security?.panicMode;
    if (!snap || !snap.active) {
      return { success: false, error: 'Panic Mode is not currently active.' };
    }

    let restored = 0;
    let failed = 0;

    for (const r of snap.roles || []) {
      const role = guild.roles.cache.get(r.id);
      if (role && role.position < me.roles.highest.position) {
        try {
          await role.setPermissions(BigInt(r.originalBitfield), `THOR APEX Panic Mode lifted by ${actor.tag || actor.username}`);
          restored++;
        } catch (_) {
          failed++;
        }
      }
    }

    config.security.panicMode = { active: false, liftedAt: Date.now(), liftedBy: actor.tag || actor.username };
    saveGuildConfig(guild.id, config);

    const embed = new EmbedBuilder()
      .setTitle(`🔓 Emergency Panic Mode LIFTED — ${guild.name}`)
      .setColor('#57F287')
      .setDescription(
        `### Permissions Successfully Restored\n\n` +
        `• Restored **${restored}** role(s) to original snapshot permissions.\n` +
        (failed > 0 ? `• ⚠️ Failed to restore **${failed}** role(s).\n` : '') +
        `• Lifted by: \`${actor.tag || actor.username}\`\n` +
        `• Normal server administration has resumed.`
      )
      .setTimestamp();

    return { success: true, embed, components: [], restored, failed };
  }

  return { success: false, error: 'Unknown panic action.' };
}

module.exports = {
  scanWebhooks,
  cleanWebhooks,
  evaluateSecurityPosture,
  quickHarden,
  handlePanicMode,
};
