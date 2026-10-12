const { PermissionsBitField, EmbedBuilder } = require('discord.js');
const { getGuildConfig, saveGuildConfig } = require('../config/guildConfig');
const { logAutoMod } = require('../logging/loggerService');
const { countEmojis, redactSecrets } = require('../utils/helpers');

// Per-user message history: Map<"guildId:userId", { timestamps: number[], lastMessages: string[] }>
const userMessageHistory = new Map();

// Join raid tracker: Map<guildId, number[]>
const raidJoinTracker = new Map();

/**
 * Checks if a user or role is whitelisted from AutoMod in this guild.
 */
function isAutoModWhitelisted(member, channel = null) {
  if (!member || !member.guild) return false;
  if (member.user?.bot) return true;
  if (member.id === member.guild.ownerId) return true;
  if (process.env.OWNER_ID && member.id === process.env.OWNER_ID) return true;

  const config = getGuildConfig(member.guild.id, member.guild.name);
  const am = config.automod || {};

  // Administrator permission bypasses basic chat automod
  if (member.permissions?.has(PermissionsBitField.Flags.Administrator)) return true;

  // Whitelisted Users
  if (am.whitelistUsers && am.whitelistUsers.includes(member.id)) return true;

  // Whitelisted Roles
  if (am.whitelistRoles && am.whitelistRoles.length > 0 && member.roles?.cache) {
    if (member.roles.cache.some(r => am.whitelistRoles.includes(r.id))) return true;
  }

  // Ignored Channels
  if (channel && am.ignoredChannels && am.ignoredChannels.includes(channel.id)) return true;

  return false;
}

/**
 * Executes configured AutoMod punishment
 */
async function applyAutoModPunishment(member, actionType, reason, message = null, ruleKey = '') {
  const guild = member.guild;
  const config = getGuildConfig(guild.id, guild.name);
  let action = (actionType || 'delete').toLowerCase();

  // 1. Delete message
  if (message && message.deletable) {
    await message.delete().catch(() => {});
  }

  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  let penaltyResult = 'Message Deleted';

  try {
    if (action === 'timeout') {
      const durationMs = 60 * 1000; // default 1 min
      if (me && me.permissions.has(PermissionsBitField.Flags.ModerateMembers) && member.moderatable) {
        await member.timeout(durationMs, `AutoMod: ${reason}`).catch(() => {});
        penaltyResult = 'Timed out for 60s';
      }
    } else if (action === 'warn') {
      if (!config.warnings) config.warnings = {};
      if (!config.warnings[member.id]) config.warnings[member.id] = [];
      config.warnings[member.id].push({
        id: `W-${Date.now().toString(36)}`,
        reason: `AutoMod: ${reason}`,
        mod: 'AutoMod System',
        timestamp: Date.now(),
      });
      saveGuildConfig(guild.id, config);
      penaltyResult = `Warned (Total: ${config.warnings[member.id].length})`;
    } else if (action === 'kick') {
      if (me && me.permissions.has(PermissionsBitField.Flags.KickMembers) && member.kickable) {
        await member.kick(`AutoMod: ${reason}`).catch(() => {});
        penaltyResult = 'Kicked from server';
      }
    } else if (action === 'ban') {
      if (me && me.permissions.has(PermissionsBitField.Flags.BanMembers) && member.bannable) {
        await guild.bans.create(member.id, { reason: `AutoMod: ${reason}` }).catch(() => {});
        penaltyResult = 'Banned from server';
      }
    }
  } catch (err) {
    console.error(redactSecrets(`AutoMod penalty failed: ${err.message}`));
  }

  // Notify channel temporarily
  if (message && message.channel) {
    message.channel.send({
      content: `🛡️ <@${member.id}>'s message was removed by **AutoMod** (${reason}).`,
    }).then(msg => setTimeout(() => msg.delete().catch(() => {}), 5000)).catch(() => {});
  }

  // Log to #automod-logs
  const embed = new EmbedBuilder()
    .setColor('#ED4245')
    .setTitle('🤖 AutoMod Rule Triggered')
    .addFields(
      { name: 'User', value: `${member.user?.tag || member.id} (<@${member.id}>)`, inline: true },
      { name: 'Channel', value: message?.channel ? `<#${message.channel.id}>` : 'Unknown', inline: true },
      { name: 'Violated Rule', value: reason, inline: true },
      { name: 'Action Taken', value: penaltyResult, inline: true }
    )
    .setTimestamp();

  if (message?.content) {
    const snippet = message.content.length > 500 ? message.content.slice(0, 500) + '...' : message.content;
    embed.addFields({ name: 'Content Snippet', value: `\`\`\`${snippet}\`\`\`` });
  }

  await logAutoMod(guild, embed);
}

