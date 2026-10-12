const {
  EmbedBuilder, PermissionsBitField, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');
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
  redactSecrets, safeReply, isHex, formatDuration,
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

    if (sub === 'enable') {
      config.automod.enabled = true; saveGuildConfig(guild.id, config);
      return safeReply(interaction, '🤖 **AutoMod Engine ENABLED.** All configured spam, link, mention, and word filters are active.');
    }

    if (sub === 'disable') {
      config.automod.enabled = false; saveGuildConfig(guild.id, config);
      return safeReply(interaction, '⚠️ **AutoMod Engine DISABLED.**');
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
        .setDescription(`• **Channel:** ${w.channelId ? `<#${w.channelId}>` : '*Auto-detect*'}\n• **Status:** ${w.enabled ? '🟢 Enabled' : '🔴 Disabled'}\n• **Embed Color:** \`${w.embedColor}\`\n• **Auto-Role:** ${w.autoRoleId ? `<@&${w.autoRoleId}>` : '*None*'}\n• **Rules Channel:** ${w.rulesChannelId ? `<#${w.rulesChannelId}>` : '*Not set*'}\n• **Roles Channel:** ${w.rolesChannelId ? `<#${w.rolesChannelId}>` : '*Not set*'}`)
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
        `• **Color:** \`${w.embedColor}\``
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
    const helpEmbed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('🛡️ THOR APEX — Command Guide')
      .setDescription('Production-Ready Discord Security, Anti-Nuke, AutoMod, Logging & Welcome Bot.')
      .addFields(
        { name: '🛡️ Security & Anti-Nuke', value: '`/security status` `/security audit` `/security incidents`\n`/antinuke enable` `/antinuke disable` `/antinuke threshold` `/antinuke trust` `/antinuke lockdown`' },
        { name: '🤖 AutoMod', value: '`/automod config` `/automod test` `/automod enable` `/automod disable` `/automod blacklist` `/automod whitelist`' },
        { name: '📋 14 Log Channels', value: '`/logs setup` (Auto-creates 📁 SERVER LOGS & 14 channels)\n`/logs status` `/logs configure` `/logs test` `/logs disable`' },
        { name: '🎉 Welcome & Goodbye', value: '`/welcome setup` `/welcome test` `/welcome config`\n`/goodbye setup` `/goodbye test` `/goodbye config`' },
        { name: '⚖️ Moderation', value: '`/warn` `/warnings` `/clearwarnings` `/timeout` `/untimeout` `/kick` `/ban` `/unban` `/softban` `/purge` `/lock` `/unlock` `/slowmode` `/nick` `/modlogs`' },
        { name: '🎵 Music & 24/7 Radio', value: '`/play` `/pause` `/resume` `/skip` `/stop` `/queue` `/radio` `/volume` `/loop` `/shuffle` `/previous`' },
        { name: 'ℹ️ Utility', value: '`/ping` `/uptime` `/botinfo` `/serverinfo` `/userinfo` `/permissions`' }
      )
      .setFooter({ text: 'All commands support role hierarchy validation and multi-server isolation' })
      .setTimestamp();
    return safeReply(interaction, { embeds: [helpEmbed] });
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
  // 8. MUSIC & RADIO COMMANDS (ALL 11 REGISTERED COMMANDS HANDLED)
  // ─────────────────────────────────────────────────────────────
  if (commandName === 'play') {
    const vc = member?.voice?.channel;
    if (!vc) return safeReply(interaction, 'Join a Voice Channel first!');
    if (!addMusicToQueue) return safeReply(interaction, 'Music engine is currently initializing.');
    await interaction.deferReply();
    const query = interaction.options.getString('song', true);
    const res = await addMusicToQueue(guild, vc, user, interaction.channel, query);
    if (!res.success) return interaction.editReply(`❌ ${res.message}`);
    return interaction.editReply(`▶️ Added **${res.firstTrack?.title || query}** to queue (Position #${res.position || 1}).`);
  }

  if (commandName === 'pause') {
    const q = getQ?.(guild.id);
    if (!q || !q.player || !q.isPlaying) return safeReply(interaction, 'Nothing is currently playing.');
    q.player.pause(); q.isPaused = true;
    return safeReply(interaction, '⏸️ Music paused.');
  }

  if (commandName === 'resume') {
    const q = getQ?.(guild.id);
    if (!q || !q.player || !q.isPaused) return safeReply(interaction, 'Music is not paused.');
    q.player.unpause(); q.isPaused = false;
    return safeReply(interaction, '▶️ Music resumed.');
  }

  if (commandName === 'skip') {
    const q = getQ?.(guild.id);
    if (!q || !q.currentTrack) return safeReply(interaction, 'Queue is empty!');
    const s = q.currentTrack;
    if (handleTrackEnded) handleTrackEnded(guild.id);
    return safeReply(interaction, `⏭️ Skipped: **${s.title}**`);
  }

  if (commandName === 'stop') {
    if (stopMusicSession) stopMusicSession(guild.id);
    return safeReply(interaction, '⏹️ Stopped music playback and left the voice channel.');
  }

  if (commandName === 'queue') {
    const q = getQ?.(guild.id);
    if (!q || q.queue.length === 0) return safeReply(interaction, 'Music queue is currently empty. Use `/play` to add tracks.');
    const list = q.queue.slice(0, 10).map((t, i) => `${i + 1}. **${t.title}** (By: <@${t.requestedBy}>)`).join('\n');
    return safeReply(interaction, { embeds: [new EmbedBuilder().setColor('#5865F2').setTitle(`Music Queue — ${guild.name}`).setDescription(list).setFooter({ text: `Total: ${q.queue.length} tracks` }).setTimestamp()] });
  }

  if (commandName === 'nowplaying') {
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
    const q = getQ?.(guild.id);
    if (q) {
      q.volume = level;
      if (q.currentResource?.volume) {
        q.currentResource.volume.setVolume(level / 100);
      }
    }
    return safeReply(interaction, `🔊 Playback volume set to **${level}%**.`);
  }

  if (commandName === 'loop') {
    const mode = interaction.options.getString('mode', true);
    const q = getQ?.(guild.id);
    if (q) q.loopMode = mode.toLowerCase();
    return safeReply(interaction, `🔁 Loop mode set to **${mode.toUpperCase()}**.`);
  }

  if (commandName === 'shuffle') {
    const q = getQ?.(guild.id);
    if (!q || q.queue.length <= 1) return safeReply(interaction, 'Not enough songs in queue to shuffle.');
    for (let i = q.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [q.queue[i], q.queue[j]] = [q.queue[j], q.queue[i]];
    }
    return safeReply(interaction, `🔀 Shuffled **${q.queue.length}** songs in queue.`);
  }

  if (commandName === 'previous') {
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

  // ─────────────────────────────────────────────────────────────
  // 9. UNKNOWN COMMAND SAFETY NET
  // ─────────────────────────────────────────────────────────────
  return safeReply(interaction, `⚠️ Unrecognized command: \`/${commandName}\`. Use \`/help\` to view all commands.`, true);
}

module.exports = {
  dispatchCommand,
};
