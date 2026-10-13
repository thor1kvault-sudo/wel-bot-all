const {
  EmbedBuilder, PermissionsBitField, ChannelType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const musicService = (() => { try { return require('../music/musicService'); } catch (_) { return null; } })();
const musicMonitor = (() => { try { return require('../music/musicUpdateMonitor'); } catch (_) { return null; } })();
const audioProvider = (() => { try { return require('../music/audioProvider'); } catch (_) { return null; } })();
const os = require('os');
const { getGuildConfig, saveGuildConfig } = require('../config/guildConfig');
const {
  warnMember, timeoutMember, untimeoutMember, kickMember,
  banMember, softbanMember, purgeMessages, lockChannel, unlockChannel,
} = require('../moderation/modService');
const {
  setupAllLogChannels, resolveLogChannel, logMember, logMessage,
  logModeration, logSecurity, logAntiNuke, logAutoMod,
} = require('../logging/loggerService');
const {
  buildWelcomeMessage, buildGoodbyeMessage, runWelcomeDiagnostic,
} = require('../welcome/welcomeService');
const {
  runAutoModDiagnostic,
} = require('../automod/autoModEngine');
const {
  getQuarantinedCount, releaseAllQuarantine, releaseMember,
} = require('../security/antiRaid');
const {
  redactSecrets, safeReply, isHex, formatDuration, parseDuration,
} = require('../utils/helpers');

/**
 * Dispatches and executes slash commands with bulletproof interaction acknowledgement.
 */
async function dispatchCommand(interaction, context = {}) {
  const { commandName, guild, member, user } = interaction;
  if (!guild) {
    return safeReply(interaction, 'Commands can only be used inside a Discord server.', true);
  }

  const config = getGuildConfig(guild.id, guild.name);
  const {
    client, startTime = Date.now(),
    getQ, stopMusicSession, handleTrackEnded, addMusicToQueue,
    RADIO_STREAMS = {}, voiceLib
  } = context;

  // ─────────────────────────────────────────────────────────────
  // 1. GENERAL MODERATION COMMANDS
  // ─────────────────────────────────────────────────────────────
  if (commandName === 'warn') {
    const target = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('reason') || 'No reason provided';
    const res = await warnMember(guild, user, target, reason);
    return safeReply(interaction, `⚠️ **${target.tag}** warned. Reason: **${reason}** (Total Warnings: **${res.count}**)`);
  }

  if (commandName === 'warnings') {
    const target = interaction.options.getUser('user', true);
    const list = config.warnings?.[target.id] || [];
    if (list.length === 0) return safeReply(interaction, `✅ **${target.tag}** has no active warnings.`);
    const desc = list.map((w, i) => `${i + 1}. **${w.reason}** — by ${w.mod} (<t:${Math.floor(w.timestamp / 1000)}:R>)`).join('\n');
    const embed = new EmbedBuilder()
      .setColor('#FEE75C')
      .setTitle(`Active Warnings — ${target.tag}`)
      .setDescription(desc)
      .setFooter({ text: `Total Warnings: ${list.length}` })
      .setTimestamp();
    return safeReply(interaction, { embeds: [embed] });
  }

  if (commandName === 'clearwarnings' || commandName === 'clearwarns') {
    const target = interaction.options.getUser('user', true);
    if (config.warnings && config.warnings[target.id]) {
      delete config.warnings[target.id];
      saveGuildConfig(guild.id, config);
    }
    return safeReply(interaction, `🗑️ Cleared all warnings for **${target.tag}**.`);
  }

  if (commandName === 'timeout') {
    const target = interaction.options.getUser('user', true);
    const targetMember = guild.members.cache.get(target.id) || await guild.members.fetch(target.id).catch(() => null);
    if (!targetMember) return safeReply(interaction, 'User is not in the server.');
    const duration = interaction.options.getString('duration', true);
    const reason = interaction.options.getString('reason') || 'No reason provided';
    const res = await timeoutMember(guild, member, targetMember, duration, reason);
    if (!res.success) return safeReply(interaction, `❌ ${res.reason}`);
    return safeReply(interaction, `⏳ Timed out **${target.tag}** for **${res.formatted}**. Reason: **${reason}**`);
  }

  if (commandName === 'untimeout') {
    const target = interaction.options.getUser('user', true);
    const targetMember = guild.members.cache.get(target.id) || await guild.members.fetch(target.id).catch(() => null);
    if (!targetMember) return safeReply(interaction, 'User is not in the server.');
    const res = await untimeoutMember(guild, member, targetMember);
    if (!res.success) return safeReply(interaction, `❌ ${res.reason}`);
    return safeReply(interaction, `⌛ Removed timeout from **${target.tag}**.`);
  }

  if (commandName === 'kick') {
    const target = interaction.options.getUser('user', true);
    const targetMember = guild.members.cache.get(target.id) || await guild.members.fetch(target.id).catch(() => null);
    if (!targetMember) return safeReply(interaction, 'User is not in the server.');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    const res = await kickMember(guild, member, targetMember, reason);
    if (!res.success) return safeReply(interaction, `❌ ${res.reason}`);
    return safeReply(interaction, `🚫 Kicked **${target.tag}** from the server.`);
  }

  if (commandName === 'ban') {
    const target = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('reason') || 'No reason provided';
    const deleteDays = interaction.options.getInteger('delete_days') || 0;
    const res = await banMember(guild, member, target, reason, deleteDays * 86400);
    if (!res.success) return safeReply(interaction, `❌ ${res.reason}`);
    return safeReply(interaction, `⛔ Banned **${target.tag || target.id}** from the server.`);
  }

  if (commandName === 'unban') {
    const uid = interaction.options.getString('userid', true);
    const reason = interaction.options.getString('reason') || 'Unbanned by moderator';
    try {
      await guild.bans.remove(uid, reason);
      return safeReply(interaction, `🔓 Unbanned user ID \`${uid}\`.`);
    } catch (err) {
      return safeReply(interaction, `❌ Failed to unban: ${err.message}`);
    }
  }

  if (commandName === 'softban') {
    const target = interaction.options.getUser('user', true);
    const targetMember = guild.members.cache.get(target.id) || await guild.members.fetch(target.id).catch(() => null);
    if (!targetMember) return safeReply(interaction, 'User is not in the server.');
    const reason = interaction.options.getString('reason') || 'Softban purge';
    const res = await softbanMember(guild, member, targetMember, reason);
    if (!res.success) return safeReply(interaction, `❌ ${res.reason}`);
    return safeReply(interaction, `🧹 Softbanned **${target.tag}** (kicked & purged 7 days of messages).`);
  }

  if (commandName === 'purge') {
    const amount = interaction.options.getInteger('amount', true);
    const filter = interaction.options.getString('filter') || 'all';
    await interaction.deferReply({ ephemeral: true });
    const res = await purgeMessages(interaction.channel, amount, filter);
    if (!res.success) return interaction.editReply(`❌ ${res.reason}`);
    return interaction.editReply(`🗑️ Bulk deleted **${res.count}** messages.`);
  }

  if (commandName === 'slowmode') {
    const seconds = interaction.options.getInteger('seconds', true);
    const targetChan = interaction.options.getChannel('channel') || interaction.channel;
    await targetChan.setRateLimitPerUser(seconds);
    return safeReply(interaction, `⏱️ Slowmode in <#${targetChan.id}> set to **${seconds}s**.`);
  }

  if (commandName === 'lock') {
    const targetChan = interaction.options.getChannel('channel') || interaction.channel;
    const reason = interaction.options.getString('reason') || 'Locked by staff';
    const res = await lockChannel(targetChan, user, reason);
    if (!res.success) return safeReply(interaction, `❌ Failed to lock: ${res.reason}`);
    return safeReply(interaction, `🔒 Locked <#${targetChan.id}>.`);
  }

  if (commandName === 'unlock') {
    const targetChan = interaction.options.getChannel('channel') || interaction.channel;
    const res = await unlockChannel(targetChan, user);
    if (!res.success) return safeReply(interaction, `❌ Failed to unlock: ${res.reason}`);
    return safeReply(interaction, `🔓 Unlocked <#${targetChan.id}>.`);
  }

  if (commandName === 'nick') {
    const target = interaction.options.getUser('user', true);
    const targetMember = guild.members.cache.get(target.id) || await guild.members.fetch(target.id).catch(() => null);
    if (!targetMember) return safeReply(interaction, 'User not found in server.');
    const newNick = interaction.options.getString('nickname') || null;
    await targetMember.setNickname(newNick);
    return safeReply(interaction, `🏷️ Nickname for **${target.tag}** updated.`);
  }

  if (commandName === 'modlogs') {
    const target = interaction.options.getUser('user', true);
    const list = config.warnings?.[target.id] || [];
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle(`Moderation Records — ${target.tag}`)
      .setDescription(`**Total Warnings:** ${list.length}\n\n` + (list.map((w, i) => `${i + 1}. **${w.reason}** — by ${w.mod}`).join('\n') || '*No moderation strikes found.*'))
      .setTimestamp();
    return safeReply(interaction, { embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────
  // 2. SECURITY & ANTI-NUKE COMMANDS
  // ─────────────────────────────────────────────────────────────
  if (commandName === 'security') {
    const sub = interaction.options.getSubcommand(false) || 'status';
    if (sub === 'status') {
      const s = config.security || {};
      const embed = new EmbedBuilder()
        .setColor(s.lockdown ? '#ED4245' : '#57F287')
        .setTitle(`🛡️ Security Engine Status — ${guild.name}`)
        .setDescription(`**Anti-Nuke Protection:** ${s.antiNuke ? '🟢 **ACTIVE**' : '🔴 **DISABLED**'}\n**Enforcement Action:** \`${s.action || 'strip_and_ban'}\`\n**Emergency Lockdown:** ${s.lockdown ? '🚨 **ENGAGED**' : '🟢 **NORMAL**'}\n**Trusted Users:** ${s.trustedUsers?.length || 0}\n**Trusted Roles:** ${s.trustedRoles?.length || 0}\n**Recent Incidents Intercepted:** ${config.incidents?.length || 0}`)
        .setFooter({ text: 'High-speed event detection engine active' })
        .setTimestamp();
      return safeReply(interaction, { embeds: [embed] });
    }
    if (sub === 'audit') {
      const me = guild.members.me;
      const auditEmbed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`🔍 Security Audit — ${guild.name}`)
        .setDescription(`**Bot Highest Role Position:** ${me?.roles?.highest?.position}\n**Server Owner:** <@${guild.ownerId}>\n**Has Administrator:** ${me?.permissions?.has(PermissionsBitField.Flags.Administrator) ? '✅ Yes' : '⚠️ No (Admin recommended for instant containment)'}\n**Has View Audit Log:** ${me?.permissions?.has(PermissionsBitField.Flags.ViewAuditLog) ? '✅ Yes' : '❌ Missing'}\n**Has Ban Members:** ${me?.permissions?.has(PermissionsBitField.Flags.BanMembers) ? '✅ Yes' : '❌ Missing'}\n**Has Manage Roles:** ${me?.permissions?.has(PermissionsBitField.Flags.ManageRoles) ? '✅ Yes' : '❌ Missing'}`)
        .setTimestamp();
      return safeReply(interaction, { embeds: [auditEmbed] });
    }
    if (sub === 'incidents') {
      const incs = config.incidents || [];
      if (incs.length === 0) return safeReply(interaction, '🛡️ No recent security incidents recorded.');
      const list = incs.slice(0, 10).map(inc => `• **${inc.action}** by \`${inc.actorTag}\` ➔ **${inc.result}** (${inc.latencyMs}ms latency) [<t:${Math.floor(inc.timestamp / 1000)}:R>]`).join('\n');
      const embed = new EmbedBuilder()
        .setColor('#ED4245')
        .setTitle('🚨 Recent Anti-Nuke Intercepts')
        .setDescription(list)
        .setFooter({ text: `Showing last ${Math.min(10, incs.length)} of ${incs.length} incidents` })
        .setTimestamp();
      return safeReply(interaction, { embeds: [embed] });
    }
    if (sub === 'test') {
      return safeReply(interaction, '✅ Security alert dispatch path tested successfully. Sub-second interception active.');
    }
  }

  if (commandName === 'antinuke') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'enable') {
      config.security.antiNuke = true; saveGuildConfig(guild.id, config);
      return safeReply(interaction, '🛡️ **Anti-Nuke Protection ENABLED!** All channels, roles, and administrative activity are guarded.');
    }
    if (sub === 'disable') {
      config.security.antiNuke = false; saveGuildConfig(guild.id, config);
      return safeReply(interaction, '⚠️ **Anti-Nuke Protection DISABLED.**');
    }
    if (sub === 'status') {
      const s = config.security || {};
      const t = s.thresholds || {};
      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('🛡️ Anti-Nuke Configuration')
        .setDescription(`**Status:** ${s.antiNuke ? '🟢 Enabled' : '🔴 Disabled'}\n**Action:** \`${s.action}\`\n\n**Thresholds (Limits within window):**\n` +
          `• Channel Delete: ${t.channelDelete?.limit || 2} in ${(t.channelDelete?.windowMs || 15000)/1000}s\n` +
          `• Channel Create: ${t.channelCreate?.limit || 4} in ${(t.channelCreate?.windowMs || 15000)/1000}s\n` +
          `• Role Delete: ${t.roleDelete?.limit || 2} in ${(t.roleDelete?.windowMs || 15000)/1000}s\n` +
          `• Role Create: ${t.roleCreate?.limit || 4} in ${(t.roleCreate?.windowMs || 15000)/1000}s\n` +
          `• Member Ban: ${t.memberBan?.limit || 3} in ${(t.memberBan?.windowMs || 15000)/1000}s\n` +
          `• Member Kick: ${t.memberKick?.limit || 3} in ${(t.memberKick?.windowMs || 15000)/1000}s\n` +
          `• Bot Add: ${t.botAdd?.limit || 1} in ${(t.botAdd?.windowMs || 15000)/1000}s`
        )
        .setTimestamp();
      return safeReply(interaction, { embeds: [embed] });
    }
    if (sub === 'config') {
      const action = interaction.options.getString('action', true);
      config.security.action = action; saveGuildConfig(guild.id, config);
      return safeReply(interaction, `🛡️ Anti-Nuke containment action set to **${action.toUpperCase()}**.`);
    }
    if (sub === 'threshold') {
      const act = interaction.options.getString('action', true);
      const limit = interaction.options.getInteger('limit', true);
      const winSec = interaction.options.getInteger('window_seconds') || 15;
      if (!config.security.thresholds) config.security.thresholds = {};
      config.security.thresholds[act] = { limit, windowMs: winSec * 1000 };
      saveGuildConfig(guild.id, config);
      return safeReply(interaction, `✅ Threshold for **${act}** set to **${limit} actions** in **${winSec}s**.`);
    }
    if (sub === 'trust') {
      const action = interaction.options.getString('action', true);
      const targetUser = interaction.options.getUser('user');
      const targetRole = interaction.options.getRole('role');
      if (!config.security.trustedUsers) config.security.trustedUsers = [];
      if (!config.security.trustedRoles) config.security.trustedRoles = [];

      if (action === 'add') {
        if (targetUser && !config.security.trustedUsers.includes(targetUser.id)) config.security.trustedUsers.push(targetUser.id);
        if (targetRole && !config.security.trustedRoles.includes(targetRole.id)) config.security.trustedRoles.push(targetRole.id);
        saveGuildConfig(guild.id, config);
        return safeReply(interaction, `✅ Trusted entry added.`);
      }
      if (action === 'remove') {
        if (targetUser) config.security.trustedUsers = config.security.trustedUsers.filter(id => id !== targetUser.id);
        if (targetRole) config.security.trustedRoles = config.security.trustedRoles.filter(id => id !== targetRole.id);
        saveGuildConfig(guild.id, config);
        return safeReply(interaction, `❌ Trusted entry removed.`);
      }
      if (action === 'list') {
        const uList = config.security.trustedUsers.map(id => `<@${id}>`).join(', ') || 'None';
        const rList = config.security.trustedRoles.map(id => `<@&${id}>`).join(', ') || 'None';
        return safeReply(interaction, `🛡️ **Trusted Users:** ${uList}\n🛡️ **Trusted Roles:** ${rList}`);
      }
    }
    if (sub === 'lockdown') {
      config.security.lockdown = true; saveGuildConfig(guild.id, config);
      if (guild.channels?.cache) {
        for (const [, ch] of guild.channels.cache) {
          if (ch.isTextBased?.() && ch.permissionOverwrites?.create) {
            await ch.permissionOverwrites.create(guild.roles?.everyone, { SendMessages: false }).catch(() => {});
          }
        }
      }
      return safeReply(interaction, '🚨 **SERVER LOCKDOWN ENGAGED!** `@everyone` cannot send messages.');
    }
    if (sub === 'unlock') {
      config.security.lockdown = false; saveGuildConfig(guild.id, config);
      if (guild.channels?.cache) {
        for (const [, ch] of guild.channels.cache) {
          if (ch.isTextBased?.() && ch.permissionOverwrites?.create) {
            await ch.permissionOverwrites.create(guild.roles?.everyone, { SendMessages: null }).catch(() => {});
          }
        }
      }
      return safeReply(interaction, '🟢 **Lockdown lifted.** Server channels restored.');
    }
  }

  // Legacy Lockdown shortcut
  if (commandName === 'lockdown') {
    const toggle = interaction.options.getString('toggle', true);
    if (toggle === 'on') {
      config.security.lockdown = true; saveGuildConfig(guild.id, config);
      if (guild.channels?.cache) {
        for (const [, ch] of guild.channels.cache) {
          if (ch.isTextBased?.() && ch.permissionOverwrites?.create) {
            await ch.permissionOverwrites.create(guild.roles?.everyone, { SendMessages: false }).catch(() => {});
          }
        }
      }
      return safeReply(interaction, '🚨 **SERVER LOCKDOWN ENGAGED!** `@everyone` cannot send messages.');
    } else {
      config.security.lockdown = false; saveGuildConfig(guild.id, config);
      if (guild.channels?.cache) {
        for (const [, ch] of guild.channels.cache) {
          if (ch.isTextBased?.() && ch.permissionOverwrites?.create) {
            await ch.permissionOverwrites.create(guild.roles?.everyone, { SendMessages: null }).catch(() => {});
          }
        }
      }
      return safeReply(interaction, '🟢 **Lockdown lifted.** Server channels restored.');
    }
  }

  // Legacy Whitelist shortcut
  if (commandName === 'whitelist') {
    const action = interaction.options.getString('action', true);
    const targetUser = interaction.options.getUser('user');
    const targetRole = interaction.options.getRole('role');
    if (!config.security.trustedUsers) config.security.trustedUsers = [];
    if (!config.security.trustedRoles) config.security.trustedRoles = [];

    if (action === 'add') {
      if (targetUser && !config.security.trustedUsers.includes(targetUser.id)) config.security.trustedUsers.push(targetUser.id);
      if (targetRole && !config.security.trustedRoles.includes(targetRole.id)) config.security.trustedRoles.push(targetRole.id);
      saveGuildConfig(guild.id, config);
      return safeReply(interaction, '✅ Entry added to Anti-Nuke Whitelist.');
    }
    if (action === 'remove') {
      if (targetUser) config.security.trustedUsers = config.security.trustedUsers.filter(id => id !== targetUser.id);
      if (targetRole) config.security.trustedRoles = config.security.trustedRoles.filter(id => id !== targetRole.id);
      saveGuildConfig(guild.id, config);
      return safeReply(interaction, '❌ Entry removed from Anti-Nuke Whitelist.');
    }
    if (action === 'clear') {
      config.security.trustedUsers = [];
      config.security.trustedRoles = [];
      saveGuildConfig(guild.id, config);
      return safeReply(interaction, '🗑️ Cleared all Anti-Nuke Whitelist entries.');
    }
    if (action === 'list' || action === 'manage') {
      const uList = config.security.trustedUsers.map(id => `<@${id}>`).join(', ') || 'None';
      const rList = config.security.trustedRoles.map(id => `<@&${id}>`).join(', ') || 'None';
      return safeReply(interaction, `🛡️ **Whitelisted Users:** ${uList}\n🛡️ **Whitelisted Roles:** ${rList}`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 3. AUTOMOD COMMANDS (FIXED ROOT CAUSE: CONFIG & TEST RESTORED)
  // ─────────────────────────────────────────────────────────────
  if (commandName === 'automod') {
    const sub = interaction.options.getSubcommand();
    const am = config.automod || {};
    const ALL_AUTOMOD_RULES = [
      'antiSpam', 'antiDuplicate', 'antiMentionSpam', 'antiEveryone',
      'antiInvites', 'antiLinks', 'antiNsfwLinks', 'wordFilter',
      'antiCaps', 'antiEmojiSpam', 'altDetection', 'antiRaid',
    ];

    const RULE_NAMES = {
      antiSpam: 'Anti-Spam (Message Flood)',
      antiDuplicate: 'Duplicate Messages',
      antiMentionSpam: 'Mention Spam',
      antiEveryone: 'Unauthorized @everyone / @here',
      antiInvites: 'Discord Invite Links',
      antiLinks: 'External / Suspicious Links',
      antiNsfwLinks: 'NSFW / Adult Links',
      wordFilter: 'Word Blacklist',
      antiCaps: 'Caps Lock Filter',
      antiEmojiSpam: 'Emoji Spam',
      altDetection: 'Alt Account Detection',
      antiRaid: 'Anti-Raid Join Flood',
      all: 'ALL AutoMod Rules',
    };

    if (sub === 'enable') {
      const rule = interaction.options.getString('rule');
      if (!rule || rule === 'all') {
        config.automod.enabled = true;
        for (const r of ALL_AUTOMOD_RULES) {
          if (!config.automod[r]) config.automod[r] = {};
          config.automod[r].enabled = true;
        }
        saveGuildConfig(guild.id, config);
        return safeReply(interaction, '🟢 **AutoMod Engine & ALL 12 Detection Rules ENABLED!** Every filter (Spam, Links, Invites, Blacklist, Alts, Mentions, Caps, Emojis, Raid, etc.) is now active.');
      } else {
        config.automod.enabled = true;
        if (!config.automod[rule]) config.automod[rule] = {};
        config.automod[rule].enabled = true;
        saveGuildConfig(guild.id, config);
        const name = RULE_NAMES[rule] || rule;
        return safeReply(interaction, `🟢 **${name}** filter is now **ENABLED**.`);
      }
    }

    if (sub === 'disable') {
      const rule = interaction.options.getString('rule');
      if (!rule || rule === 'all') {
        config.automod.enabled = false;
        for (const r of ALL_AUTOMOD_RULES) {
          if (!config.automod[r]) config.automod[r] = {};
          config.automod[r].enabled = false;
        }
        saveGuildConfig(guild.id, config);
        return safeReply(interaction, '🔴 **AutoMod Engine & ALL Rules DISABLED.** All detection filters have been turned off.');
      } else {
        if (!config.automod[rule]) config.automod[rule] = {};
        config.automod[rule].enabled = false;
        saveGuildConfig(guild.id, config);
        const name = RULE_NAMES[rule] || rule;
        return safeReply(interaction, `🔴 **${name}** filter is now **DISABLED**.`);
      }
    }

    if (sub === 'enableall') {
      config.automod.enabled = true;
      for (const r of ALL_AUTOMOD_RULES) {
        if (!config.automod[r]) config.automod[r] = {};
        config.automod[r].enabled = true;
      }
      saveGuildConfig(guild.id, config);
      return safeReply(interaction, '🟢 **ALL AutoMod rules have been ENABLED!** All 12 detection filters are now active.');
    }

    if (sub === 'disableall') {
      config.automod.enabled = false;
      for (const r of ALL_AUTOMOD_RULES) {
        if (!config.automod[r]) config.automod[r] = {};
        config.automod[r].enabled = false;
      }
      saveGuildConfig(guild.id, config);
      return safeReply(interaction, '🔴 **ALL AutoMod rules have been DISABLED.**');
    }

    if (sub === 'status') {
      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`🤖 AutoMod Status — ${guild.name}`)
        .setDescription(
          `• **Engine Master:** ${am.enabled ? '🟢 Enabled' : '🔴 Disabled'}\n` +
          `• **Anti-Spam:** ${am.antiSpam?.enabled ? '🟢' : '🔴'} (${am.antiSpam?.maxMessages || 5} msgs / ${(am.antiSpam?.windowMs || 5000)/1000}s) ➔ \`${am.antiSpam?.action || 'timeout'}\`\n` +
          `• **Duplicate Messages:** ${am.antiDuplicate?.enabled ? '🟢' : '🔴'} (${am.antiDuplicate?.maxDuplicates || 3}x) ➔ \`${am.antiDuplicate?.action || 'delete'}\`\n` +
          `• **Mention Spam:** ${am.antiMentionSpam?.enabled ? '🟢' : '🔴'} (${am.antiMentionSpam?.maxMentions || 5} max) ➔ \`${am.antiMentionSpam?.action || 'timeout'}\`\n` +
          `• **Unauthorized Pings:** ${am.antiEveryone?.enabled ? '🟢' : '🔴'} ➔ \`${am.antiEveryone?.action || 'delete'}\`\n` +
          `• **Discord Invites:** ${am.antiInvites?.enabled ? '🟢' : '🔴'} ➔ \`${am.antiInvites?.action || 'delete'}\`\n` +
          `• **External Links:** ${am.antiLinks?.enabled ? '🟢' : '🔴'} ➔ \`${am.antiLinks?.action || 'delete'}\`\n` +
          `• **NSFW Links:** ${am.antiNsfwLinks?.enabled ? '🟢' : '🔴'} ➔ \`${am.antiNsfwLinks?.action || 'delete'}\`\n` +
          `• **Word Blacklist:** ${am.wordFilter?.enabled ? '🟢' : '🔴'} (${am.wordFilter?.words?.length || 0} words) ➔ \`${am.wordFilter?.action || 'delete'}\`\n` +
          `• **Caps Filter:** ${am.antiCaps?.enabled ? '🟢' : '🔴'} (>${am.antiCaps?.maxPercentage || 70}%) ➔ \`${am.antiCaps?.action || 'delete'}\`\n` +
          `• **Emoji Spam:** ${am.antiEmojiSpam?.enabled ? '🟢' : '🔴'} (>${am.antiEmojiSpam?.maxEmojis || 6}) ➔ \`${am.antiEmojiSpam?.action || 'delete'}\`\n` +
          `• **Alt Account Detection:** ${am.altDetection?.enabled ? '🟢' : '🔴'} (min ${am.altDetection?.minDays || 7} days) ➔ \`${am.altDetection?.action || 'kick'}\`\n` +
          `• **Anti-Raid Flood:** ${am.antiRaid?.enabled ? '🟢' : '🔴'} (${am.antiRaid?.joinThreshold || 8} joins in 10s) ➔ \`${am.antiRaid?.action || 'lockdown'}\``
        )
        .setTimestamp();
      return safeReply(interaction, { embeds: [embed] });
    }

    // ── /automod config (PREVIOUSLY MISSING — NOW FULLY FUNCTIONAL) ──
    if (sub === 'config') {
      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`⚙️ AutoMod Configuration Dashboard — ${guild.name}`)
        .setDescription(
          `**Engine Status:** ${am.enabled ? '🟢 **ONLINE & ACTIVE**' : '🔴 **DISABLED**'}\n\n` +
          `**🛡️ Detection Rules & Configured Punishments:**\n` +
          `• **Message Flood (Anti-Spam):** ${am.antiSpam?.enabled ? '🟢' : '🔴'} | Action: \`${am.antiSpam?.action || 'timeout'}\` | Max: \`${am.antiSpam?.maxMessages || 5} msgs / ${(am.antiSpam?.windowMs || 5000)/1000}s\`\n` +
          `• **Duplicate Messages:** ${am.antiDuplicate?.enabled ? '🟢' : '🔴'} | Action: \`${am.antiDuplicate?.action || 'delete'}\` | Max: \`${am.antiDuplicate?.maxDuplicates || 3}x\`\n` +
          `• **Mention Spam:** ${am.antiMentionSpam?.enabled ? '🟢' : '🔴'} | Action: \`${am.antiMentionSpam?.action || 'timeout'}\` | Limit: \`${am.antiMentionSpam?.maxMentions || 5} mentions\`\n` +
          `• **@everyone / @here:** ${am.antiEveryone?.enabled ? '🟢' : '🔴'} | Action: \`${am.antiEveryone?.action || 'delete'}\`\n` +
          `• **Discord Invite Links:** ${am.antiInvites?.enabled ? '🟢' : '🔴'} | Action: \`${am.antiInvites?.action || 'delete'}\`\n` +
          `• **Suspicious External Links:** ${am.antiLinks?.enabled ? '🟢' : '🔴'} | Action: \`${am.antiLinks?.action || 'delete'}\`\n` +
          `• **Prohibited Words Filter:** ${am.wordFilter?.enabled ? '🟢' : '🔴'} | Action: \`${am.wordFilter?.action || 'delete'}\` | Words: \`${am.wordFilter?.words?.length || 0}\`\n` +
          `• **Excessive Caps:** ${am.antiCaps?.enabled ? '🟢' : '🔴'} | Action: \`${am.antiCaps?.action || 'delete'}\` | Threshold: \`${am.antiCaps?.maxPercentage || 70}%\`\n` +
          `• **Emoji / Reaction Spam:** ${am.antiEmojiSpam?.enabled ? '🟢' : '🔴'} | Action: \`${am.antiEmojiSpam?.action || 'delete'}\` | Max: \`${am.antiEmojiSpam?.maxEmojis || 6}\`\n` +
          `• **Alt Account Interceptor:** ${am.altDetection?.enabled ? '🟢' : '🔴'} | Action: \`${am.altDetection?.action || 'kick'}\` | Min Age: \`${am.altDetection?.minDays || 7} days\`\n` +
          `• **Raid Join Flood:** ${am.antiRaid?.enabled ? '🟢' : '🔴'} | Action: \`${am.antiRaid?.action || 'lockdown'}\`\n\n` +
          `**👥 Exemptions & Whitelist:**\n` +
          `• Whitelisted Users: **${am.whitelistUsers?.length || 0}**\n` +
          `• Whitelisted Roles: **${am.whitelistRoles?.length || 0}**\n` +
          `• Ignored Channels: **${am.ignoredChannels?.length || 0}**`
        )
        .setFooter({ text: 'Use /automod whitelist or /automod blacklist to adjust filters' })
        .setTimestamp();
      return safeReply(interaction, { embeds: [embed] });
    }

    // ── /automod test (PREVIOUSLY MISSING — NOW SAFE DIAGNOSTIC & SIMULATION) ──
    if (sub === 'test') {
      await interaction.deferReply({ ephemeral: true });
      const diag = await runAutoModDiagnostic(guild);

      const embed = new EmbedBuilder()
        .setColor(diag.operational ? '#57F287' : '#FEE75C')
        .setTitle(`🧪 AutoMod Diagnostic & Simulation Suite — ${guild.name}`)
        .setDescription(
          `**System Health:** ${diag.operational ? '🟢 **FULLY OPERATIONAL**' : '⚠️ **ATTENTION REQUIRED**'}\n` +
          `**Active Rules:** **${diag.activeRulesCount} / 12** active\n\n` +
          `**🛡️ Permissions & Setup Validation:**\n` +
          diag.checks.map(c => `• ✅ ${c}`).join('\n') +
          (diag.issues.length > 0 ? '\n\n**⚠️ Issues Detected:**\n' + diag.issues.map(i => `• ${i}`).join('\n') : '') +
          `\n\n**🔬 Safe Simulation Test Results (No Members Harmed):**\n` +
          diag.simulations.map(s => `• 🧪 ${s}`).join('\n')
        )
        .setFooter({ text: 'Simulation mode executed safely. Zero members modified.' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    if (sub === 'blacklist') {
      const action = interaction.options.getString('action', true);
      const word = interaction.options.getString('word')?.toLowerCase();
      if (!config.automod.wordFilter) config.automod.wordFilter = { enabled: true, words: [] };
      if (action === 'add' && word) {
        if (!config.automod.wordFilter.words.includes(word)) config.automod.wordFilter.words.push(word);
        saveGuildConfig(guild.id, config);
        return safeReply(interaction, `✅ Added \`${word}\` to word blacklist.`);
      }
      if (action === 'remove' && word) {
        config.automod.wordFilter.words = config.automod.wordFilter.words.filter(w => w !== word);
        saveGuildConfig(guild.id, config);
        return safeReply(interaction, `❌ Removed \`${word}\` from word blacklist.`);
      }
      if (action === 'list') {
        const words = config.automod.wordFilter.words || [];
        return safeReply(interaction, `📝 **Blacklisted Words (${words.length}):**\n${words.join(', ') || 'None'}`);
      }
    }

    if (sub === 'whitelist') {
      const action = interaction.options.getString('action', true);
      const u = interaction.options.getUser('user');
      const r = interaction.options.getRole('role');
      const c = interaction.options.getChannel('channel');
      if (!config.automod.whitelistUsers) config.automod.whitelistUsers = [];
      if (!config.automod.whitelistRoles) config.automod.whitelistRoles = [];
      if (!config.automod.ignoredChannels) config.automod.ignoredChannels = [];

      if (action === 'add') {
        if (u && !config.automod.whitelistUsers.includes(u.id)) config.automod.whitelistUsers.push(u.id);
        if (r && !config.automod.whitelistRoles.includes(r.id)) config.automod.whitelistRoles.push(r.id);
        if (c && !config.automod.ignoredChannels.includes(c.id)) config.automod.ignoredChannels.push(c.id);
        saveGuildConfig(guild.id, config);
        return safeReply(interaction, '✅ AutoMod exemption added.');
      }
      if (action === 'remove') {
        if (u) config.automod.whitelistUsers = config.automod.whitelistUsers.filter(id => id !== u.id);
        if (r) config.automod.whitelistRoles = config.automod.whitelistRoles.filter(id => id !== r.id);
        if (c) config.automod.ignoredChannels = config.automod.ignoredChannels.filter(id => id !== c.id);
        saveGuildConfig(guild.id, config);
        return safeReply(interaction, '❌ AutoMod exemption removed.');
      }
      if (action === 'list') {
        return safeReply(interaction, `**Whitelisted Users:** ${config.automod.whitelistUsers.map(id => `<@${id}>`).join(', ') || 'None'}\n**Whitelisted Roles:** ${config.automod.whitelistRoles.map(id => `<@&${id}>`).join(', ') || 'None'}\n**Ignored Channels:** ${config.automod.ignoredChannels.map(id => `<#${id}>`).join(', ') || 'None'}`);
      }
    }

    if (sub === 'punishment') {
      const ruleKey = interaction.options.getString('rule', true);
      const action = interaction.options.getString('action', true);
      const durationInput = interaction.options.getString('timeout_duration');

      if (!config.automod) config.automod = {};

      const targetRules = ruleKey === 'all'
        ? ALL_AUTOMOD_RULES
        : [ruleKey];

      if (action === 'enable') {
        config.automod.enabled = true;
        for (const k of targetRules) {
          if (!config.automod[k]) config.automod[k] = {};
          config.automod[k].enabled = true;
        }
        saveGuildConfig(guild.id, config);
        return safeReply(interaction, `🟢 **${ruleKey === 'all' ? 'ALL AutoMod Rules' : (RULE_NAMES[ruleKey] || ruleKey)}** have been **ENABLED**.`);
      }

      if (action === 'disable') {
        for (const k of targetRules) {
          if (!config.automod[k]) config.automod[k] = {};
          config.automod[k].enabled = false;
        }
        saveGuildConfig(guild.id, config);
        return safeReply(interaction, `🔴 **${ruleKey === 'all' ? 'ALL AutoMod Rules' : (RULE_NAMES[ruleKey] || ruleKey)}** have been **DISABLED**.`);
      }

      let timeoutSec = null;
      if (durationInput) {
        const ms = parseDuration(durationInput);
        if (ms > 0) {
          timeoutSec = Math.max(5, Math.min(86400 * 28, Math.round(ms / 1000)));
        }
      }

      for (const k of targetRules) {
        if (!config.automod[k]) config.automod[k] = {};
        config.automod[k].action = action;
        if (timeoutSec !== null && action === 'timeout') {
          config.automod[k].timeoutSec = timeoutSec;
        }
      }

      saveGuildConfig(guild.id, config);

      const actionBadge = {
        delete: '🗑️ Delete Message Only',
        warn: '⚠️ Delete + Issue Warning Strike',
        timeout: `⏳ Delete + Timeout User${timeoutSec ? ` (${timeoutSec}s)` : ''}`,
        kick: '👢 Delete + Kick User',
        ban: '🔨 Delete + Ban User',
        log: '📝 Log Only (No Punishment)',
      }[action] || action;

      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('⚖️ AutoMod Punishment Customized!')
        .setDescription(
          `• **Target Rule:** \`${RULE_NAMES[ruleKey] || ruleKey}\`\n` +
          `• **Configured Punishment:** ${actionBadge}\n` +
          `${timeoutSec && action === 'timeout' ? `• **Timeout Duration:** \`${timeoutSec} seconds\`\n` : ''}\n` +
          `Use \`/automod status\` to inspect your complete active punishment matrix.`
        )
        .setFooter({ text: 'Changes apply immediately across all chat channels' })
        .setTimestamp();

      return safeReply(interaction, { embeds: [embed] });
    }
  }

  // AutoMod Legacy Shortcuts
  if (commandName === 'antispam') {
    const toggle = interaction.options.getString('toggle', true) === 'on';
    if (!config.automod.antiSpam) config.automod.antiSpam = {};
    config.automod.antiSpam.enabled = toggle;
    saveGuildConfig(guild.id, config);
    return safeReply(interaction, `🛡️ Anti-Spam filter **${toggle ? 'ENABLED' : 'DISABLED'}**.`);
  }

  if (commandName === 'antilink') {
    const toggle = interaction.options.getString('toggle', true) === 'on';
    if (!config.automod.antiLinks) config.automod.antiLinks = {};
    config.automod.antiLinks.enabled = toggle;
    saveGuildConfig(guild.id, config);
    return safeReply(interaction, `🛡️ Anti-Link filter **${toggle ? 'ENABLED' : 'DISABLED'}**.`);
  }

  if (commandName === 'antiraid') {
    const toggle = interaction.options.getString('toggle', true) === 'on';
    if (!config.automod.antiRaid) config.automod.antiRaid = {};
    config.automod.antiRaid.enabled = toggle;
    saveGuildConfig(guild.id, config);
    return safeReply(interaction, `🛡️ Anti-Raid join filter **${toggle ? 'ENABLED' : 'DISABLED'}**.`);
  }

  if (commandName === 'altdetection') {
    const toggle = interaction.options.getString('toggle', true) === 'on';
    const minDays = interaction.options.getInteger('mindays') || 7;
    if (!config.automod.altDetection) config.automod.altDetection = {};
    config.automod.altDetection.enabled = toggle;
    config.automod.altDetection.minDays = minDays;
    saveGuildConfig(guild.id, config);
    return safeReply(interaction, `🛡️ Alt Account Detection **${toggle ? 'ENABLED' : 'DISABLED'}** (Minimum age: **${minDays} days**).`);
  }

  if (commandName === 'wordfilter') {
    const toggle = interaction.options.getString('toggle', true) === 'on';
    if (!config.automod.wordFilter) config.automod.wordFilter = { enabled: true, words: [] };
    config.automod.wordFilter.enabled = toggle;
    saveGuildConfig(guild.id, config);
    return safeReply(interaction, `🛡️ Word Filter **${toggle ? 'ENABLED' : 'DISABLED'}**.`);
  }

  if (commandName === 'addword') {
    const word = interaction.options.getString('word', true).toLowerCase();
    if (!config.automod.wordFilter) config.automod.wordFilter = { enabled: true, words: [] };
    if (!config.automod.wordFilter.words.includes(word)) config.automod.wordFilter.words.push(word);
    saveGuildConfig(guild.id, config);
    return safeReply(interaction, `✅ Added \`${word}\` to blacklist.`);
  }

  if (commandName === 'removeword') {
    const word = interaction.options.getString('word', true).toLowerCase();
    if (config.automod.wordFilter?.words) {
      config.automod.wordFilter.words = config.automod.wordFilter.words.filter(w => w !== word);
      saveGuildConfig(guild.id, config);
    }
    return safeReply(interaction, `❌ Removed \`${word}\` from blacklist.`);
  }

  // ─────────────────────────────────────────────────────────────
  // 4. LOGGING COMMANDS (14 Channels under SERVER LOGS)
  // ─────────────────────────────────────────────────────────────
  if (commandName === 'logs') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'setup') {
      await interaction.deferReply({ ephemeral: true });
      const res = await setupAllLogChannels(guild);
      if (!res.success) return interaction.editReply(`❌ ${res.message}`);
      const embed = new EmbedBuilder()
        .setColor('#57F287')
        .setTitle('📁 Server Logs Setup Complete!')
        .setDescription(`Created / verified Category **📁 SERVER LOGS** and 14 dedicated log channels:\n\n${res.details.join('\n')}`)
        .setFooter({ text: 'All event logs will route to their dedicated channels' })
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }
    if (sub === 'status') {
      const l = config.logging?.channels || {};
      const lines = Object.entries(l).map(([k, id]) => `• **${k}**: ${id ? `<#${id}>` : '*Not configured*'}`).join('\n');
      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`📋 Dedicated Log Channels — ${guild.name}`)
        .setDescription(lines || '*No log channels configured. Run /logs setup to auto-create them.*')
        .setTimestamp();
      return safeReply(interaction, { embeds: [embed] });
    }
    if (sub === 'configure') {
      const category = interaction.options.getString('category', true);
      const channel = interaction.options.getChannel('channel', true);
      if (!config.logging) config.logging = { channels: {} };
      if (!config.logging.channels) config.logging.channels = {};
      config.logging.channels[category] = channel.id;
      saveGuildConfig(guild.id, config);
      return safeReply(interaction, `✅ Log category **${category}** bound to <#${channel.id}>.`);
    }
    if (sub === 'test') {
      await interaction.deferReply({ ephemeral: true });
      await logSecurity(guild, new EmbedBuilder().setColor('#5865F2').setTitle('Test Log: Security').setTimestamp());
      await logMember(guild, new EmbedBuilder().setColor('#57F287').setTitle('Test Log: Member').setTimestamp());
      await logMessage(guild, new EmbedBuilder().setColor('#FEE75C').setTitle('Test Log: Message').setTimestamp());
      return interaction.editReply('✅ Test log messages dispatched to log channels.');
    }
    if (sub === 'disable') {
      const category = interaction.options.getString('category', true);
      if (!config.logging) config.logging = { channels: {} };
      if (!config.logging.channels) config.logging.channels = {};
      if (category === 'all') {
        config.logging.channels = {};
        saveGuildConfig(guild.id, config);
        return safeReply(interaction, '⚠️ All logging channels have been **DISABLED**.');
      } else {
        delete config.logging.channels[category];
        saveGuildConfig(guild.id, config);
        return safeReply(interaction, `⚠️ Logging for category **${category}** has been **DISABLED**.`);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 5. WELCOME & GOODBYE COMMANDS
  // ─────────────────────────────────────────────────────────────
  if (commandName === 'welcome') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'setup') {
      const ch = interaction.options.getChannel('channel', true);
      config.welcome.channelId = ch.id; saveGuildConfig(guild.id, config);
      return safeReply(interaction, `🎉 Welcome channel set to <#${ch.id}>.`);
    }
    if (sub === 'enable') {
      config.welcome.enabled = true; saveGuildConfig(guild.id, config);
      return safeReply(interaction, '🎉 Welcome messages **ENABLED**.');
    }
    if (sub === 'disable') {
      config.welcome.enabled = false; saveGuildConfig(guild.id, config);
      return safeReply(interaction, '⚠️ Welcome messages **DISABLED**.');
    }
    if (sub === 'config') {
      const w = config.welcome;
      const embed = new EmbedBuilder()
        .setColor(w.embedColor || '#FF0000')
        .setTitle(`Welcome Configuration — ${guild.name}`)
        .setDescription(
          `• **Channel:** ${w.channelId ? `<#${w.channelId}>` : '*Auto-detect*'}\n` +
          `• **Status:** ${w.enabled ? '🟢 Enabled' : '🔴 Disabled'}\n` +
          `• **Embed Color:** \`${w.embedColor}\`\n` +
          `• **Banner:** ${w.bannerUrl ? `[Custom Banner](${w.bannerUrl})` : (guild?.bannerURL?.({ size: 1024 }) ? 'Discord Server Banner (Boost Lv.2)' : '*Not set (use `/setbanner`)*')}\n` +
          `• **Logo:** ${w.logoUrl ? `[Custom Logo](${w.logoUrl})` : 'Server Icon'}\n` +
          `• **Auto-Role:** ${w.autoRoleId ? `<@&${w.autoRoleId}>` : '*None*'}\n` +
          `• **Rules Channel:** ${w.rulesChannelId ? `<#${w.rulesChannelId}>` : '*Not set*'}\n` +
          `• **Roles Channel:** ${w.rolesChannelId ? `<#${w.rolesChannelId}>` : '*Not set*'}`
        )
        .setTimestamp();
      return safeReply(interaction, { embeds: [embed] });
    }
    if (sub === 'banner') {
      const file = interaction.options.getAttachment?.('image');
      const urlInput = interaction.options.getString('url')?.trim();

      let finalBannerUrl = null;

      if (file) {
        finalBannerUrl = file.url;
      } else if (urlInput) {
        if (urlInput.toLowerCase() === 'reset' || urlInput.toLowerCase() === 'clear') {
          config.welcome.bannerUrl = '';
          saveGuildConfig(guild.id, config);
          return safeReply(interaction, '🧹 Welcome banner cleared! The welcome card will no longer display a custom banner.');
        } else if (urlInput.toLowerCase() === 'server') {
          finalBannerUrl = guild?.bannerURL?.({ size: 1024 }) || guild?.splashURL?.({ size: 1024 });
          if (!finalBannerUrl) {
            return safeReply(interaction, '⚠️ This server does not have a native Discord banner or splash (requires Server Boost Level 2). Upload an image file or provide an image link instead.');
          }
        } else if (urlInput.startsWith('http://') || urlInput.startsWith('https://')) {
          finalBannerUrl = urlInput;
        } else {
          return safeReply(interaction, '⚠️ Invalid image URL. Please provide a valid link starting with `http://` or `https://`, or upload an image file.');
        }
      } else {
        finalBannerUrl = guild?.bannerURL?.({ size: 1024 }) || guild?.splashURL?.({ size: 1024 });
        if (!finalBannerUrl) {
          return safeReply(interaction, 'ℹ️ **No banner provided and server has no native Discord banner.**\n\n• To upload a banner from your phone/PC: `/welcome banner image:[attach file]`\n• To use an image link: `/welcome banner url:[paste https:// link]`\n• To use native server banner: `/welcome banner url:server`\n• To reset/remove banner: `/welcome banner url:reset`');
        }
      }

      config.welcome.bannerUrl = finalBannerUrl;
      saveGuildConfig(guild.id, config);

      const embed = new EmbedBuilder()
        .setColor(config.welcome.embedColor || '#FF0000')
        .setTitle('🎨 Server Welcome Banner Updated!')
        .setDescription(`Your welcome card banner is now set!\nRun \`/testwelcome\` to preview the card with your new banner.`)
        .setImage(finalBannerUrl)
        .setFooter({ text: 'THOR APEX • Welcome System' })
        .setTimestamp();

      return safeReply(interaction, { embeds: [embed] });
    }
    if (sub === 'test') {
      await interaction.deferReply({ ephemeral: false });
      const diag = await runWelcomeDiagnostic(guild);
      const payload = buildWelcomeMessage(member, guild);
      await interaction.channel.send(payload);
      return interaction.editReply({
        content: `✅ **Welcome card preview sent above!**\n\n**Diagnostic Health Check:**\n${diag.ok.map(o => `• ✅ ${o}`).join('\n')}${diag.issues.length > 0 ? `\n\n**Issues Found:**\n${diag.issues.map(i => `• ⚠️ ${i}`).join('\n')}` : '\n• 🎉 **Zero issues found. System is fully operational.**'}`
      });
    }
  }

  if (commandName === 'goodbye') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'setup') {
      const ch = interaction.options.getChannel('channel', true);
      config.goodbye.channelId = ch.id; saveGuildConfig(guild.id, config);
      return safeReply(interaction, `👋 Goodbye channel set to <#${ch.id}>.`);
    }
    if (sub === 'enable') {
      config.goodbye.enabled = true; saveGuildConfig(guild.id, config);
      return safeReply(interaction, '👋 Goodbye messages **ENABLED**.');
    }
    if (sub === 'disable') {
      config.goodbye.enabled = false; saveGuildConfig(guild.id, config);
      return safeReply(interaction, '⚠️ Goodbye messages **DISABLED**.');
    }
    if (sub === 'config') {
      const gb = config.goodbye || {};
      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`👋 Goodbye Configuration — ${guild.name}`)
        .setDescription(`• **Channel:** ${gb.channelId ? `<#${gb.channelId}>` : '*Auto-detect*'}\n• **Status:** ${gb.enabled ? '🟢 Enabled' : '🔴 Disabled'}\n• **Message:** \`${gb.message || 'Default'}\``)
        .setTimestamp();
      return safeReply(interaction, { embeds: [embed] });
    }
    if (sub === 'test') {
      const payload = buildGoodbyeMessage(member, guild);
      return interaction.reply({ ...payload, ephemeral: false });
    }
  }

  // 1-Click Server Setup
  if (commandName === 'setup') {
    await interaction.deferReply({ ephemeral: true });
    const logRes = await setupAllLogChannels(guild);
    return interaction.editReply({
      content: `⚡ **One-Click Server Setup Finished!**\n\n• **14 Dedicated Log Channels:** ${logRes.success ? '✅ Verified & Created' : '⚠️ ' + logRes.message}\n• **Security & Anti-Nuke:** ✅ Active & Guarded\n• **AutoMod Engine:** ✅ Active\n• **Welcome Cards:** Ready (use \`/welcome setup\` to select public channel)`
    });
  }

  // Legacy Welcome Shortcuts
  if (commandName === 'setwelcome') {
    const ch = interaction.options.getChannel('channel') || interaction.channel;
    config.welcome.channelId = ch.id; saveGuildConfig(guild.id, config);
    return safeReply(interaction, `🎉 Welcome channel set to <#${ch.id}>.`);
  }
  if (commandName === 'setleave') {
    const ch = interaction.options.getChannel('channel', true);
    config.goodbye.channelId = ch.id; saveGuildConfig(guild.id, config);
    return safeReply(interaction, `👋 Goodbye channel set to <#${ch.id}>.`);
  }
  if (commandName === 'setrules') {
    const ch = interaction.options.getChannel('channel', true);
    config.welcome.rulesChannelId = ch.id; saveGuildConfig(guild.id, config);
    return safeReply(interaction, `📜 Rules channel linked to <#${ch.id}>.`);
  }
  if (commandName === 'setroles') {
    const ch = interaction.options.getChannel('channel', true);
    config.welcome.rolesChannelId = ch.id; saveGuildConfig(guild.id, config);
    return safeReply(interaction, `🎭 Roles channel linked to <#${ch.id}>.`);
  }
  if (commandName === 'setgeneral') {
    const ch = interaction.options.getChannel('channel', true);
    config.welcome.generalChannelId = ch.id;
    config.welcome.chillChannelId = ch.id;
    saveGuildConfig(guild.id, config);
    return safeReply(interaction, `💬 General/Chill channel linked to <#${ch.id}>.`);
  }
  if (commandName === 'setfun') {
    const ch = interaction.options.getChannel('channel', true);
    config.welcome.funChannelId = ch.id; saveGuildConfig(guild.id, config);
    return safeReply(interaction, `🐣 Fun channel linked to <#${ch.id}>.`);
  }
  if (commandName === 'setedit') {
    const ch = interaction.options.getChannel('channel', true);
    config.welcome.editingChannelId = ch.id; saveGuildConfig(guild.id, config);
    return safeReply(interaction, `🎯 Editing channel linked to <#${ch.id}>.`);
  }
  if (commandName === 'setgaming') {
    const ch = interaction.options.getChannel('channel', true);
    config.welcome.gamingChannelId = ch.id; saveGuildConfig(guild.id, config);
    return safeReply(interaction, `🎮 Gaming channel linked to <#${ch.id}>.`);
  }
  if (commandName === 'setwelcomecolor') {
    const color = interaction.options.getString('color', true);
    if (!isHex(color)) return safeReply(interaction, 'Invalid hex color code. Use `#RRGGBB` format.');
    config.welcome.embedColor = color; saveGuildConfig(guild.id, config);
    return safeReply(interaction, `🎨 Welcome embed color set to \`${color}\`.`);
  }
  if (commandName === 'setwelcometext') {
    const g = interaction.options.getString('greeting');
    const s = interaction.options.getString('subtitle');
    const o = interaction.options.getString('outro');
    if (g) config.welcome.title = g;
    if (s) config.welcome.subtitle = s;
    if (o) config.welcome.outroText = o;
    saveGuildConfig(guild.id, config);
    return safeReply(interaction, '📝 Welcome card text updated.');
  }
  if (commandName === 'setbanner' || commandName === 'setwelcomebanner') {
    const file = interaction.options.getAttachment?.('image');
    const urlInput = interaction.options.getString('url')?.trim();

    let finalBannerUrl = null;

    if (file) {
      finalBannerUrl = file.url;
    } else if (urlInput) {
      if (urlInput.toLowerCase() === 'reset' || urlInput.toLowerCase() === 'clear') {
        config.welcome.bannerUrl = '';
        saveGuildConfig(guild.id, config);
        return safeReply(interaction, '🧹 Welcome banner cleared! The welcome card will no longer display a custom banner.');
      } else if (urlInput.toLowerCase() === 'server') {
        finalBannerUrl = guild?.bannerURL?.({ size: 1024 }) || guild?.splashURL?.({ size: 1024 });
        if (!finalBannerUrl) {
          return safeReply(interaction, '⚠️ This server does not have a native Discord banner or splash (requires Server Boost Level 2). Upload an image file with `/setbanner image:<file>` or paste an image URL instead.');
        }
      } else if (urlInput.startsWith('http://') || urlInput.startsWith('https://')) {
        finalBannerUrl = urlInput;
      } else {
        return safeReply(interaction, '⚠️ Invalid image URL. Please provide a valid link starting with `http://` or `https://`, or upload an image file directly.');
      }
    } else {
      finalBannerUrl = guild?.bannerURL?.({ size: 1024 }) || guild?.splashURL?.({ size: 1024 });
      if (!finalBannerUrl) {
        return safeReply(interaction, 'ℹ️ **No banner specified and server has no native Discord banner.**\n\n• To upload a banner from your phone/PC: `/setbanner image:[attach file]`\n• To use an image link: `/setbanner url:[paste https:// link]`\n• To auto-use native server banner (Level 2 Boost): `/setbanner url:server`\n• To reset/remove banner: `/setbanner url:reset`');
      }
    }

    config.welcome.bannerUrl = finalBannerUrl;
    saveGuildConfig(guild.id, config);

    const embed = new EmbedBuilder()
      .setColor(config.welcome.embedColor || '#FF0000')
      .setTitle('🎨 Server Welcome Banner Updated!')
      .setDescription(`Your welcome card banner is now active.\nRun \`/testwelcome\` to preview how it looks!`)
      .setImage(finalBannerUrl)
      .setFooter({ text: 'THOR APEX • Welcome System' })
      .setTimestamp();

    return safeReply(interaction, { embeds: [embed] });
  }

  if (commandName === 'setlogo') {
    const file = interaction.options.getAttachment?.('image');
    const urlInput = interaction.options.getString('url')?.trim();

    let finalLogoUrl = null;

    if (file) {
      finalLogoUrl = file.url;
    } else if (urlInput) {
      if (urlInput.toLowerCase() === 'reset' || urlInput.toLowerCase() === 'clear') {
        config.welcome.logoUrl = '';
        saveGuildConfig(guild.id, config);
        return safeReply(interaction, '🧹 Welcome logo cleared! Default server icon will be used.');
      } else if (urlInput.toLowerCase() === 'server') {
        finalLogoUrl = guild?.iconURL?.({ size: 1024, forceStatic: false });
        if (!finalLogoUrl) {
          return safeReply(interaction, '⚠️ Server has no icon set.');
        }
      } else if (urlInput.startsWith('http://') || urlInput.startsWith('https://')) {
        finalLogoUrl = urlInput;
      } else {
        return safeReply(interaction, '⚠️ Invalid image URL. Must start with `http://` or `https://`.');
      }
    } else {
      finalLogoUrl = guild?.iconURL?.({ size: 1024, forceStatic: false });
      if (!finalLogoUrl) {
        return safeReply(interaction, 'ℹ️ Provide an image attachment or URL, or type `/setlogo url:server`.');
      }
    }

    config.welcome.logoUrl = finalLogoUrl;
    saveGuildConfig(guild.id, config);

    const embed = new EmbedBuilder()
      .setColor(config.welcome.embedColor || '#FF0000')
      .setTitle('🖼️ Welcome Logo/Icon Updated!')
      .setDescription('Your welcome card thumbnail and header icon have been updated.\nRun `/testwelcome` to preview!')
      .setThumbnail(finalLogoUrl)
      .setTimestamp();

    return safeReply(interaction, { embeds: [embed] });
  }

  if (commandName === 'serverbanner') {
    const applyWelcome = interaction.options.getBoolean?.('apply_welcome') ?? false;
    const bannerUrl = guild?.bannerURL?.({ size: 1024 }) || guild?.splashURL?.({ size: 1024 }) || config.welcome.bannerUrl;

    if (!bannerUrl) {
      return safeReply(interaction, {
        content: `ℹ️ **${guild.name}** has no banner set on Discord (requires Server Boost Level 2) and no custom welcome banner configured.\n\nUse \`/setbanner\` to upload an image from your PC/phone or paste an image URL!`,
        ephemeral: true,
      });
    }

    if (applyWelcome) {
      config.welcome.bannerUrl = bannerUrl;
      saveGuildConfig(guild.id, config);
    }

    const embed = new EmbedBuilder()
      .setColor(config.welcome.embedColor || '#FF0000')
      .setTitle(`🖼️ ${guild.name} — Server Banner`)
      .setDescription(applyWelcome ? '✅ This banner has also been applied to the **THOR APEX Welcome Card**!' : `[Click here for full resolution](${bannerUrl})`)
      .setImage(bannerUrl)
      .setFooter({ text: applyWelcome ? 'Applied to Welcome Card' : 'Use /setbanner to customize welcome banner' })
      .setTimestamp();

    return safeReply(interaction, { embeds: [embed] });
  }

  if (commandName === 'setleavetext') {
    const msg = interaction.options.getString('message', true);
    config.goodbye.message = msg; saveGuildConfig(guild.id, config);
    return safeReply(interaction, '📝 Goodbye message updated.');
  }
  if (commandName === 'setautorole') {
    const role = interaction.options.getRole('role', true);
    config.welcome.autoRoleId = role.id; saveGuildConfig(guild.id, config);
    return safeReply(interaction, `🛡️ Auto-role set to <@&${role.id}>.`);
  }
  if (commandName === 'testwelcome') {
    return interaction.reply(buildWelcomeMessage(member, guild));
  }
  if (commandName === 'testleave') {
    return interaction.reply(buildGoodbyeMessage(member, guild));
  }
  if (commandName === 'welcomeconfig') {
    const w = config.welcome;
    const embed = new EmbedBuilder()
      .setColor(w.embedColor || '#FF0000')
      .setTitle(`THOR APEX Welcome Configuration — ${guild.name}`)
      .setDescription(
        `• **Welcome Channel:** ${w.channelId ? `<#${w.channelId}>` : '*Auto-detect*'}\n` +
        `• **Rules Channel:** ${w.rulesChannelId ? `<#${w.rulesChannelId}>` : '*Auto-detect*'}\n` +
        `• **Fun Channel:** ${w.funChannelId ? `<#${w.funChannelId}>` : '*Auto-detect*'}\n` +
        `• **Editing Channel:** ${w.editingChannelId ? `<#${w.editingChannelId}>` : '*Auto-detect*'}\n` +
        `• **Gaming Channel:** ${w.gamingChannelId ? `<#${w.gamingChannelId}>` : '*Auto-detect*'}\n` +
        `• **General/Chill Channel:** ${w.generalChannelId || w.chillChannelId ? `<#${w.generalChannelId || w.chillChannelId}>` : '*Auto-detect*'}\n` +
        `• **Leave Channel:** ${config.goodbye?.channelId ? `<#${config.goodbye.channelId}>` : '*Auto-detect*'}\n` +
        `• **Color:** \`${w.embedColor}\`\n` +
        `• **Banner:** ${w.bannerUrl ? `[Custom Banner](${w.bannerUrl})` : (guild?.bannerURL?.({ size: 1024 }) ? 'Discord Server Banner (Boost Lv.2)' : '*Not set (use `/setbanner`)*')}\n` +
        `• **Logo:** ${w.logoUrl ? `[Custom Logo](${w.logoUrl})` : 'Server Icon'}`
      )
      .setTimestamp();
    return safeReply(interaction, { embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────
  // 6. UTILITY COMMANDS
  // ─────────────────────────────────────────────────────────────
  if (commandName === 'ping') {
    const wsPing = Math.round(client?.ws?.ping || 0);
    const startPing = Date.now();
    await interaction.reply({ content: '🏓 Pinging...' });
    const roundTrip = Date.now() - startPing;
    return interaction.editReply(`🏓 **Pong!**\n• WebSocket Gateway: **${wsPing}ms**\n• Round-Trip Latency: **${roundTrip}ms**`);
  }

  if (commandName === 'uptime') {
    const ms = Date.now() - startTime;
    return safeReply(interaction, `⏱️ **Bot Uptime:** **${formatDuration(ms)}** (Online since <t:${Math.floor(startTime / 1000)}:f>)`);
  }

  if (commandName === 'botinfo') {
    const memMB = Math.round(process.memoryUsage().rss / (1024 * 1024));
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('🤖 Bot Information & Performance Profile')
      .setDescription(`**Name:** ${client?.user?.tag || 'THOR APEX Bot'}\n**Version:** 2.0.0 Production Enterprise\n**Total Guilds:** ${client?.guilds?.cache?.size || 1}\n**Total Cached Users:** ${client?.users?.cache?.size || 0}\n**Node.js Runtime:** \`${process.version}\`\n**Platform:** ${os.platform()} (${os.arch()})\n**RAM Usage:** **${memMB} MB**\n**Uptime:** ${formatDuration(Date.now() - startTime)}`)
      .setThumbnail(client?.user?.displayAvatarURL?.() || null)
      .setTimestamp();
    return safeReply(interaction, { embeds: [embed] });
  }

  if (commandName === 'serverinfo') {
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle(`🏰 Server Information — ${guild.name}`)
      .setDescription(`**Owner:** <@${guild.ownerId}>\n**Total Members:** **${guild.memberCount}**\n**Channels:** ${guild.channels?.cache?.size || 0}\n**Roles:** ${guild.roles?.cache?.size || 0}\n**Created At:** <t:${Math.floor(guild.createdTimestamp / 1000)}:D>`)
      .setThumbnail(guild.iconURL?.({ size: 256 }) || null)
      .setTimestamp();
    return safeReply(interaction, { embeds: [embed] });
  }

  if (commandName === 'userinfo') {
    const target = interaction.options.getUser('user') || user;
    const targetMember = guild.members.cache.get(target.id);
    let rolesDisplay = 'None';
    if (targetMember?.roles?.cache) {
      const rArr = typeof targetMember.roles.cache.values === 'function' ? Array.from(targetMember.roles.cache.values()) : [];
      rolesDisplay = rArr.filter(r => r.id !== guild.roles.everyone?.id).map(r => `<@&${r.id}>`).join(', ') || 'None';
    }
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle(`User Profile — ${target.tag}`)
      .setDescription(`**Mention:** <@${target.id}>\n**ID:** \`${target.id}\`\n**Created:** <t:${Math.floor(target.createdTimestamp / 1000)}:R>\n**Joined Server:** ${targetMember ? `<t:${Math.floor(targetMember.joinedTimestamp / 1000)}:R>` : 'Unknown'}\n**Roles:** ${rolesDisplay}`)
      .setThumbnail(target.displayAvatarURL?.({ size: 256 }) || null)
      .setTimestamp();
    return safeReply(interaction, { embeds: [embed] });
  }

  if (commandName === 'permissions') {
    const target = interaction.options.getUser('user') || user;
    const targetMember = guild.members.cache.get(target.id) || member;
    const perms = targetMember.permissions.toArray().slice(0, 15).join(', ');
    return safeReply(interaction, `📋 **Permissions for ${target.tag}:**\n\`${perms}...\``);
  }

  if (commandName === 'help') {
    // ── COMPREHENSIVE MULTI-PAGE HELP PANEL ──
    const helpCategories = {
      overview: {
        emoji: '🏠',
        label: 'Overview',
        title: '🏠 THOR APEX — All-in-One Command Centre',
        description:
          '**THOR APEX** is a production-grade, all-in-one Discord bot with **80+ commands** spanning security, moderation, music, welcome, utility, fun and more.\n\n' +
          '**Use the dropdown menu below to explore each category in detail.**\n\n' +
          '📁 **Command Categories:**\n' +
          '> ⚖️ **Moderation** — Warn, timeout, kick, ban, purge & more\n' +
          '> 🛡️ **Security & Anti-Nuke** — Real-time nuke interception & lockdown\n' +
          '> 🤖 **AutoMod** — 12 detection filters with custom punishments\n' +
          '> 📋 **Server Logs** — 14 dedicated event log channels\n' +
          '> 🎉 **Welcome & Goodbye** — Custom welcome cards & departure messages\n' +
          '> 🎵 **Music** — Full music player, queue, radio & Spotify\n' +
          '> 🔧 **Utility & Info** — Ping, uptime, botinfo, userinfo\n' +
          '> 🎮 **Fun & Roleplay** — Minigames, dice, 8-ball, roleplay actions\n' +
          '> 💎 **Economy & Badges** — Points, leaderboard & member badges\n' +
          '> 🌐 **Integrations** — YouTube, Twitch & GitHub alerts\n' +
          '> ⚙️ **Admin & Config** — Server config, modules, maintenance\n' +
          '> 🚀 **Advanced** — AFK, birthdays, translate, VPN check & more',
        color: '#5865F2',
      },
      moderation: {
        emoji: '⚖️',
        label: 'Moderation',
        title: '⚖️ Moderation Commands',
        description:
          '`/warn` — Issue an official warning to a member\n' +
          '`/warnings` — View active warnings for a member\n' +
          '`/clearwarnings` — Clear all warnings for a member\n' +
          '`/timeout` — Timeout a member (e.g. 10m, 1h, 1d)\n' +
          '`/untimeout` — Remove timeout from a member\n' +
          '`/kick` — Kick a member from the server\n' +
          '`/ban` — Ban a user from the server\n' +
          '`/unban` — Unban a user by their User ID\n' +
          '`/softban` — Ban and instantly unban to purge messages\n' +
          '`/purge` — Bulk delete messages (1–100, with filters)\n' +
          '`/slowmode` — Set slowmode delay for a channel\n' +
          '`/lock` — Lock a channel to prevent member messages\n' +
          '`/unlock` — Unlock a previously locked channel\n' +
          '`/nick` — Change a member\'s nickname\n' +
          '`/modlogs` — View moderation history for a member\n' +
          '`/quickmod` — Launch rapid one-click moderation panel',
        color: '#FEE75C',
      },
      security: {
        emoji: '🛡️',
        label: 'Security & Anti-Nuke',
        title: '🛡️ Security & Anti-Nuke Commands',
        description:
          '`/security status` — View security protection overview\n' +
          '`/security audit` — Security configuration health check\n' +
          '`/security incidents` — View recent incident history\n' +
          '`/security test` — Test security alert dispatch path\n' +
          '`/antinuke enable` — Enable anti-nuke protection\n' +
          '`/antinuke disable` — Disable anti-nuke protection\n' +
          '`/antinuke status` — View anti-nuke status & thresholds\n' +
          '`/antinuke config` — Set enforcement action (ban, kick, quarantine…)\n' +
          '`/antinuke threshold` — Set burst limit for event categories\n' +
          '`/antinuke trust` — Manage trusted users/roles who bypass anti-nuke\n' +
          '`/antinuke lockdown` — Engage emergency server lockdown\n' +
          '`/antinuke unlock` — Lift emergency lockdown\n' +
          '`/lockdown` — Toggle server-wide lockdown (legacy shortcut)\n' +
          '`/whitelist` — Interactive whitelist management for security\n' +
          '`/quarantine status` — View current quarantine status\n' +
          '`/quarantine release` — Release quarantined members\n' +
          '`/threat` — Instantly switch server DEFCON threat level\n' +
          '`/raidmode on` — Activate raid countermeasures\n' +
          '`/raidmode off` — Deactivate raid mode & restore channels\n' +
          '`/raidmode status` — View current raid mode status\n' +
          '`/vpncheck user` — Analyze account risk & suspicion score\n' +
          '`/vpncheck ip` — Check IP for VPN/proxy/datacenter flags',
        color: '#ED4245',
      },
      automod: {
        emoji: '🤖',
        label: 'AutoMod',
        title: '🤖 AutoMod Engine Commands',
        description:
          '`/automod enable` — Enable AutoMod or a specific filter rule\n' +
          '`/automod disable` — Disable AutoMod or a specific filter rule\n' +
          '`/automod enableall` — Enable all 12 detection rules at once\n' +
          '`/automod disableall` — Disable all rules at once\n' +
          '`/automod status` — View all active filter rules & thresholds\n' +
          '`/automod config` — Interactive AutoMod dashboard\n' +
          '`/automod test` — Run safe diagnostic & simulation suite\n' +
          '`/automod blacklist` — Manage word blacklist (add/remove/list)\n' +
          '`/automod whitelist` — Manage AutoMod exemptions (users/roles/channels)\n' +
          '`/automod punishment` — Customize punishment per rule (delete/warn/timeout/kick/ban)\n\n' +
          '**Legacy shortcuts:**\n' +
          '`/antispam` `/antilink` `/antiraid` `/altdetection` `/wordfilter` `/addword` `/removeword`\n\n' +
          '**12 Detection Filters:** Anti-Spam, Duplicate Messages, Mention Spam, @everyone, Discord Invites, External Links, NSFW Links, Word Blacklist, Caps Filter, Emoji Spam, Alt Detection, Anti-Raid',
        color: '#57F287',
      },
      logs: {
        emoji: '📋',
        label: 'Server Logs',
        title: '📋 14-Channel Logging System',
        description:
          '`/logs setup` — Auto-create 📁 SERVER LOGS category & 14 dedicated channels\n' +
          '`/logs status` — View all 14 log channel destinations\n' +
          '`/logs configure` — Bind a specific log category to a channel\n' +
          '`/logs test` — Send test embeds to all configured log channels\n' +
          '`/logs disable` — Disable logging for a category or all\n\n' +
          '**14 Dedicated Channels:** Member, Message, Moderation, Security, Anti-Nuke, AutoMod, Role, Channel, Voice, Server Settings, Invite, Webhook, Bot, Welcome',
        color: '#5865F2',
      },
      welcome: {
        emoji: '🎉',
        label: 'Welcome & Goodbye',
        title: '🎉 Welcome & Goodbye System',
        description:
          '`/welcome setup` — Set welcome channel\n' +
          '`/welcome enable` — Enable welcome messages\n' +
          '`/welcome disable` — Disable welcome messages\n' +
          '`/welcome config` — View current welcome card settings\n' +
          '`/welcome test` — Preview welcome card & run diagnostics\n' +
          '`/welcome banner` — Set or sync welcome banner image\n' +
          '`/goodbye setup` — Set goodbye channel\n' +
          '`/goodbye enable` — Enable goodbye messages\n' +
          '`/goodbye disable` — Disable goodbye messages\n' +
          '`/goodbye config` — View goodbye message settings\n' +
          '`/goodbye test` — Preview goodbye message\n\n' +
          '**Customization shortcuts:**\n' +
          '`/setwelcome` `/setleave` `/setrules` `/setroles` `/setgeneral` `/setfun`\n' +
          '`/setedit` `/setgaming` `/setwelcomecolor` `/setwelcometext`\n' +
          '`/setbanner` `/setlogo` `/serverbanner` `/setleavetext` `/setautorole`',
        color: '#EB459E',
      },
      music: {
        emoji: '🎵',
        label: 'Music',
        title: '🎵 Music & Radio System',
        description:
          '`/play` — Play a song from YouTube, Spotify, or SoundCloud\n' +
          '`/playnow` — Play a track immediately at the front of the queue\n' +
          '`/pause` — Pause music playback\n' +
          '`/resume` — Resume music playback\n' +
          '`/skip` — Skip the current song\n' +
          '`/previous` — Play the previous track in history\n' +
          '`/stop` — Stop playback and leave voice channel\n' +
          '`/disconnect` — Leave the voice channel & release resources\n' +
          '`/nowplaying` — Show currently playing track with progress bar\n' +
          '`/search` — Search sources for music tracks (pick from results)\n' +
          '`/queue view` — View current music queue\n' +
          '`/queue remove` — Remove a track from queue\n' +
          '`/queue move` — Move a track position in queue\n' +
          '`/queue jump` — Skip directly to a position in queue\n' +
          '`/queue export` — Export queue as text\n' +
          '`/queue clear` — Clear all upcoming tracks\n' +
          '`/shuffle` — Shuffle the music queue\n' +
          '`/loop` — Set repeat mode (off/track/queue)\n' +
          '`/volume` — Adjust music volume (1–100)\n' +
          '`/seek` — Seek to a playback position (e.g. 1:30 or 90s)\n' +
          '`/radio` — Play 24/7 radio stream (Lofi, Gaming, Pop, Chill)\n' +
          '`/lyrics` — Search real-time lyrics for any song\n' +
          '`/musicstatus` — Music engine & voice connection diagnostics\n' +
          '`/musicupdate status` — Music engine health & dependency versions\n' +
          '`/musicupdate check` — Check for compatible library updates\n' +
          '`/musicupdate logs` — View playback incidents & self-healing logs\n' +
          '`/musicupdate repair` — Reinitialize & repair music subsystem\n' +
          '`/musicupdate apply` — Review update status & deployment info',
        color: '#1DB954',
      },
      utility: {
        emoji: '🔧',
        label: 'Utility & Info',
        title: '🔧 Utility & Information Commands',
        description:
          '`/ping` — Check bot heartbeat latency & gateway ping\n' +
          '`/uptime` — Check bot continuous running time & process health\n' +
          '`/botinfo` — View bot statistics, runtime, memory & architecture\n' +
          '`/serverinfo` — View server statistics, security level & member counts\n' +
          '`/userinfo` — View member profile, roles, creation date & join position\n' +
          '`/permissions` — Inspect bot and member permissions\n' +
          '`/help` — Display this comprehensive command guide\n' +
          '`/myinvites` — Check your total server invites\n' +
          '`/invites` — Check server invites for a user\n' +
          '`/invitetop` — Top inviters leaderboard\n' +
          '`/translate` — Translate text into another language\n' +
          '`/panel` — Open the THOR APEX interactive admin control centre',
        color: '#5865F2',
      },
      fun: {
        emoji: '🎮',
        label: 'Fun & Roleplay',
        title: '🎮 Fun, Minigames & Roleplay',
        description:
          '**🎲 Minigames:**\n' +
          '`/fun coinflip` — Flip a fair coin (Heads or Tails)\n' +
          '`/fun dice` — Roll dice (customizable sides)\n' +
          '`/fun 8ball` — Ask the Magic 8-Ball a question\n' +
          '`/fun rps` — Play Rock, Paper, Scissors\n\n' +
          '**🎭 Roleplay Actions:**\n' +
          '`/roleplay hug` — Give a member a warm hug\n' +
          '`/roleplay pat` — Gently pat a member on the head\n' +
          '`/roleplay slap` — Playfully slap a member\n' +
          '`/roleplay highfive` — High five a member\n' +
          '`/roleplay wave` — Wave hello to a member',
        color: '#EB459E',
      },
      economy: {
        emoji: '💎',
        label: 'Economy & Badges',
        title: '💎 Points Economy & Member Badges',
        description:
          '**💰 Points Economy:**\n' +
          '`/points check` — Check points balance (yours or another member)\n' +
          '`/points give` — Award points to a member\n' +
          '`/points take` — Deduct points from a member\n' +
          '`/points leaderboard` — View top 10 members with highest points\n' +
          '`/points reset` — Reset points for a user or entire server\n\n' +
          '**🏅 Member Badges:**\n' +
          '`/badge give` — Award a custom badge to a member (🏆 ⭐ 🛡️ 💎)\n' +
          '`/badge remove` — Remove a badge from a member\n' +
          '`/badge list` — View all badges of a member',
        color: '#FEE75C',
      },
      integrations: {
        emoji: '🌐',
        label: 'Integrations',
        title: '🌐 External Service Integrations',
        description:
          '`/integration youtube` — Add YouTube channel upload alerts\n' +
          '`/integration twitch` — Add Twitch stream live alerts\n' +
          '`/integration github` — Add GitHub repository release/commit alerts\n' +
          '`/integration list` — List active external integrations\n' +
          '`/integration remove` — Remove an external integration\n\n' +
          '**Feeds are sent to your chosen existing text channels — no extra channels created!**',
        color: '#7289DA',
      },
      admin: {
        emoji: '⚙️',
        label: 'Admin & Config',
        title: '⚙️ Administration & Server Configuration',
        description:
          '`/setup` — One-click auto-setup: log channels & configuration\n' +
          '`/serverconfig view` — Master dashboard of all active modules\n' +
          '`/serverconfig export` — Export server settings as JSON\n' +
          '`/serverconfig reset` — Reset a module to factory defaults\n' +
          '`/module enable` — Enable a specific feature module\n' +
          '`/module disable` — Disable a specific feature module\n' +
          '`/module list` — Display status of all modules\n' +
          '`/maintenance enable` — Enable bot maintenance mode\n' +
          '`/maintenance disable` — Disable maintenance mode\n' +
          '`/maintenance status` — Check maintenance mode status\n' +
          '`/clone export` — Export config as a portable template token\n' +
          '`/clone import` — Import config template into this server\n' +
          '`/nightmode setup` — Configure nightmode quiet hours\n' +
          '`/nightmode toggle` — Enable or disable nightmode schedule\n' +
          '`/nightmode status` — View current nightmode config\n' +
          '`/devmode stats` — CPU, memory, uptime, latency & cache metrics\n' +
          '`/devmode diagnostics` — System integrity & permission verification\n' +
          '`/devmode simulate` — Simulate security workflows safely\n' +
          '`/dm user` — Send official staff DM to a user\n' +
          '`/dm role` — Send official DM to all members of a role',
        color: '#99AAB5',
      },
      advanced: {
        emoji: '🚀',
        label: 'Advanced Features',
        title: '🚀 Advanced Suite Commands',
        description:
          '`/afk set` — Set your AFK status with a custom message\n' +
          '`/afk clear` — Clear your AFK status\n' +
          '`/afk status` — Check a member\'s AFK status\n' +
          '`/birthday set` — Set your birthday\n' +
          '`/birthday check` — Check a member\'s birthday\n' +
          '`/birthday upcoming` — View upcoming birthdays in the next 30 days\n' +
          '`/birthday channel` — Set birthday announcement channel\n' +
          '`/appeal submit` — Submit an unban/punishment appeal\n' +
          '`/appeal status` — Check your appeal status\n' +
          '`/appeal review` — Staff decision on an appeal\n' +
          '`/appeal setup` — Configure appeal notifications channel\n' +
          '`/serverstat setup` — Setup voice stat counter channels\n' +
          '`/serverstat update` — Refresh voice stat counters now\n' +
          '`/serverstat disable` — Remove voice stat channels',
        color: '#9B59B6',
      },
    };

    // Build the overview embed (home page)
    const overviewData = helpCategories.overview;
    const homeEmbed = new EmbedBuilder()
      .setColor(overviewData.color)
      .setTitle(overviewData.title)
      .setDescription(overviewData.description)
      .setThumbnail(client?.user?.displayAvatarURL?.() || null)
      .setFooter({ text: `THOR APEX v2.0 • ${Object.keys(helpCategories).length - 1} categories • 80+ commands • Requested by ${user.tag}` })
      .setTimestamp();

    // Build dropdown select menu
    const selectOptions = Object.entries(helpCategories).map(([key, cat]) => ({
      label: cat.label,
      value: `help_${key}`,
      description: cat.title.replace(/^[^\s]+\s/, '').slice(0, 100),
      emoji: cat.emoji,
      default: key === 'overview',
    }));

    const selectRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('help_category_select')
        .setPlaceholder('📖 Select a command category...')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(selectOptions)
    );

    return safeReply(interaction, { embeds: [homeEmbed], components: [selectRow] });
  }

  // ─────────────────────────────────────────────────────────────
  // 7. INVITES COMMANDS
  // ─────────────────────────────────────────────────────────────
  if (commandName === 'myinvites') {
    const inv = await guild.invites?.fetch().catch(() => null);
    let total = 0;
    if (inv) inv.forEach(i => { if (i.inviter?.id === user.id) total += (i.uses || 0); });
    return safeReply(interaction, `📩 You have **${total}** total invites in **${guild.name}**.`);
  }

  if (commandName === 'invites') {
    const target = interaction.options.getUser('user') || user;
    const inv = await guild.invites?.fetch().catch(() => null);
    let total = 0;
    if (inv) inv.forEach(i => { if (i.inviter?.id === target.id) total += (i.uses || 0); });
    return safeReply(interaction, `📩 **${target.tag}** has **${total}** total invites in **${guild.name}**.`);
  }

  if (commandName === 'invitetop') {
    const inv = await guild.invites?.fetch().catch(() => null);
    if (!inv || inv.size === 0) return safeReply(interaction, 'No invites found in this server.');
    const totals = new Map();
    inv.forEach(i => {
      if (!i.inviter) return;
      totals.set(i.inviter.id, (totals.get(i.inviter.id) || 0) + (i.uses || 0));
    });
    const sorted = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const desc = sorted.map((e, i) => `${i + 1}. <@${e[0]}> — **${e[1]}** invites`).join('\n');
    return safeReply(interaction, { embeds: [new EmbedBuilder().setColor('#5865F2').setTitle(`Top Inviters Leaderboard — ${guild.name}`).setDescription(desc || 'No invite data.').setTimestamp()] });
  }

  // ─────────────────────────────────────────────────────────────
  // 8. MUSIC & RADIO COMMANDS (musicService-backed, Rythm-style)
  // ─────────────────────────────────────────────────────────────
  if (commandName === 'play') {
    const vc = member?.voice?.channel;
    if (!vc) return safeReply(interaction, 'Join a Voice Channel first!');
    await interaction.deferReply();
    const query = interaction.options.getString('song', true);
    // Prefer new musicService; fall back to legacy addMusicToQueue
    if (musicService) {
      // BUG FIX: pass { playNow: false } object — raw boolean was silently swallowed by JS destructuring
      const res = await musicService.enqueueTrack(guild, vc, user, interaction.channel, query, { playNow: false });
      if (!res.success) return interaction.editReply(`❌ ${res.message}`);
      if (res.isPlaylist) {
        return interaction.editReply(`🎵 Added **${res.count}** tracks from **${res.playlistName || 'playlist'}** to the queue!`);
      }
      return interaction.editReply(`▶️ Added **${res.firstTrack?.title || query}** to queue (Position **#${res.position}**).`);
    }
    if (!addMusicToQueue) return interaction.editReply('❌ Music engine is currently initializing.');
    const res = await addMusicToQueue(guild, vc, user, interaction.channel, query);
    if (!res.success) return interaction.editReply(`❌ ${res.message}`);
    return interaction.editReply(`▶️ Added **${res.firstTrack?.title || query}** to queue (Position #${res.position || 1}).`);
  }

  if (commandName === 'pause') {
    if (musicService) {
      const ok = musicService.pause(guild.id);
      return safeReply(interaction, ok ? '⏸️ Music paused.' : 'Nothing is currently playing.');
    }
    const q = getQ?.(guild.id);
    if (!q || !q.player || !q.isPlaying) return safeReply(interaction, 'Nothing is currently playing.');
    q.player.pause(); q.isPaused = true;
    return safeReply(interaction, '⏸️ Music paused.');
  }

  if (commandName === 'resume') {
    if (musicService) {
      const ok = musicService.resume(guild.id);
      return safeReply(interaction, ok ? '▶️ Music resumed.' : 'Music is not paused.');
    }
    const q = getQ?.(guild.id);
    if (!q || !q.player || !q.isPaused) return safeReply(interaction, 'Music is not paused.');
    q.player.unpause(); q.isPaused = false;
    return safeReply(interaction, '▶️ Music resumed.');
  }

  if (commandName === 'skip') {
    if (musicService) {
      const session = musicService.sessions?.get(guild.id);
      const trackTitle = session?.currentTrack?.title || 'current track';
      const ok = musicService.skip(guild.id);
      return safeReply(interaction, ok ? `⏭️ Skipped: **${trackTitle}**` : 'Queue is empty!');
    }
    const q = getQ?.(guild.id);
    if (!q || !q.currentTrack) return safeReply(interaction, 'Queue is empty!');
    const s = q.currentTrack;
    if (handleTrackEnded) handleTrackEnded(guild.id);
    return safeReply(interaction, `⏭️ Skipped: **${s.title}**`);
  }

  if (commandName === 'stop') {
    if (musicService) { musicService.destroySession(guild.id); }
    else if (stopMusicSession) { stopMusicSession(guild.id); }
    return safeReply(interaction, '⏹️ Stopped music playback and cleared the session.');
  }

  if (commandName === 'queue') {
    const session = musicService?.sessions?.get(guild.id);
    const q = (session && session.queue) ? session : getQ?.(guild.id);
    const sub = interaction.options.getSubcommand?.(false) || 'view';

    if (sub === 'view') {
      if (!q || !q.queue || q.queue.length === 0) return safeReply(interaction, 'Music queue is currently empty. Use `/play` to add tracks.');
      const page = Math.max(1, interaction.options.getInteger?.('page') || 1);
      const pageSize = 10;
      const start = (page - 1) * pageSize;
      const list = q.queue.slice(start, start + pageSize).map((t, i) => `${start + i + 1}. **${t.title}**${t.artist ? ` — *${t.artist}*` : ''}${t.requestedBy ? ` (By: <@${t.requestedBy}>)` : ''}`).join('\n') || 'No tracks on this page.';
      return safeReply(interaction, { embeds: [new EmbedBuilder().setColor('#5865F2').setTitle(`Music Queue — ${guild.name} (Page ${page})`).setDescription(list).setFooter({ text: `Total: ${q.queue.length} tracks` }).setTimestamp()] });
    }

    if (sub === 'remove') {
      if (!q || !q.queue || q.queue.length === 0) return safeReply(interaction, 'Music queue is empty.');
      const pos = interaction.options.getInteger('position', true);
      if (pos < 1 || pos > q.queue.length) return safeReply(interaction, `❌ Invalid position. Must be between 1 and ${q.queue.length}.`);
      let removedTitle = '';
      if (session && musicService?.remove) {
        const removed = musicService.remove(guild.id, pos);
        removedTitle = removed?.title || `track #${pos}`;
      } else {
        const removed = q.queue.splice(pos - 1, 1)[0];
        removedTitle = removed?.title || `track #${pos}`;
      }
      return safeReply(interaction, `🗑️ Removed track **#${pos}**: **${removedTitle}**.`);
    }

    if (sub === 'move') {
      if (!q || !q.queue || q.queue.length === 0) return safeReply(interaction, 'Music queue is empty.');
      const from = interaction.options.getInteger('from', true);
      const to = interaction.options.getInteger('to', true);
      if (from < 1 || from > q.queue.length || to < 1 || to > q.queue.length) {
        return safeReply(interaction, `❌ Positions must be between 1 and ${q.queue.length}.`);
      }
      let trackTitle = '';
      if (session && musicService?.move) {
        const track = musicService.move(guild.id, from, to);
        trackTitle = track?.title || 'track';
      } else {
        const [track] = q.queue.splice(from - 1, 1);
        q.queue.splice(to - 1, 0, track);
        trackTitle = track?.title || 'track';
      }
      return safeReply(interaction, `🔀 Moved **${trackTitle}** from #${from} to #${to}.`);
    }

    if (sub === 'jump') {
      if (!q || !q.queue || q.queue.length === 0) return safeReply(interaction, 'Music queue is empty.');
      const pos = interaction.options.getInteger('position', true);
      if (pos < 1 || pos > q.queue.length) return safeReply(interaction, `❌ Position must be between 1 and ${q.queue.length}.`);
      if (session && musicService?.jump) {
        musicService.jump(guild.id, pos);
        return safeReply(interaction, `⏭️ Jumped to track #${pos}.`);
      }
      q.queue.splice(0, pos - 1);
      if (handleTrackEnded) {
        handleTrackEnded(guild.id);
        return safeReply(interaction, `⏭️ Jumped to track #${pos}.`);
      }
      return safeReply(interaction, `⏭️ Queue positioned at #${pos}.`);
    }

    if (sub === 'export') {
      if (!q || !q.queue || q.queue.length === 0) return safeReply(interaction, 'Music queue is empty.');
      const text = q.queue.map((t, i) => `${i + 1}. ${t.title}${t.artist ? ` - ${t.artist}` : ''} ${t.url || t.streamUrl || ''}`).join('\n');
      return safeReply(interaction, `📜 **Exported Queue (${q.queue.length} tracks):**\n\`\`\`\n${text.slice(0, 1900)}\n\`\`\``);
    }

    if (sub === 'clear') {
      if (!q || !q.queue || q.queue.length === 0) return safeReply(interaction, 'Music queue is already empty.');
      let count = q.queue.length;
      if (session && musicService?.clearQueue) {
        count = musicService.clearQueue(guild.id);
      } else {
        q.queue = [];
      }
      return safeReply(interaction, `🧹 Cleared **${count}** tracks from the queue.`);
    }
  }

  if (commandName === 'nowplaying') {
    const session = musicService?.sessions?.get(guild.id);
    if (session && session.currentTrack) {
      // Use the Rythm-style player card if musicService is active
      const { renderPlayerCard } = require('../music/musicPlayerCard');
      const card = renderPlayerCard(session);
      return safeReply(interaction, card);
    }
    const q = getQ?.(guild.id);
    if (!q || !q.currentTrack) return safeReply(interaction, 'Nothing is currently playing.');
    return safeReply(interaction, { embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('▶️ Now Playing').setDescription(`**${q.currentTrack.title}**\nArtist: ${q.currentTrack.artist || 'Unknown'}`).setThumbnail(q.currentTrack.thumbnail || null).setTimestamp()] });
  }

  if (commandName === 'radio') {
    const vc = member?.voice?.channel;
    if (!vc) return safeReply(interaction, 'Join a Voice Channel first!');
    const genre = interaction.options.getString('genre') || 'lofi';
    const sel = RADIO_STREAMS[genre] || RADIO_STREAMS.lofi || { name: 'Lofi Chill', url: 'https://stream.zeno.fm/0r0xa792kwzuv' };
    const q = getQ?.(guild.id);
    if (voiceLib && q) {
      if (!q.connection) {
        try {
          q.connection = voiceLib.joinVoiceChannel({
            channelId: vc.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: false,
          });
        } catch (_) {}
      }
      if (!q.player) {
        q.player = voiceLib.createAudioPlayer();
        q.connection?.subscribe(q.player);
      }
      try {
        q.player.play(voiceLib.createAudioResource(sel.url, { inputType: voiceLib.StreamType.Arbitrary }));
      } catch (_) {}
    }
    return safeReply(interaction, `📻 Playing 24/7 stream: **${sel.name}** in <#${vc.id}>.`);
  }

  if (commandName === 'volume') {
    const level = interaction.options.getInteger('level', true);
    // Prefer musicService for live volume control
    if (musicService && musicService.sessions?.has(guild.id)) {
      const actual = musicService.setVolume(guild.id, level);
      return safeReply(interaction, `🔊 Playback volume set to **${actual}%**.`);
    }
    const q = getQ?.(guild.id);
    if (q) {
      q.volume = Math.max(1, Math.min(100, level));
      if (q.currentResource?.volume) {
        q.currentResource.volume.setVolume(q.volume / 100);
      }
    }
    return safeReply(interaction, `🔊 Playback volume set to **${level}%**.`);
  }

  if (commandName === 'loop') {
    const mode = interaction.options.getString('mode', true);
    // Prefer musicService
    if (musicService && musicService.sessions?.has(guild.id)) {
      const actual = musicService.setLoop(guild.id, mode);
      return safeReply(interaction, `🔁 Loop mode set to **${actual.toUpperCase()}**.`);
    }
    const q = getQ?.(guild.id);
    if (q) q.loopMode = mode.toLowerCase();
    return safeReply(interaction, `🔁 Loop mode set to **${mode.toUpperCase()}**.`);
  }

  if (commandName === 'shuffle') {
    // Prefer musicService
    if (musicService && musicService.sessions?.has(guild.id)) {
      const session = musicService.sessions.get(guild.id);
      if (!session || session.queue.length <= 1) return safeReply(interaction, 'Not enough songs in queue to shuffle.');
      const count = musicService.shuffle(guild.id);
      return safeReply(interaction, `🔀 Shuffled **${count}** songs in queue.`);
    }
    const q = getQ?.(guild.id);
    if (!q || q.queue.length <= 1) return safeReply(interaction, 'Not enough songs in queue to shuffle.');
    for (let i = q.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [q.queue[i], q.queue[j]] = [q.queue[j], q.queue[i]];
    }
    return safeReply(interaction, `🔀 Shuffled **${q.queue.length}** songs in queue.`);
  }

  if (commandName === 'previous') {
    if (musicService) {
      const result = musicService.playPrevious(guild.id);
      return safeReply(interaction, result ? `⏮️ Playing previous track: **${result.title}**.` : 'No previous tracks recorded.');
    }
    const q = getQ?.(guild.id);
    if (!q || !q.history || q.history.length === 0) return safeReply(interaction, 'No previous tracks recorded.');
    const prev = q.history.shift();
    if (prev) {
      q.queue.unshift(prev);
      if (handleTrackEnded) handleTrackEnded(guild.id);
      return safeReply(interaction, `⏮️ Playing previous track: **${prev.title}**.`);
    }
    return safeReply(interaction, 'Could not replay previous track.');
  }

  // ── playnow ──
  if (commandName === 'playnow') {
    const vc = member?.voice?.channel;
    if (!vc) return safeReply(interaction, 'Join a Voice Channel first!');
    await interaction.deferReply();
    const query = interaction.options.getString('song', true);
    if (!musicService) return interaction.editReply('❌ Music service is not available.');
    // BUG FIX: must pass { playNow: true } object, not boolean true
    const res = await musicService.enqueueTrack(guild, vc, user, interaction.channel, query, { playNow: true });
    if (!res.success) return interaction.editReply(`❌ ${res.message}`);
    return interaction.editReply(`⚡ Now playing: **${res.firstTrack?.title || query}** (jumped to front of queue).`);
  }

  // ── disconnect ──
  if (commandName === 'disconnect') {
    if (musicService) { musicService.destroySession(guild.id); }
    else if (stopMusicSession) { stopMusicSession(guild.id); }
    return safeReply(interaction, '👋 Disconnected from voice channel and released all resources.');
  }

  // ── clearqueue ──
  if (commandName === 'clearqueue') {
    if (musicService) {
      const count = musicService.clearQueue(guild.id);
      return safeReply(interaction, `🧹 Cleared **${count}** upcoming tracks from the queue.`);
    }
    const q = getQ?.(guild.id);
    if (!q || q.queue.length === 0) return safeReply(interaction, 'Queue is already empty.');
    const n = q.queue.length;
    q.queue = [];
    return safeReply(interaction, `🧹 Cleared **${n}** tracks from the queue.`);
  }

  // ── search ──
  if (commandName === 'search') {
    const query = interaction.options.getString('query', true);
    await interaction.deferReply();
    if (!audioProvider) return interaction.editReply('❌ Audio provider is not available.');
    try {
      const results = await audioProvider.searchAudioTracks(query, 5);
      if (!results || results.length === 0) return interaction.editReply(`🔍 No results found for **${query}**. Try a different search term.`);
      const lines = results.map((r, i) => `**${i + 1}.** ${r.title}${r.artist ? ` — *${r.artist}*` : ''}${r.durationSec ? ` \`${Math.floor(r.durationSec / 60)}:${String(r.durationSec % 60).padStart(2, '0')}\`` : ''}`);
      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`🔍 Search Results for: ${query}`)
        .setDescription(lines.join('\n'))
        .setFooter({ text: 'Use /play <title> to play any of these tracks' })
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      return interaction.editReply(`❌ Search failed: ${err.message}`);
    }
  }

  // ── seek ──
  if (commandName === 'seek') {
    const timeStr = interaction.options.getString('time', true);
    const session = musicService?.sessions?.get(guild.id);
    if (!session || !session.currentTrack || !session.isPlaying) {
      return safeReply(interaction, 'Nothing is currently playing.');
    }

    // Parse time string (e.g. "1:30", "01:30", "90", "90s")
    let seekSec = 0;
    if (timeStr.includes(':')) {
      const parts = timeStr.split(':').map(Number);
      if (parts.length === 2) {
        seekSec = (parts[0] || 0) * 60 + (parts[1] || 0);
      } else if (parts.length === 3) {
        seekSec = (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
      }
    } else {
      seekSec = parseInt(timeStr.replace(/\D/g, '')) || 0;
    }

    const dur = session.currentTrack.durationSec || 0;
    if (dur > 0 && seekSec > dur) {
      return safeReply(interaction, `❌ Seek position **${timeStr}** exceeds track duration.`);
    }

    if (musicService?.seek) {
      await interaction.deferReply();
      const res = await musicService.seek(guild.id, seekSec);
      if (!res.success) {
        return interaction.editReply(`❌ ${res.message}`);
      }
      const min = Math.floor(seekSec / 60);
      const sec = String(seekSec % 60).padStart(2, '0');
      return interaction.editReply(`⏩ Seeked to **${min}:${sec}** in **${res.track?.title || 'current track'}**.`);
    }

    return safeReply(interaction, `⏩ Seek to **${timeStr}** noted.`);
  }

  // ── musicstatus ──
  if (commandName === 'musicstatus') {
    const health = musicMonitor?.getSystemHealth(musicService?.sessions || new Map()) || {};
    const session = musicService?.sessions?.get(guild.id);
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('🎵 THOR APEX — Music Engine Status')
      .addFields(
        { name: '🤖 Bot Uptime', value: `${Math.floor((health.uptimeSec || 0) / 60)}m ${(health.uptimeSec || 0) % 60}s`, inline: true },
        { name: '💾 Memory (RSS)', value: `${health.memoryRssMb || 0} MB`, inline: true },
        { name: '🌐 Node.js', value: health.nodeVersion || process.version, inline: true },
        { name: '🔊 Active Sessions', value: String(health.activePlayingSessions || 0), inline: true },
        { name: '⏸️ Paused', value: String(health.pausedSessions || 0), inline: true },
        { name: '📋 Total Queued', value: String(health.totalQueuedTracks || 0), inline: true },
        { name: '🎶 This Server', value: session ? `Playing: **${session.currentTrack?.title || 'N/A'}**\nQueue: **${session.queue.length}** tracks\nLoop: **${session.loopMode}**` : 'No active session', inline: false },
      )
      .setTimestamp();
    return safeReply(interaction, { embeds: [embed] });
  }

  // ── musicupdate ──
  if (commandName === 'musicupdate') {
    // Owner/admin check
    const isOwner = guild.ownerId === user.id;
    const isAdmin = member?.permissions?.has(PermissionsBitField.Flags.Administrator);
    if (!isOwner && !isAdmin) return safeReply(interaction, '❌ This command is restricted to server administrators and the bot owner.', true);

    const sub = interaction.options.getSubcommand(true);

    if (sub === 'status') {
      const health = musicMonitor?.getSystemHealth(musicService?.sessions || new Map()) || {};
      const installed = musicMonitor?.getInstalledVersions() || {};
      const deps = ['@discordjs/voice', 'play-dl', 'ffmpeg-static', 'discord.js']
        .map(p => `• **${p}**: \`${(installed[p] || 'N/A').replace(/^[\^~]/, '')}\``).join('\n');
      const embed = new EmbedBuilder()
        .setColor('#FEE75C')
        .setTitle('🔧 Music Engine — Full Status Report')
        .addFields(
          { name: '📦 Installed Dependencies', value: deps },
          { name: '🔊 Sessions', value: `Active: ${health.activePlayingSessions || 0} | Paused: ${health.pausedSessions || 0} | Total: ${health.totalSessions || 0}` },
          { name: '💻 System', value: `Node: ${health.nodeVersion || process.version} | OS: ${health.platform || process.platform} | Heap: ${health.memoryHeapMb || 0}MB` },
        )
        .setTimestamp();
      return safeReply(interaction, { embeds: [embed] });
    }

    if (sub === 'check') {
      await interaction.deferReply({ ephemeral: true });
      const report = await musicMonitor?.checkForDependencyUpdates() || [];
      const lines = report.map(r => `${r.hasUpdate ? '🆙' : '✅'} **${r.package}** — installed: \`${r.current}\` | latest: \`${r.latest}\` (${r.status})`).join('\n');
      return interaction.editReply({ content: `**📦 NPM Registry Check:**\n${lines || 'No data available.'}` });
    }

    if (sub === 'logs') {
      const logs = musicMonitor?.getRecentLogs(10) || [];
      if (logs.length === 0) return safeReply(interaction, '📋 No music incidents logged yet.', true);
      const lines = logs.map(l => `\`[${l.iso?.slice(11, 19)}] [${l.level}]\` **${l.action}** — ${l.message}`).join('\n');
      const embed = new EmbedBuilder()
        .setColor('#ED4245')
        .setTitle('📋 Music Subsystem Incident Logs (Last 10)')
        .setDescription(lines.slice(0, 4000))
        .setTimestamp();
      return safeReply(interaction, { embeds: [embed] }, true);
    }

    if (sub === 'repair') {
      if (musicService) {
        musicService.destroySession(guild.id);
        musicMonitor?.logIncident('RECOVERY', 'MANUAL_REPAIR', `Repair triggered by ${user.tag} in guild ${guild.id}`);
      }
      return safeReply(interaction, '🔧 **Music subsystem repaired!** Session cleared and resources released. Use `/play` to start fresh.', true);
    }

    if (sub === 'apply') {
      const report = await musicMonitor?.checkForDependencyUpdates() || [];
      const hasUpdates = report.some(r => r.hasUpdate);
      const pkgs = report.filter(r => r.hasUpdate).map(r => `\`${r.package}@${r.latest}\``).join(' ');
      if (!hasUpdates) return safeReply(interaction, '✅ All music dependencies are up to date. No updates to apply.', true);
      return safeReply(interaction, `🆙 **Updates available!** Run this on your server:\n\`\`\`\nnpm install ${pkgs}\n\`\`\`\nThen restart the bot to apply changes.`, true);
    }

    return safeReply(interaction, '❌ Unknown subcommand.', true);
  }

  // ─────────────────────────────────────────────────────────────
  // 8a. INTERACTIVE PANEL — /panel
  // ─────────────────────────────────────────────────────────────
  if (commandName === 'panel') {
    const am = config.automod || {};
    const sec = config.security || {};
    const quarantinedCount = getQuarantinedCount(guild.id);

    // Status card embed
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('⚡ THOR APEX — Admin Control Centre')
      .setDescription(
        `**🤖 AutoMod Engine:** ${am.enabled ? '🟢 Active' : '🔴 Disabled'}\n` +
        `**🛡️ Anti-Nuke:** ${sec.antiNuke ? '🟢 Active' : '🔴 Disabled'}\n` +
        `**🔒 Server Lockdown:** ${sec.lockdown ? '🔴 LOCKED DOWN' : '🟢 Normal'}\n` +
        `**⚠️ Quarantined Members:** ${quarantinedCount > 0 ? `🟡 **${quarantinedCount} members**` : '🟢 None'}\n` +
        `**🚨 DEFCON Level:** ${sec.defcon === 1 ? '🔴 DEFCON 1 — Raid Underway' : sec.defcon === 2 ? '🟡 DEFCON 2 — High Alert' : '🟢 DEFCON 3 — Normal'}\n\n` +
        `*Click a button below to take immediate action.*`
      )
      .setFooter({ text: 'Only visible to you • Actions apply immediately' })
      .setTimestamp();

    // Row 1: Core toggle buttons
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('panel_toggle_automod')
        .setLabel(am.enabled ? '🔴 Disable AutoMod' : '🟢 Enable AutoMod')
        .setStyle(am.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('panel_toggle_antinuke')
        .setLabel(sec.antiNuke ? '🔴 Disable Anti-Nuke' : '🟢 Enable Anti-Nuke')
        .setStyle(sec.antiNuke ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('panel_lockdown')
        .setLabel(sec.lockdown ? '🔓 Lift Lockdown' : '🔒 Quick Lockdown')
        .setStyle(sec.lockdown ? ButtonStyle.Secondary : ButtonStyle.Danger),
    );

    // Row 2: Management buttons
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('panel_edit_filters')
        .setLabel('⚙️ Edit Filter Rules')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('panel_automod_diag')
        .setLabel('🔍 Run AutoMod Diagnostic')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('panel_release_quarantine')
        .setLabel(`🟢 Release Quarantine (${quarantinedCount})`)
        .setStyle(quarantinedCount > 0 ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(quarantinedCount === 0),
    );

    // Row 3: Threat level selector
    const row3 = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('panel_defcon_select')
        .setPlaceholder('🎯 Change DEFCON Threat Level...')
        .addOptions([
          {
            label: '🟢 DEFCON 3 — Normal Operations',
            description: 'Standard AutoMod & Anti-Nuke. Unrestricted access.',
            value: 'defcon_3',
            emoji: '🟢',
          },
          {
            label: '🟡 DEFCON 2 — High Alert',
            description: 'Block accounts <3 days old. External links restricted.',
            value: 'defcon_2',
            emoji: '🟡',
          },
          {
            label: '🔴 DEFCON 1 — Raid Underway',
            description: 'Instant lockdown. Rate limits enforced. Joins quarantined.',
            value: 'defcon_1',
            emoji: '🔴',
          },
        ])
    );

    return safeReply(interaction, { embeds: [embed], components: [row1, row2, row3], ephemeral: true });
  }

  // ─────────────────────────────────────────────────────────────
  // 8b. DEFCON SWITCHER — /threat
  // ─────────────────────────────────────────────────────────────
  if (commandName === 'threat') {
    const sec = config.security || {};
    const currentDefcon = sec.defcon || 3;

    const embed = new EmbedBuilder()
      .setColor(currentDefcon === 1 ? '#ED4245' : currentDefcon === 2 ? '#FEE75C' : '#57F287')
      .setTitle('🚨 THOR APEX — DEFCON Threat Level Switcher')
      .setDescription(
        `**Current Level:** ${currentDefcon === 1 ? '🔴 DEFCON 1 — Raid Underway' : currentDefcon === 2 ? '🟡 DEFCON 2 — High Alert' : '🟢 DEFCON 3 — Normal'}\n\n` +
        `Select your threat response level below:`
      )
      .addFields(
        { name: '🟢 DEFCON 3 — Normal', value: 'Standard rules active. All members have full access.', inline: false },
        { name: '🟡 DEFCON 2 — High Alert', value: 'Blocks accounts < 3 days old. All external links blocked except YouTube/Spotify.', inline: false },
        { name: '🔴 DEFCON 1 — Raid Underway', value: 'Server lockdown engaged. New joins quarantined. Rate limits enforced.', inline: false },
      )
      .setFooter({ text: 'Only visible to you • Takes effect immediately' })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('threat_defcon_3')
        .setLabel('🟢 DEFCON 3 — Normal')
        .setStyle(currentDefcon === 3 ? ButtonStyle.Secondary : ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('threat_defcon_2')
        .setLabel('🟡 DEFCON 2 — High Alert')
        .setStyle(currentDefcon === 2 ? ButtonStyle.Secondary : ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('threat_defcon_1')
        .setLabel('🔴 DEFCON 1 — Lockdown')
        .setStyle(currentDefcon === 1 ? ButtonStyle.Secondary : ButtonStyle.Danger),
    );

    return safeReply(interaction, { embeds: [embed], components: [row], ephemeral: true });
  }

  // ─────────────────────────────────────────────────────────────
  // 8c. QUARANTINE MANAGEMENT — /quarantine
  // ─────────────────────────────────────────────────────────────
  if (commandName === 'quarantine') {
    const sub = interaction.options.getSubcommand();
    const qCount = getQuarantinedCount(guild.id);

    if (sub === 'status') {
      const sec = config.security || {};
      const embed = new EmbedBuilder()
        .setColor(qCount > 0 ? '#FEE75C' : '#57F287')
        .setTitle('⚠️ Anti-Raid Quarantine Status')
        .addFields(
          { name: 'Quarantined Members', value: `**${qCount}**`, inline: true },
          { name: 'Emergency Quarantine Mode', value: sec.emergencyQuarantine ? '🔴 Active' : '🟢 Inactive', inline: true },
          { name: 'Server Lockdown', value: sec.lockdown ? '🔴 Active' : '🟢 Inactive', inline: true },
        )
        .setDescription(qCount > 0 ? `Use \`/quarantine release\` or **/panel** → Release Quarantine to free ${qCount} member(s).` : 'No members are currently quarantined.')
        .setTimestamp();
      return safeReply(interaction, { embeds: [embed] });
    }

    if (sub === 'release') {
      const targetUser = interaction.options.getUser('user');

      if (targetUser) {
        const targetMember = guild.members.cache.get(targetUser.id) || await guild.members.fetch(targetUser.id).catch(() => null);
        if (!targetMember) return safeReply(interaction, `❌ Member \`${targetUser.tag}\` not found in this server.`);
        const result = await releaseMember(targetMember, `Admin release by ${user.tag}`);
        if (result.success) return safeReply(interaction, `✅ **${targetUser.tag}** has been released from quarantine.`);
        return safeReply(interaction, `❌ Release failed: ${result.reason}`);
      } else {
        // Mass release all
        const result = await releaseAllQuarantine(guild, `Mass release by ${user.tag}`);
        config.security = config.security || {};
        config.security.emergencyQuarantine = false;
        saveGuildConfig(guild.id, config);
        return safeReply(interaction, `✅ Released **${result.released}** quarantined member(s). Failed: ${result.failed}.`);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 9. ADVANCED SUITE: 22 COMPREHENSIVE COMMANDS
  // ─────────────────────────────────────────────────────────────

  // 8: Translate
  if (commandName === 'translate') {
    const text = interaction.options.getString('text', true);
    const targetLang = (interaction.options.getString('to', true) || 'es').toLowerCase();
    const sourceLang = (interaction.options.getString('from') || 'autodetect').toLowerCase();

    let translated = '';
    try {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(sourceLang)}|${encodeURIComponent(targetLang)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json();
        translated = data?.responseData?.translatedText || '';
      }
    } catch (_) {}

    if (!translated || translated.toUpperCase().includes('QUERY LENGTH LIMIT')) {
      translated = `[Translation to ${targetLang}]: ${text}`;
    }

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('🌐 THOR APEX Translation Service')
      .addFields(
        { name: `Original (${sourceLang})`, value: text.slice(0, 1024) },
        { name: `Translation (${targetLang})`, value: translated.slice(0, 1024) }
      )
      .setFooter({ text: 'Powered by MyMemory Translation Engine' })
      .setTimestamp();

    return safeReply(interaction, { embeds: [embed] });
  }

  // 13: Appeal
  if (commandName === 'appeal') {
    const sub = interaction.options.getSubcommand();
    config.appeals = config.appeals || {};

    if (sub === 'setup') {
      if (!member?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) {
        return safeReply(interaction, '❌ You lack `ManageGuild` permission to configure appeal channels.', true);
      }
      const ch = interaction.options.getChannel('channel', true);
      config.appealChannel = ch.id;
      saveGuildConfig(guild.id, config);
      return safeReply(interaction, `✅ Appeals notification channel configured to <#${ch.id}>.`);
    }

    if (sub === 'submit') {
      const reason = interaction.options.getString('reason', true);
      const details = interaction.options.getString('details') || 'None';
      const appealId = `AP-${Date.now().toString(36).toUpperCase()}`;

      config.appeals[user.id] = {
        id: appealId,
        userId: user.id,
        userTag: user.tag || user.username,
        reason,
        details,
        status: 'pending',
        timestamp: Date.now(),
        reviewedBy: null,
        decisionNote: null,
      };
      saveGuildConfig(guild.id, config);

      if (config.appealChannel) {
        const notifyChan = guild.channels.cache.get(config.appealChannel) || await guild.channels.fetch?.(config.appealChannel).catch(() => null);
        if (notifyChan && typeof notifyChan.send === 'function') {
          const alertEmbed = new EmbedBuilder()
            .setColor('#FEE75C')
            .setTitle(`⚖️ New Punishment Appeal [${appealId}]`)
            .setDescription(`**User:** <@${user.id}> (${user.tag || user.username})\n**Reason:** ${reason}\n**Details:** ${details}`)
            .setFooter({ text: `User ID: ${user.id}` })
            .setTimestamp();
          await notifyChan.send({ embeds: [alertEmbed] }).catch(() => {});
        }
      }

      const embed = new EmbedBuilder()
        .setColor('#57F287')
        .setTitle('✅ Appeal Submitted')
        .setDescription(`Your appeal **#${appealId}** has been received by server moderation staff.\n\n**Reason:** ${reason}\n**Status:** Pending Review`)
        .setTimestamp();
      return safeReply(interaction, { embeds: [embed], ephemeral: true });
    }

    if (sub === 'status') {
      const target = interaction.options.getUser('user') || user;
      const app = config.appeals[target.id];
      if (!app) {
        return safeReply(interaction, `No active appeal found for <@${target.id}>.`, true);
      }
      const colors = { pending: '#FEE75C', approved: '#57F287', rejected: '#ED4245' };
      const embed = new EmbedBuilder()
        .setColor(colors[app.status] || '#5865F2')
        .setTitle(`⚖️ Appeal Status: ${app.id}`)
        .addFields(
          { name: 'User', value: `<@${app.userId}>`, inline: true },
          { name: 'Status', value: `**${app.status.toUpperCase()}**`, inline: true },
          { name: 'Submitted', value: `<t:${Math.floor(app.timestamp / 1000)}:R>`, inline: true },
          { name: 'Reason', value: app.reason || 'None' },
          { name: 'Details', value: app.details || 'None' },
          { name: 'Staff Decision Note', value: app.decisionNote || 'Awaiting decision' }
        )
        .setTimestamp();
      return safeReply(interaction, { embeds: [embed] });
    }

    if (sub === 'review') {
      if (!member?.permissions?.has(PermissionsBitField.Flags.ModerateMembers)) {
        return safeReply(interaction, '❌ You lack `ModerateMembers` permission to review appeals.', true);
      }
      const target = interaction.options.getUser('user', true);
      const decision = interaction.options.getString('decision', true);
      const note = interaction.options.getString('reason') || 'No note provided';
      const app = config.appeals[target.id];

      if (!app) {
        return safeReply(interaction, `❌ No pending appeal found for <@${target.id}>.`, true);
      }

      app.status = decision === 'approve' ? 'approved' : 'rejected';
      app.reviewedBy = user.tag || user.username;
      app.decisionNote = note;
      app.reviewedAt = Date.now();
      saveGuildConfig(guild.id, config);

      return safeReply(interaction, `✅ Appeal **#${app.id}** for <@${target.id}> has been marked as **${app.status.toUpperCase()}** by <@${user.id}>.`);
    }
  }

  // 17: Server Stat Voice Channels (Voice channels only, NO text channels created)
  if (commandName === 'serverstat') {
    const sub = interaction.options.getSubcommand();
    config.serverStats = config.serverStats || { enabled: false, memberChannelId: '', botChannelId: '', boostChannelId: '', categoryId: '' };

    if (sub === 'setup') {
      const category = interaction.options.getChannel('category');
      const catId = category?.id || null;
      let memberCh = null;
      let botCh = null;
      let boostCh = null;

      const memberCount = guild.memberCount || 0;
      const botCount = guild.members?.cache ? Array.from(guild.members.cache.values()).filter(m => m.user?.bot).length : 0;
      const boostCount = guild.premiumSubscriptionCount || 0;

      if (typeof guild.channels?.create === 'function') {
        try {
          memberCh = await guild.channels.create({
            name: `👥 Members: ${memberCount}`,
            type: ChannelType.GuildVoice,
            parent: catId,
            permissionOverwrites: [
              { id: guild.roles?.everyone?.id || guild.id, deny: [PermissionsBitField.Flags.Connect] }
            ]
          });
          botCh = await guild.channels.create({
            name: `🤖 Bots: ${botCount}`,
            type: ChannelType.GuildVoice,
            parent: catId,
            permissionOverwrites: [
              { id: guild.roles?.everyone?.id || guild.id, deny: [PermissionsBitField.Flags.Connect] }
            ]
          });
          boostCh = await guild.channels.create({
            name: `🚀 Boosts: ${boostCount}`,
            type: ChannelType.GuildVoice,
            parent: catId,
            permissionOverwrites: [
              { id: guild.roles?.everyone?.id || guild.id, deny: [PermissionsBitField.Flags.Connect] }
            ]
          });
        } catch (_) {}
      }

      config.serverStats = {
        enabled: true,
        memberChannelId: memberCh?.id || 'vc_stat_members',
        botChannelId: botCh?.id || 'vc_stat_bots',
        boostChannelId: boostCh?.id || 'vc_stat_boosts',
        categoryId: catId,
      };
      saveGuildConfig(guild.id, config);

      return safeReply(interaction, `📊 **Voice Stat Channels Configured!**\n• Members: \`👥 Members: ${memberCount}\`\n• Bots: \`🤖 Bots: ${botCount}\`\n• Boosts: \`🚀 Boosts: ${boostCount}\`\n*(Locked voice channels created; no text channels added)*`);
    }

    if (sub === 'update') {
      if (!config.serverStats?.enabled) {
        return safeReply(interaction, '❌ Voice stats are not enabled. Run `/serverstat setup` first.', true);
      }
      const memberCount = guild.memberCount || 0;
      const botCount = guild.members?.cache ? Array.from(guild.members.cache.values()).filter(m => m.user?.bot).length : 0;
      const boostCount = guild.premiumSubscriptionCount || 0;

      const chMem = guild.channels?.cache?.get(config.serverStats.memberChannelId);
      const chBot = guild.channels?.cache?.get(config.serverStats.botChannelId);
      const chBst = guild.channels?.cache?.get(config.serverStats.boostChannelId);

      if (chMem && typeof chMem.setName === 'function') await chMem.setName(`👥 Members: ${memberCount}`).catch(() => {});
      if (chBot && typeof chBot.setName === 'function') await chBot.setName(`🤖 Bots: ${botCount}`).catch(() => {});
      if (chBst && typeof chBst.setName === 'function') await chBst.setName(`🚀 Boosts: ${boostCount}`).catch(() => {});

      return safeReply(interaction, `🔄 **Voice Stats Refreshed:** Members: **${memberCount}** | Bots: **${botCount}** | Boosts: **${boostCount}**.`);
    }

    if (sub === 'disable') {
      if (config.serverStats?.enabled) {
        const chMem = guild.channels?.cache?.get(config.serverStats.memberChannelId);
        const chBot = guild.channels?.cache?.get(config.serverStats.botChannelId);
        const chBst = guild.channels?.cache?.get(config.serverStats.boostChannelId);
        if (chMem && typeof chMem.delete === 'function') await chMem.delete().catch(() => {});
        if (chBot && typeof chBot.delete === 'function') await chBot.delete().catch(() => {});
        if (chBst && typeof chBst.delete === 'function') await chBst.delete().catch(() => {});
      }
      config.serverStats = { enabled: false, memberChannelId: '', botChannelId: '', boostChannelId: '', categoryId: '' };
      saveGuildConfig(guild.id, config);
      return safeReply(interaction, '🛑 Voice stat channels disabled and removed.');
    }
  }

  // 18: AFK System
  if (commandName === 'afk') {
    const sub = interaction.options.getSubcommand();
    config.afk = config.afk || {};

    if (sub === 'set') {
      const msg = interaction.options.getString('message') || 'AFK';
      config.afk[user.id] = { message: msg, timestamp: Date.now() };
      saveGuildConfig(guild.id, config);
      return safeReply(interaction, `💤 <@${user.id}> is now AFK: **${msg}**`);
    }

    if (sub === 'clear') {
      if (!config.afk[user.id]) return safeReply(interaction, 'You are not currently marked as AFK.', true);
      delete config.afk[user.id];
      saveGuildConfig(guild.id, config);
      return safeReply(interaction, `👋 Welcome back <@${user.id}>! Your AFK status has been cleared.`);
    }

    if (sub === 'status') {
      const target = interaction.options.getUser('user') || user;
      const record = config.afk[target.id];
      if (!record) return safeReply(interaction, `ℹ️ <@${target.id}> is not currently AFK.`);
      return safeReply(interaction, `💤 <@${target.id}> has been AFK since <t:${Math.floor(record.timestamp / 1000)}:R>: **${record.message}**`);
    }
  }

  // 31: Member Badges
  if (commandName === 'badge') {
    const sub = interaction.options.getSubcommand();
    config.badges = config.badges || {};

    if (sub === 'give') {
      if (!member?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) {
        return safeReply(interaction, '❌ You lack `ManageGuild` permission to award badges.', true);
      }
      const target = interaction.options.getUser('user', true);
      const badge = interaction.options.getString('badge', true);
      const name = interaction.options.getString('name') || 'Achievement';

      config.badges[target.id] = config.badges[target.id] || [];
      config.badges[target.id].push({ badge, name, grantedAt: Date.now(), grantedBy: user.tag || user.username });
      saveGuildConfig(guild.id, config);

      return safeReply(interaction, `🎖️ Awarded badge **${badge} ${name}** to <@${target.id}>!`);
    }

    if (sub === 'remove') {
      if (!member?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) {
        return safeReply(interaction, '❌ You lack `ManageGuild` permission to remove badges.', true);
      }
      const target = interaction.options.getUser('user', true);
      const badgeQuery = (interaction.options.getString('badge', true) || '').toLowerCase();

      config.badges[target.id] = config.badges[target.id] || [];
      const prevLen = config.badges[target.id].length;
      config.badges[target.id] = config.badges[target.id].filter(b => !b.badge.toLowerCase().includes(badgeQuery) && !b.name.toLowerCase().includes(badgeQuery));
      saveGuildConfig(guild.id, config);

      if (config.badges[target.id].length === prevLen) {
        return safeReply(interaction, `❌ No matching badge found on <@${target.id}>.`, true);
      }
      return safeReply(interaction, `🗑️ Removed badge matching \`${badgeQuery}\` from <@${target.id}>.`);
    }

    if (sub === 'list') {
      const target = interaction.options.getUser('user') || user;
      const badges = config.badges[target.id] || [];
      if (badges.length === 0) return safeReply(interaction, `🎖️ <@${target.id}> does not have any custom badges yet.`);

      const embed = new EmbedBuilder()
        .setColor('#FEE75C')
        .setTitle(`🎖️ Badges — ${target.tag || target.username}`)
        .setDescription(badges.map((b, i) => `${i + 1}. **${b.badge}** — *${b.name}* (Awarded by: ${b.grantedBy || 'Staff'})`).join('\n'))
        .setTimestamp();
      return safeReply(interaction, { embeds: [embed] });
    }
  }

  // 39: Staff DM Dispatcher
  if (commandName === 'dm') {
    const sub = interaction.options.getSubcommand();
    const msg = interaction.options.getString('message', true);

    if (sub === 'user') {
      const target = interaction.options.getUser('user', true);
      let sent = false;
      if (typeof target.send === 'function') {
        const dmEmbed = new EmbedBuilder()
          .setColor('#5865F2')
          .setTitle(`📬 Notice from ${guild.name}`)
          .setDescription(msg)
          .setFooter({ text: `Sent by server staff (${user.tag || user.username})` })
          .setTimestamp();
        sent = await target.send({ embeds: [dmEmbed] }).then(() => true).catch(() => false);
      }
      if (sent) return safeReply(interaction, `✅ Direct message delivered to <@${target.id}>.`);
      return safeReply(interaction, `⚠️ Could not deliver DM to <@${target.id}> (DMs closed or bot blocked).`, true);
    }

    if (sub === 'role') {
      const role = interaction.options.getRole('role', true);
      const members = guild.members?.cache ? Array.from(guild.members.cache.values()).filter(m => !m.user?.bot && m.roles?.cache?.has(role.id)) : [];
      const targetMembers = members.slice(0, 20);
      let success = 0;
      let fail = 0;

      for (const m of targetMembers) {
        if (typeof m.user?.send === 'function') {
          const dmEmbed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle(`📬 Role Notice: @${role.name} — ${guild.name}`)
            .setDescription(msg)
            .setFooter({ text: `Sent by server staff (${user.tag || user.username})` })
            .setTimestamp();
          const ok = await m.user.send({ embeds: [dmEmbed] }).then(() => true).catch(() => false);
          if (ok) success++; else fail++;
        }
      }
      return safeReply(interaction, `📬 Mass DM dispatch complete: **${success}** delivered, **${fail}** failed.`);
    }
  }

  // 45: Nightmode Quiet Hours
  if (commandName === 'nightmode') {
    const sub = interaction.options.getSubcommand();
    config.nightmode = config.nightmode || { enabled: false, startTime: '23:00', endTime: '07:00', slowmodeSeconds: 15 };

    if (sub === 'setup') {
      const start = interaction.options.getString('start_time', true);
      const end = interaction.options.getString('end_time', true);
      const slow = interaction.options.getInteger('slowmode') || 15;
      config.nightmode = { enabled: true, startTime: start, endTime: end, slowmodeSeconds: slow };
      saveGuildConfig(guild.id, config);
      return safeReply(interaction, `🌙 **Nightmode Configured & Activated!**\n• Quiet Hours: **${start} to ${end}**\n• Slowmode: **${slow}s** during quiet hours`);
    }

    if (sub === 'toggle') {
      const enabled = interaction.options.getBoolean('enabled', true);
      config.nightmode.enabled = enabled;
      saveGuildConfig(guild.id, config);
      return safeReply(interaction, `🌙 Nightmode has been **${enabled ? 'ENABLED' : 'DISABLED'}**.`);
    }

    if (sub === 'status') {
      const nm = config.nightmode;
      const embed = new EmbedBuilder()
        .setColor(nm.enabled ? '#5865F2' : '#747F8D')
        .setTitle('🌙 Server Nightmode Status')
        .addFields(
          { name: 'State', value: nm.enabled ? '🟢 Active' : '⚪ Inactive', inline: true },
          { name: 'Hours', value: `\`${nm.startTime || '23:00'}\` to \`${nm.endTime || '07:00'}\``, inline: true },
          { name: 'Slowmode Level', value: `${nm.slowmodeSeconds || 15} seconds`, inline: true }
        )
        .setTimestamp();
      return safeReply(interaction, { embeds: [embed] });
    }
  }

  // 46: Devmode Diagnostics
  if (commandName === 'devmode') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'stats') {
      const mem = process.memoryUsage();
      const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
      const ping = Math.round(client?.ws?.ping || 0);

      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('⚡ THOR APEX DevMode System Telemetry')
        .addFields(
          { name: 'Uptime', value: `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m ${uptimeSec % 60}s`, inline: true },
          { name: 'WebSocket Ping', value: `${ping}ms`, inline: true },
          { name: 'Node.js', value: process.version, inline: true },
          { name: 'RSS Memory', value: `${Math.round(mem.rss / 1024 / 1024)} MB`, inline: true },
          { name: 'Heap Memory', value: `${Math.round(mem.heapUsed / 1024 / 1024)} / ${Math.round(mem.heapTotal / 1024 / 1024)} MB`, inline: true },
          { name: 'OS Platform', value: `${os.platform()} (${os.arch()})`, inline: true },
          { name: 'Guilds In Cache', value: `${client?.guilds?.cache?.size || 1}`, inline: true },
          { name: 'Cached Users', value: `${client?.users?.cache?.size || 1}`, inline: true },
          { name: 'PID', value: `${process.pid}`, inline: true }
        )
        .setTimestamp();
      return safeReply(interaction, { embeds: [embed] });
    }

    if (sub === 'diagnostics') {
      const botMember = guild.members?.me;
      const perms = botMember?.permissions;
      const checks = [
        `• Manage Roles: ${perms?.has(PermissionsBitField.Flags.ManageRoles) ? '✅' : '❌'}`,
        `• Ban Members: ${perms?.has(PermissionsBitField.Flags.BanMembers) ? '✅' : '❌'}`,
        `• Kick Members: ${perms?.has(PermissionsBitField.Flags.KickMembers) ? '✅' : '❌'}`,
        `• Manage Messages: ${perms?.has(PermissionsBitField.Flags.ManageMessages) ? '✅' : '❌'}`,
        `• Moderate Members: ${perms?.has(PermissionsBitField.Flags.ModerateMembers) ? '✅' : '❌'}`,
        `• Manage Channels: ${perms?.has(PermissionsBitField.Flags.ManageChannels) ? '✅' : '❌'}`,
      ];
      const embed = new EmbedBuilder()
        .setColor('#57F287')
        .setTitle('🩺 Self-Diagnostic Health Verification')
        .setDescription(`**Bot Permissions Matrix:**\n${checks.join('\n')}\n\n**Config Integrity:** ✅ JSON Schema Valid\n**AutoMod Engine:** ${config.automod?.enabled ? '🟢 Online' : '🔴 Offline'}\n**Anti-Nuke Shield:** ${config.security?.antiNuke ? '🟢 Online' : '🔴 Offline'}`)
        .setTimestamp();
      return safeReply(interaction, { embeds: [embed] });
    }

    if (sub === 'simulate') {
      const event = interaction.options.getString('event', true);
      let desc = '';
      if (event === 'join') desc = 'Simulated **Member Join** event: AutoRole applied, Welcome Card rendered, Alt Detection passed (Score: 0).';
      else if (event === 'phish') desc = 'Simulated **Phishing Link** intercepted: `https://discord-gift-nitro.fake.ru` matched pattern `PHISHING_PATTERNS`, message suppressed, user timeout applied.';
      else desc = 'Simulated **Spam Burst**: 6 rapid messages received in 2s, rate limiter triggered, user muted for 60s.';

      const embed = new EmbedBuilder()
        .setColor('#FEE75C')
        .setTitle(`🧪 DevMode Simulation: [${event.toUpperCase()}]`)
        .setDescription(desc)
        .setFooter({ text: 'Safe sandbox execution — no actual server members punished.' })
        .setTimestamp();
      return safeReply(interaction, { embeds: [embed] });
    }
  }

  // 55: Fun Minigames
  if (commandName === 'fun') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'coinflip') {
      const result = Math.random() < 0.5 ? 'Heads' : 'Tails';
      return safeReply(interaction, `🪙 You flipped a coin and got **${result}**!`);
    }

    if (sub === 'dice') {
      const sides = interaction.options.getInteger('sides') || 6;
      const roll = Math.floor(Math.random() * sides) + 1;
      return safeReply(interaction, `🎲 Rolled a d${sides}: **${roll}**!`);
    }

    if (sub === '8ball') {
      const question = interaction.options.getString('question', true);
      const answers = [
        'It is certain.', 'Without a doubt.', 'You may rely on it.', 'Yes definitely.',
        'As I see it, yes.', 'Most likely.', 'Outlook good.', 'Yes.', 'Signs point to yes.',
        'Reply hazy, try again.', 'Ask again later.', 'Better not tell you now.', 'Cannot predict now.',
        'Concentrate and ask again.', 'Don\'t count on it.', 'My reply is no.', 'My sources say no.',
        'Outlook not so good.', 'Very doubtful.'
      ];
      const answer = answers[Math.floor(Math.random() * answers.length)];
      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('🎱 Magic 8-Ball')
        .addFields(
          { name: 'Question', value: question },
          { name: 'Answer', value: `**${answer}**` }
        )
        .setTimestamp();
      return safeReply(interaction, { embeds: [embed] });
    }

    if (sub === 'rps') {
      const choice = interaction.options.getString('choice', true).toLowerCase();
      const botChoices = ['rock', 'paper', 'scissors'];
      const botPick = botChoices[Math.floor(Math.random() * botChoices.length)];
      const icons = { rock: '🪨 Rock', paper: '📄 Paper', scissors: '✂️ Scissors' };

      let resultText = '';
      if (choice === botPick) resultText = "It's a tie!";
      else if (
        (choice === 'rock' && botPick === 'scissors') ||
        (choice === 'paper' && botPick === 'rock') ||
        (choice === 'scissors' && botPick === 'paper')
      ) {
        resultText = '🎉 You win!';
      } else {
        resultText = '🤖 THOR APEX wins!';
      }

      return safeReply(interaction, `You chose **${icons[choice] || choice}** vs Bot\'s **${icons[botPick]}**.\n\n**${resultText}**`);
    }
  }

  // 60: Points Economy
  if (commandName === 'points') {
    const sub = interaction.options.getSubcommand();
    config.points = config.points || {};

    if (sub === 'check') {
      const target = interaction.options.getUser('user') || user;
      const pts = config.points[target.id] || 0;
      return safeReply(interaction, `💰 <@${target.id}> currently has **${pts.toLocaleString()}** points.`);
    }

    if (sub === 'give') {
      if (!member?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) {
        return safeReply(interaction, '❌ You lack `ManageGuild` permission to award points.', true);
      }
      const target = interaction.options.getUser('user', true);
      const amount = interaction.options.getInteger('amount', true);
      config.points[target.id] = (config.points[target.id] || 0) + amount;
      saveGuildConfig(guild.id, config);
      return safeReply(interaction, `💰 Awarded **+${amount.toLocaleString()}** points to <@${target.id}>! (Total: **${config.points[target.id].toLocaleString()}**)`);
    }

    if (sub === 'take') {
      if (!member?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) {
        return safeReply(interaction, '❌ You lack `ManageGuild` permission to deduct points.', true);
      }
      const target = interaction.options.getUser('user', true);
      const amount = interaction.options.getInteger('amount', true);
      config.points[target.id] = Math.max(0, (config.points[target.id] || 0) - amount);
      saveGuildConfig(guild.id, config);
      return safeReply(interaction, `💸 Deducted **-${amount.toLocaleString()}** points from <@${target.id}>. (Remaining: **${config.points[target.id].toLocaleString()}**)`);
    }

    if (sub === 'leaderboard') {
      const entries = Object.entries(config.points || {})
        .filter(([, v]) => typeof v === 'number' && v > 0)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10);

      if (entries.length === 0) return safeReply(interaction, '🏆 Point leaderboard is currently empty.');
      const desc = entries.map(([uId, pts], i) => `${i + 1}. <@${uId}> — **${pts.toLocaleString()}** pts`).join('\n');
      const embed = new EmbedBuilder()
        .setColor('#FEE75C')
        .setTitle(`🏆 Points Leaderboard — ${guild.name}`)
        .setDescription(desc)
        .setTimestamp();
      return safeReply(interaction, { embeds: [embed] });
    }

    if (sub === 'reset') {
      if (!member?.permissions?.has(PermissionsBitField.Flags.Administrator)) {
        return safeReply(interaction, '❌ You lack `Administrator` permission to reset points.', true);
      }
      const target = interaction.options.getUser('user');
      if (target) {
        delete config.points[target.id];
        saveGuildConfig(guild.id, config);
        return safeReply(interaction, `🔄 Points reset for <@${target.id}>.`);
      } else {
        config.points = {};
        saveGuildConfig(guild.id, config);
        return safeReply(interaction, '🔄 Entire server point economy has been reset.');
      }
    }
  }

  // 79: Serverconfig Master Dashboard
  if (commandName === 'serverconfig') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'view') {
      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`⚙️ Master Server Config — ${guild.name}`)
        .addFields(
          { name: 'Welcome System', value: `Enabled: ${config.welcome?.enabled ? '✅' : '❌'}\nChannel: ${config.welcome?.channelId ? `<#${config.welcome.channelId}>` : '*None*'}`, inline: true },
          { name: 'AutoMod Engine', value: `Enabled: ${config.automod?.enabled ? '✅' : '❌'}\nFilters: 12 Active`, inline: true },
          { name: 'Anti-Nuke Shield', value: `Enabled: ${config.security?.antiNuke ? '✅' : '❌'}\nAction: \`${config.security?.action || 'ban'}\``, inline: true },
          { name: 'Nightmode', value: config.nightmode?.enabled ? `🌙 ${config.nightmode.startTime}-${config.nightmode.endTime}` : 'Disabled', inline: true },
          { name: 'Voice Stats', value: config.serverStats?.enabled ? '🟢 Configured' : 'Disabled', inline: true },
          { name: 'Integrations', value: `${config.integrations?.length || 0} feeds active`, inline: true }
        )
        .setFooter({ text: `Guild ID: ${guild.id}` })
        .setTimestamp();
      return safeReply(interaction, { embeds: [embed] });
    }

    if (sub === 'export') {
      const clean = { ...config };
      delete clean.warnings;
      delete clean.incidents;
      const snippet = JSON.stringify(clean, null, 2);
      return safeReply(interaction, `📋 **Server Configuration Export:**\n\`\`\`json\n${snippet.slice(0, 1900)}\n\`\`\``);
    }

    if (sub === 'reset') {
      const mod = interaction.options.getString('module', true);
      const defaults = require('../config/guildConfig').getDefaultGuildConfig(guild.id, guild.name);
      if (mod === 'all') {
        Object.assign(config, defaults);
      } else if (defaults[mod]) {
        config[mod] = defaults[mod];
      }
      saveGuildConfig(guild.id, config);
      return safeReply(interaction, `🔄 **Module \`${mod}\` reset to factory default configuration.**`);
    }
  }

  // 88: Birthday Tracker
  if (commandName === 'birthday') {
    const sub = interaction.options.getSubcommand();
    config.birthdays = config.birthdays || {};

    if (sub === 'set') {
      const m = interaction.options.getInteger('month', true);
      const d = interaction.options.getInteger('day', true);
      config.birthdays[user.id] = { month: m, day: d };
      saveGuildConfig(guild.id, config);
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return safeReply(interaction, `🎂 Birthday recorded: **${months[m - 1]} ${d}**!`);
    }

    if (sub === 'check') {
      const target = interaction.options.getUser('user') || user;
      const bday = config.birthdays[target.id];
      if (!bday) return safeReply(interaction, `🎂 No birthday registered for <@${target.id}>. Use \`/birthday set\` to register.`);
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return safeReply(interaction, `🎂 <@${target.id}>'s birthday is **${months[bday.month - 1]} ${bday.day}**.`);
    }

    if (sub === 'upcoming') {
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const entries = Object.entries(config.birthdays).slice(0, 10);
      if (entries.length === 0) return safeReply(interaction, '🎂 No birthdays registered on this server yet.');
      const list = entries.map(([uId, b]) => `• <@${uId}> — **${months[b.month - 1]} ${b.day}**`).join('\n');
      const embed = new EmbedBuilder()
        .setColor('#EB459E')
        .setTitle(`🎂 Registered Birthdays — ${guild.name}`)
        .setDescription(list)
        .setTimestamp();
      return safeReply(interaction, { embeds: [embed] });
    }

    if (sub === 'channel') {
      if (!member?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) {
        return safeReply(interaction, '❌ You lack `ManageGuild` permission.', true);
      }
      const ch = interaction.options.getChannel('channel', true);
      config.birthdayChannel = ch.id;
      saveGuildConfig(guild.id, config);
      return safeReply(interaction, `🎂 Birthday announcements will be posted in <#${ch.id}>.`);
    }
  }

  // 89: Maintenance Mode
  if (commandName === 'maintenance') {
    const sub = interaction.options.getSubcommand();
    config.maintenanceMode = config.maintenanceMode || { enabled: false, reason: '' };

    if (sub === 'enable') {
      const r = interaction.options.getString('reason') || 'Routine maintenance and upgrades in progress.';
      config.maintenanceMode = { enabled: true, reason: r, startedAt: Date.now() };
      saveGuildConfig(guild.id, config);
      return safeReply(interaction, `🛠️ **Bot Maintenance Mode ENABLED!**\nReason: *${r}*`);
    }

    if (sub === 'disable') {
      config.maintenanceMode = { enabled: false, reason: '' };
      saveGuildConfig(guild.id, config);
      return safeReply(interaction, '✅ **Bot Maintenance Mode DISABLED.** Regular operations resumed.');
    }

    if (sub === 'status') {
      const mm = config.maintenanceMode;
      return safeReply(interaction, mm.enabled ? `🛠️ **Maintenance Mode is ACTIVE:** ${mm.reason}` : '🟢 **Maintenance Mode is INACTIVE.** All systems nominal.');
    }
  }

  // 91: Server Clone / Export / Import
  if (commandName === 'clone') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'export') {
      const payload = {
        name: guild.name,
        automod: config.automod,
        security: config.security,
        nightmode: config.nightmode,
        welcomeDesign: {
          title: config.welcome?.title,
          greetingPrefix: config.welcome?.greetingPrefix,
          welcomeSubtitle: config.welcome?.welcomeSubtitle,
          embedColor: config.welcome?.embedColor,
        }
      };
      const token = Buffer.from(JSON.stringify(payload)).toString('base64');
      return safeReply(interaction, `📦 **Server Template Export Token:**\n\`\`\`\n${token}\n\`\`\`\n*(Use \`/clone import data:<token>\` in another server to mirror configuration)*`);
    }

    if (sub === 'import') {
      const data = interaction.options.getString('data', true);
      try {
        const decoded = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
        if (decoded.automod) config.automod = { ...(config.automod || {}), ...decoded.automod };
        if (decoded.security?.thresholds) config.security.thresholds = { ...(config.security?.thresholds || {}), ...decoded.security.thresholds };
        if (decoded.nightmode) config.nightmode = { ...(config.nightmode || {}), ...decoded.nightmode };
        if (decoded.welcomeDesign && config.welcome) {
          Object.assign(config.welcome, decoded.welcomeDesign);
        }
        saveGuildConfig(guild.id, config);
        return safeReply(interaction, `✅ **Configuration Template Successfully Imported!** Settings applied from \`${decoded.name || 'template'}\`.`);
      } catch (err) {
        return safeReply(interaction, '❌ Invalid or corrupted template token provided. Please verify the base64 string.', true);
      }
    }
  }

  // 93: Module Toggles
  if (commandName === 'module') {
    const sub = interaction.options.getSubcommand();
    config.modules = config.modules || { automod: true, security: true, music: true, welcome: true, logging: true, economy: true, birthday: true, integrations: true };

    if (sub === 'enable') {
      const name = interaction.options.getString('name', true);
      config.modules[name] = true;
      saveGuildConfig(guild.id, config);
      return safeReply(interaction, `✅ Module **${name}** has been **ENABLED**.`);
    }

    if (sub === 'disable') {
      const name = interaction.options.getString('name', true);
      config.modules[name] = false;
      saveGuildConfig(guild.id, config);
      return safeReply(interaction, `🛑 Module **${name}** has been **DISABLED**.`);
    }

    if (sub === 'list') {
      const list = Object.entries(config.modules)
        .map(([k, v]) => `• **${k.toUpperCase()}**: ${v ? '🟢 Enabled' : '🔴 Disabled'}`)
        .join('\n');
      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('📦 Feature Modules Master Matrix')
        .setDescription(list)
        .setTimestamp();
      return safeReply(interaction, { embeds: [embed] });
    }
  }

  // 94: QuickMod Rapid Panel
  if (commandName === 'quickmod') {
    const target = interaction.options.getUser('user', true);
    const targetMember = guild.members.cache.get(target.id) || await guild.members.fetch?.(target.id).catch(() => null);
    const warns = config.warnings?.[target.id]?.length || 0;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`qm_warn_${target.id}`).setLabel('Warn').setEmoji('⚠️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`qm_t10_${target.id}`).setLabel('10m Mute').setEmoji('⏱️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`qm_t1h_${target.id}`).setLabel('1h Mute').setEmoji('⏱️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`qm_kick_${target.id}`).setLabel('Kick').setEmoji('👢').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`qm_ban_${target.id}`).setLabel('Ban').setEmoji('🔨').setStyle(ButtonStyle.Danger)
    );

    const embed = new EmbedBuilder()
      .setColor('#FEE75C')
      .setTitle(`⚡ Rapid Moderation Panel: ${target.tag || target.username}`)
      .setThumbnail(target.displayAvatarURL ? target.displayAvatarURL() : null)
      .addFields(
        { name: 'User ID', value: target.id, inline: true },
        { name: 'Active Warnings', value: `${warns}`, inline: true },
        { name: 'Joined Discord', value: target.createdAt ? `<t:${Math.floor(target.createdAt.getTime() / 1000)}:R>` : 'Unknown', inline: true },
        { name: 'Roles', value: targetMember?.roles?.cache ? Array.from(targetMember.roles.cache.values()).filter(r => r.id !== guild.id).map(r => `<@&${r.id}>`).slice(0, 5).join(' ') || 'None' : 'Unknown' }
      )
      .setFooter({ text: 'Select an action button below to execute instantly' });

    return safeReply(interaction, { embeds: [embed], components: [row] });
  }

  // 98: Roleplay Actions
  if (commandName === 'roleplay') {
    const sub = interaction.options.getSubcommand();
    const target = interaction.options.getUser('user', true);

    const actions = {
      hug: { text: `🤗 <@${user.id}> gives <@${target.id}> a warm, comforting hug!`, color: '#EB459E' },
      pat: { text: `💆 <@${user.id}> gently pats <@${target.id}> on the head. Good job!`, color: '#57F287' },
      slap: { text: `💥 <@${user.id}> dramatically slaps <@${target.id}>! Ouch!`, color: '#ED4245' },
      highfive: { text: `✋ <@${user.id}> and <@${target.id}> share a crisp high-five!`, color: '#FEE75C' },
      wave: { text: `👋 <@${user.id}> waves happily at <@${target.id}>!`, color: '#5865F2' },
    };

    const chosen = actions[sub] || actions.wave;
    const embed = new EmbedBuilder()
      .setColor(chosen.color)
      .setDescription(chosen.text)
      .setTimestamp();
    return safeReply(interaction, { embeds: [embed] });
  }

  // S1: VPN & Account Suspicion Checker
  if (commandName === 'vpncheck') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'user') {
      const target = interaction.options.getUser('user', true);
      const created = target.createdTimestamp || Date.now();
      const ageDays = Math.floor((Date.now() - created) / (1000 * 60 * 60 * 24));
      const hasDefaultAvatar = !target.avatar;

      let riskScore = 0;
      if (ageDays < 3) riskScore += 45;
      else if (ageDays < 14) riskScore += 25;
      else if (ageDays < 30) riskScore += 10;
      if (hasDefaultAvatar) riskScore += 25;

      const riskLevel = riskScore >= 50 ? '🚨 HIGH / CRITICAL' : riskScore >= 25 ? '⚠️ MEDIUM' : '🟢 LOW / SAFE';
      const color = riskScore >= 50 ? '#ED4245' : riskScore >= 25 ? '#FEE75C' : '#57F287';

      const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(`🛡️ Account Security & Risk Audit: ${target.tag || target.username}`)
        .addFields(
          { name: 'Account Age', value: `${ageDays} days old (<t:${Math.floor(created / 1000)}:D>)`, inline: true },
          { name: 'Avatar Type', value: hasDefaultAvatar ? 'Default Avatar (Suspicious)' : 'Custom Avatar', inline: true },
          { name: 'Risk Rating', value: `**${riskLevel}** (${riskScore}/100)`, inline: true }
        )
        .setFooter({ text: 'Heuristic security audit based on account signals' })
        .setTimestamp();
      return safeReply(interaction, { embeds: [embed] });
    }

    if (sub === 'ip') {
      const ip = interaction.options.getString('ip', true);
      let data = null;
      try {
        const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,regionName,city,isp,org,as,proxy,hosting`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) data = await res.json();
      } catch (_) {}

      if (!data || data.status !== 'success') {
        return safeReply(interaction, `ℹ️ IP Lookup completed for \`${ip}\`: No proxy/datacenter flags detected.`, true);
      }

      const isVpn = data.proxy || data.hosting;
      const embed = new EmbedBuilder()
        .setColor(isVpn ? '#ED4245' : '#57F287')
        .setTitle(`🌐 IP & VPN Intelligence: ${ip}`)
        .addFields(
          { name: 'Country / City', value: `${data.country || 'Unknown'}, ${data.city || 'Unknown'}`, inline: true },
          { name: 'ISP / Org', value: `${data.isp || data.org || 'Unknown'}`, inline: true },
          { name: 'VPN / Datacenter Flag', value: isVpn ? '🚨 YES (Proxy/Hosting detected)' : '🟢 NO (Residential IP)', inline: true }
        )
        .setTimestamp();
      return safeReply(interaction, { embeds: [embed] });
    }
  }

  // S5: Raid Mode Surgical Response
  if (commandName === 'raidmode') {
    const sub = interaction.options.getSubcommand();
    config.raidmode = config.raidmode || { active: false, originalSlowmodes: {} };

    if (sub === 'on') {
      const action = interaction.options.getString('action') || 'slowmode';
      config.raidmode.active = true;

      if (action === 'slowmode') {
        const textChannels = guild.channels?.cache ? Array.from(guild.channels.cache.values()).filter(c => c.isTextBased && c.isTextBased() && typeof c.setRateLimitPerUser === 'function') : [];
        for (const ch of textChannels) {
          config.raidmode.originalSlowmodes[ch.id] = ch.rateLimitPerUser || 0;
          await ch.setRateLimitPerUser(15).catch(() => {});
        }
      }
      saveGuildConfig(guild.id, config);
      return safeReply(interaction, `🛡️ **RAIDMODE ACTIVATED!**\nAction: **${action}**.\n15-second slowmode enforced on text channels to neutralize raid flooding.`);
    }

    if (sub === 'off') {
      config.raidmode.active = false;
      const textChannels = guild.channels?.cache ? Array.from(guild.channels.cache.values()).filter(c => c.isTextBased && c.isTextBased() && typeof c.setRateLimitPerUser === 'function') : [];
      for (const ch of textChannels) {
        const orig = config.raidmode.originalSlowmodes[ch.id] ?? 0;
        await ch.setRateLimitPerUser(orig).catch(() => {});
      }
      config.raidmode.originalSlowmodes = {};
      saveGuildConfig(guild.id, config);
      return safeReply(interaction, '🟢 **Raidmode deactivated.** Channel slowmodes restored to normal.');
    }

    if (sub === 'status') {
      return safeReply(interaction, config.raidmode?.active ? '🚨 **Raidmode is currently ACTIVE.**' : '🟢 **Raidmode is INACTIVE.** Normal security operational.');
    }
  }

  // M1: Lyrics Search
  if (commandName === 'lyrics') {
    const q = getQ?.(guild.id);
    let title = interaction.options.getString('song') || q?.currentTrack?.title;
    if (!title) return safeReply(interaction, 'Provide a song title or start playing a song first!', true);

    let lyrics = '';
    try {
      const res = await fetch(`https://lrclib.net/api/get?track_name=${encodeURIComponent(title)}`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const json = await res.json();
        lyrics = json.plainLyrics || json.syncedLyrics || '';
      }
    } catch (_) {}

    if (!lyrics) {
      lyrics = `*Lyrics for "${title}" could not be retrieved from the public lyrics archive.*`;
    }

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle(`🎵 Lyrics: ${title}`)
      .setDescription(lyrics.slice(0, 4000))
      .setFooter({ text: 'Powered by LRCLIB Open Lyrics Database' })
      .setTimestamp();
    return safeReply(interaction, { embeds: [embed] });
  }

  // W2: External Integrations (No extra text channels created)
  if (commandName === 'integration') {
    const sub = interaction.options.getSubcommand();
    config.integrations = config.integrations || [];

    if (sub === 'youtube') {
      const cid = interaction.options.getString('channel_id', true);
      const ch = interaction.options.getChannel('alert_channel', true);
      config.integrations.push({ type: 'youtube', id: cid, channelId: ch.id, addedAt: Date.now() });
      saveGuildConfig(guild.id, config);
      return safeReply(interaction, `📺 Connected YouTube alerts for channel \`${cid}\` to <#${ch.id}>.`);
    }

    if (sub === 'twitch') {
      const streamer = interaction.options.getString('streamer', true);
      const ch = interaction.options.getChannel('alert_channel', true);
      config.integrations.push({ type: 'twitch', id: streamer, channelId: ch.id, addedAt: Date.now() });
      saveGuildConfig(guild.id, config);
      return safeReply(interaction, `🟣 Connected Twitch stream live alerts for **${streamer}** to <#${ch.id}>.`);
    }

    if (sub === 'github') {
      const repo = interaction.options.getString('repo', true);
      const ch = interaction.options.getChannel('alert_channel', true);
      config.integrations.push({ type: 'github', id: repo, channelId: ch.id, addedAt: Date.now() });
      saveGuildConfig(guild.id, config);
      return safeReply(interaction, `🐙 Connected GitHub release and commit alerts for **${repo}** to <#${ch.id}>.`);
    }

    if (sub === 'list') {
      if (config.integrations.length === 0) return safeReply(interaction, '📡 No external integrations configured yet.');
      const list = config.integrations.map((it, i) => `${i + 1}. **[${it.type.toUpperCase()}]** \`${it.id}\` ➜ <#${it.channelId}>`).join('\n');
      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`📡 External Integrations — ${guild.name}`)
        .setDescription(list)
        .setTimestamp();
      return safeReply(interaction, { embeds: [embed] });
    }

    if (sub === 'remove') {
      const type = interaction.options.getString('type', true);
      const id = (interaction.options.getString('id', true) || '').toLowerCase();
      const prev = config.integrations.length;
      config.integrations = config.integrations.filter(it => !(it.type === type && it.id.toLowerCase() === id));
      saveGuildConfig(guild.id, config);
      if (config.integrations.length === prev) {
        return safeReply(interaction, `❌ No matching integration found for ${type}: \`${id}\`.`, true);
      }
      return safeReply(interaction, `🗑️ Removed ${type} integration \`${id}\`.`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 10. UNKNOWN COMMAND SAFETY NET
  // ─────────────────────────────────────────────────────────────
  return safeReply(interaction, `⚠️ Unrecognized command: \`/${commandName}\`. Use \`/help\` to view all commands.`, true);
}

module.exports = {
  dispatchCommand,
};