/**
 * Evaluates a message against all AutoMod rules.
 */
async function processMessage(message) {
  if (!message || !message.guild || message.author.bot) return;
  const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) return;

  if (isAutoModWhitelisted(member, message.channel)) return;

  const config = getGuildConfig(message.guild.id, message.guild.name);
  const am = config.automod || {};
  if (!am.enabled) return;

  const content = message.content || '';
  const now = Date.now();
  const histKey = `${message.guild.id}:${member.id}`;

  let userHist = userMessageHistory.get(histKey);
  if (!userHist) {
    userHist = { timestamps: [], lastMessages: [] };
    userMessageHistory.set(histKey, userHist);
  }

  // 1. Anti-Spam (Message Flood)
  if (am.antiSpam?.enabled) {
    const win = am.antiSpam.windowMs || 5000;
    const max = am.antiSpam.maxMessages || 5;
    userHist.timestamps = userHist.timestamps.filter(t => now - t < win);
    userHist.timestamps.push(now);

    if (userHist.timestamps.length >= max) {
      await applyAutoModPunishment(member, am.antiSpam.action || 'timeout', `Message Flood (${userHist.timestamps.length} msgs in ${win / 1000}s)`, message, 'antiSpam');
      userHist.timestamps = [];
      return;
    }
  }

  // 2. Duplicate Message Detection
  if (am.antiDuplicate?.enabled && content.length > 5) {
    const maxDupes = am.antiDuplicate.maxDuplicates || 3;
    userHist.lastMessages.push(content.toLowerCase().trim());
    if (userHist.lastMessages.length > 5) userHist.lastMessages.shift();

    const dupes = userHist.lastMessages.filter(m => m === content.toLowerCase().trim()).length;
    if (dupes >= maxDupes) {
      await applyAutoModPunishment(member, am.antiDuplicate.action || 'delete', `Repeated Duplicate Messages (${dupes}x)`, message, 'antiDuplicate');
      return;
    }
  }

  // 3. Mention Spam & Mass Mention
  if (am.antiMentionSpam?.enabled) {
    const userMentions = message.mentions.users.size;
    const roleMentions = message.mentions.roles.size;
    const total = userMentions + roleMentions;
    const maxMentions = am.antiMentionSpam.maxMentions || 5;
    if (total >= maxMentions) {
      await applyAutoModPunishment(member, am.antiMentionSpam.action || 'timeout', `Mention Spam (${total} mentions)`, message, 'antiMentionSpam');
      return;
    }
  }

  // 4. Anti-Everyone / Anti-Here Ping
  if (am.antiEveryone?.enabled) {
    if (content.includes('@everyone') || content.includes('@here') || message.mentions.everyone) {
      await applyAutoModPunishment(member, am.antiEveryone.action || 'delete', 'Unauthorized @everyone / @here Ping', message, 'antiEveryone');
      return;
    }
  }

  // 5. Anti-Invites
  if (am.antiInvites?.enabled) {
    if (/(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite|dsc\.gg|invite\.gg)\/[a-zA-Z0-9]+/i.test(content)) {
      await applyAutoModPunishment(member, am.antiInvites.action || 'delete', 'Discord Invite Link', message, 'antiInvites');
      return;
    }
  }

  // 6. Anti-Links / Phishing
  if (am.antiLinks?.enabled) {
    if (/https?:\/\/[^\s]+/i.test(content)) {
      // Check allowed domains
      const allowed = am.antiLinks.allowedDomains || ['discord.com', 'tenor.com', 'giphy.com', 'youtube.com', 'youtu.be', 'spotify.com'];
      const isAllowed = allowed.some(d => content.includes(d));
      if (!isAllowed) {
        await applyAutoModPunishment(member, am.antiLinks.action || 'delete', 'External Link / Advertising', message, 'antiLinks');
        return;
      }
    }
  }

  // 7. Anti-NSFW Links
  if (am.antiNsfwLinks?.enabled) {
    if (/(?:pornhub|xvideos|hentai|redtube|xnxx|youporn|chaturbate|onlyfans)/i.test(content)) {
      await applyAutoModPunishment(member, am.antiNsfwLinks.action || 'delete', 'NSFW Link Detected', message, 'antiNsfwLinks');
      return;
    }
  }

  // 8. Word Blacklist
  if (am.wordFilter?.enabled) {
    const words = am.wordFilter.words || [];
    const lowerContent = content.toLowerCase();
    for (const w of words) {
      if (!w) continue;
      // Word boundary regex to avoid false positives (e.g. "pass" matching "ass")
      const regex = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (regex.test(lowerContent)) {
        await applyAutoModPunishment(member, am.wordFilter.action || 'delete', `Blacklisted Word: \`${w}\``, message, 'wordFilter');
        return;
      }
    }
  }

  // 9. Caps Spam
  if (am.antiCaps?.enabled && content.length >= (am.antiCaps.minLength || 10)) {
    const letters = content.replace(/[^a-zA-Z]/g, '');
    if (letters.length >= (am.antiCaps.minLength || 10)) {
      const caps = letters.replace(/[^A-Z]/g, '').length;
      const ratio = (caps / letters.length) * 100;
      if (ratio >= (am.antiCaps.maxPercentage || 70)) {
        await applyAutoModPunishment(member, am.antiCaps.action || 'delete', `Excessive Caps (${Math.round(ratio)}%)`, message, 'antiCaps');
        return;
      }
    }
  }

  // 10. Emoji Spam
  if (am.antiEmojiSpam?.enabled) {
    const eCount = countEmojis(content);
    if (eCount > (am.antiEmojiSpam.maxEmojis || 6)) {
      await applyAutoModPunishment(member, am.antiEmojiSpam.action || 'delete', `Emoji Spam (${eCount} emojis)`, message, 'antiEmojiSpam');
      return;
    }
  }
}

/**
 * Checks member join for Raid / Alt signals.
 */
async function processMemberJoin(member) {
  if (!member || !member.guild) return;
  const guild = member.guild;
  const config = getGuildConfig(guild.id, guild.name);
  const am = config.automod || {};

  // Alt Detection
  if (am.altDetection?.enabled && member.user?.createdTimestamp) {
    const minDays = am.altDetection.minDays || 7;
    const ageDays = Math.floor((Date.now() - member.user.createdTimestamp) / 86400000);
    if (ageDays < minDays) {
      if (member.kickable) {
        await member.kick(`Alt Account: ${ageDays} days old (Minimum: ${minDays} days)`).catch(() => {});
      }
      const embed = new EmbedBuilder()
        .setColor('#ED4245')
        .setTitle('🛡️ Alt Account Intercepted')
        .setDescription(`**User:** ${member.user.tag} (\`${member.id}\`)\n**Account Age:** ${ageDays} days\n**Minimum Allowed:** ${minDays} days\n**Action:** Kicked`)
        .setTimestamp();
      await logAutoMod(guild, embed);
      return { intercepted: true, reason: 'alt' };
    }
  }

  // Anti-Raid Join Flood
  if (am.antiRaid?.enabled) {
    const win = am.antiRaid.joinWindowMs || 10000;
    const thr = am.antiRaid.joinThreshold || 8;
    const now = Date.now();

    let joins = raidJoinTracker.get(guild.id) || [];
    joins = joins.filter(t => now - t < win);
    joins.push(now);
    raidJoinTracker.set(guild.id, joins);

    if (joins.length >= thr) {
      config.security.lockdown = true;
      saveGuildConfig(guild.id, config);

      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('🚨 RAID DETECTED — AUTOMATIC LOCKDOWN ENGAGED!')
        .setDescription(`**${joins.length}** accounts joined within ${win / 1000} seconds.\nServer lockdown has been activated automatically to secure all channels.`)
        .setTimestamp();
      await logAutoMod(guild, embed);
      return { intercepted: true, reason: 'raid' };
    }
  }

  return { intercepted: false };
}

module.exports = {
  isAutoModWhitelisted,
  processMessage,
  processMemberJoin,
  applyAutoModPunishment,
};
