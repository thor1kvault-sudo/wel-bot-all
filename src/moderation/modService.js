const { PermissionsBitField, EmbedBuilder } = require('discord.js');
const { getGuildConfig, saveGuildConfig } = require('../config/guildConfig');
const { logModeration } = require('../logging/loggerService');
const { parseDuration, formatDuration, redactSecrets } = require('../utils/helpers');

/**
 * Validates role and bot hierarchy before executing moderation action.
 */
function checkModerationHierarchy(executorMember, targetMember, actionName) {
  if (!targetMember) return { allowed: true };
  const guild = executorMember.guild;

  // Cannot punish server owner
  if (targetMember.id === guild.ownerId) {
    return { allowed: false, reason: `You cannot ${actionName} the Server Owner.` };
  }

  // Cannot punish yourself
  if (targetMember.id === executorMember.id) {
    return { allowed: false, reason: `You cannot ${actionName} yourself.` };
  }

  // Cannot punish the bot
  if (targetMember.id === guild.client.user.id) {
    return { allowed: false, reason: `You cannot ${actionName} me.` };
  }

  // Executor hierarchy check (unless bot owner or server owner)
  if (executorMember.id !== guild.ownerId && executorMember.id !== process.env.OWNER_ID) {
    if (executorMember.roles.highest.position <= targetMember.roles.highest.position) {
      return { allowed: false, reason: `You cannot ${actionName} this user because their role is higher than or equal to yours.` };
    }
  }

  // Bot hierarchy check
  const me = guild.members?.me;
  if (me && me.roles?.highest && targetMember.roles?.highest) {
    if (me.roles.highest.position <= targetMember.roles.highest.position) {
      return { allowed: false, reason: `I cannot ${actionName} this user because their role is higher than or equal to my highest role.` };
    }
  }

  return { allowed: true };
}

/**
 * Moderation actions
 */
async function warnMember(guild, executor, targetUser, reason = 'No reason provided') {
  const config = getGuildConfig(guild.id, guild.name);
  if (!config.warnings) config.warnings = {};
  if (!config.warnings[targetUser.id]) config.warnings[targetUser.id] = [];

  const warnEntry = {
    id: `W-${Date.now().toString(36).toUpperCase()}`,
    reason,
    mod: executor.tag || executor.username,
    modId: executor.id,
    timestamp: Date.now(),
  };

  config.warnings[targetUser.id].push(warnEntry);
  saveGuildConfig(guild.id, config);

  // Attempt to DM user
  try {
    await targetUser.send(`⚠️ You received an official warning in **${guild.name}**.\n**Reason:** ${reason}`);
  } catch (_) {}

  const embed = new EmbedBuilder()
    .setColor('#FEE75C')
    .setTitle('⚠️ Member Warned')
    .addFields(
      { name: 'Target', value: `${targetUser.tag} (\`${targetUser.id}\`)`, inline: true },
      { name: 'Moderator', value: `${executor.tag} (<@${executor.id}>)`, inline: true },
      { name: 'Total Warnings', value: `${config.warnings[targetUser.id].length}`, inline: true },
      { name: 'Reason', value: reason }
    )
    .setTimestamp();

  await logModeration(guild, embed);
  return { success: true, count: config.warnings[targetUser.id].length, warnId: warnEntry.id };
}

async function timeoutMember(guild, executor, targetMember, durationStr, reason = 'No reason provided') {
  const ms = parseDuration(durationStr);
  if (ms <= 0 || ms > 28 * 24 * 60 * 60 * 1000) {
    return { success: false, reason: 'Duration must be between 1 second and 28 days (e.g. 10m, 1h, 1d).' };
  }

  const hier = checkModerationHierarchy(executor, targetMember, 'timeout');
  if (!hier.allowed) return hier;

  try {
    await targetMember.timeout(ms, `${reason} (by ${executor.user.tag})`);
    try {
      await targetMember.send(`⏳ You have been timed out in **${guild.name}** for **${formatDuration(ms)}**.\n**Reason:** ${reason}`);
    } catch (_) {}

    const embed = new EmbedBuilder()
      .setColor('#FFA500')
      .setTitle('⏳ Member Timed Out')
      .addFields(
        { name: 'Target', value: `${targetMember.user.tag} (\`${targetMember.id}\`)`, inline: true },
        { name: 'Moderator', value: `${executor.user.tag} (<@${executor.id}>)`, inline: true },
        { name: 'Duration', value: formatDuration(ms), inline: true },
        { name: 'Reason', value: reason }
      )
      .setTimestamp();

    await logModeration(guild, embed);
    return { success: true, formatted: formatDuration(ms) };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

async function untimeoutMember(guild, executor, targetMember, reason = 'Untimeout by moderator') {
  const hier = checkModerationHierarchy(executor, targetMember, 'remove timeout from');
  if (!hier.allowed) return hier;

  try {
    await targetMember.timeout(null, `${reason} (by ${executor.user.tag})`);
    const embed = new EmbedBuilder()
      .setColor('#57F287')
      .setTitle('⌛ Timeout Removed')
      .addFields(
        { name: 'Target', value: `${targetMember.user.tag} (\`${targetMember.id}\`)`, inline: true },
        { name: 'Moderator', value: `${executor.user.tag} (<@${executor.id}>)`, inline: true },
        { name: 'Reason', value: reason }
      )
      .setTimestamp();

    await logModeration(guild, embed);
    return { success: true };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

async function kickMember(guild, executor, targetMember, reason = 'No reason provided') {
  const hier = checkModerationHierarchy(executor, targetMember, 'kick');
  if (!hier.allowed) return hier;

  try {
    try {
      await targetMember.send(`🚫 You were kicked from **${guild.name}**.\n**Reason:** ${reason}`);
    } catch (_) {}

    await targetMember.kick(`${reason} (by ${executor.user.tag})`);

    const embed = new EmbedBuilder()
      .setColor('#ED4245')
      .setTitle('🚫 Member Kicked')
      .addFields(
        { name: 'Target', value: `${targetMember.user.tag} (\`${targetMember.id}\`)`, inline: true },
        { name: 'Moderator', value: `${executor.user.tag} (<@${executor.id}>)`, inline: true },
        { name: 'Reason', value: reason }
      )
      .setTimestamp();

    await logModeration(guild, embed);
    return { success: true };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

async function banMember(guild, executor, targetUser, reason = 'No reason provided', deleteSeconds = 0) {
  const member = guild.members.cache.get(targetUser.id);
  if (member) {
    const hier = checkModerationHierarchy(executor, member, 'ban');
    if (!hier.allowed) return hier;
  }

  try {
    if (member) {
      try {
        await member.send(`⛔ You were banned from **${guild.name}**.\n**Reason:** ${reason}`);
      } catch (_) {}
    }

    await guild.bans.create(targetUser.id, {
      reason: `${reason} (by ${executor.user.tag})`,
      deleteMessageSeconds: deleteSeconds,
    });

    const embed = new EmbedBuilder()
      .setColor('#ED4245')
      .setTitle('⛔ Member Banned')
      .addFields(
        { name: 'Target', value: `${targetUser.tag || targetUser.id} (\`${targetUser.id}\`)`, inline: true },
        { name: 'Moderator', value: `${executor.user.tag} (<@${executor.id}>)`, inline: true },
        { name: 'Reason', value: reason }
      )
      .setTimestamp();

    await logModeration(guild, embed);
    return { success: true };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

async function softbanMember(guild, executor, targetMember, reason = 'Softban (purge messages)') {
  const hier = checkModerationHierarchy(executor, targetMember, 'softban');
  if (!hier.allowed) return hier;

  try {
    await guild.bans.create(targetMember.id, {
      reason: `Softban: ${reason} (by ${executor.user.tag})`,
      deleteMessageSeconds: 86400 * 7,
    });
    await guild.bans.remove(targetMember.id, 'Softban unban');

    const embed = new EmbedBuilder()
      .setColor('#ED4245')
      .setTitle('🧹 Member Softbanned')
      .setDescription(`Kicked and purged last 7 days of messages.`)
      .addFields(
        { name: 'Target', value: `${targetMember.user.tag} (\`${targetMember.id}\`)`, inline: true },
        { name: 'Moderator', value: `${executor.user.tag} (<@${executor.id}>)`, inline: true },
        { name: 'Reason', value: reason }
      )
      .setTimestamp();

    await logModeration(guild, embed);
    return { success: true };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

async function purgeMessages(channel, amount, filter = 'all', targetUser = null) {
  if (amount < 1 || amount > 100) return { success: false, reason: 'Amount must be between 1 and 100.' };

  try {
    let messages = await channel.messages.fetch({ limit: amount });

    if (filter === 'bot') {
      messages = messages.filter(m => m.author.bot);
    } else if (filter === 'user' && targetUser) {
      messages = messages.filter(m => m.author.id === targetUser.id);
    } else if (filter === 'links') {
      messages = messages.filter(m => /https?:\/\//i.test(m.content));
    }

    const deleted = await channel.bulkDelete(messages, true);
    return { success: true, count: deleted.size };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

async function lockChannel(channel, executor, reason = 'Channel locked by staff') {
  try {
    await channel.permissionOverwrites.create(channel.guild.roles.everyone, {
      SendMessages: false,
      AddReactions: false,
    }, { reason });

    const embed = new EmbedBuilder()
      .setColor('#ED4245')
      .setTitle('🔒 Channel Locked')
      .setDescription(`**Channel:** <#${channel.id}>\n**Moderator:** <@${executor.id}>\n**Reason:** ${reason}`)
      .setTimestamp();

    await logModeration(channel.guild, embed);
    return { success: true };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

async function unlockChannel(channel, executor) {
  try {
    await channel.permissionOverwrites.create(channel.guild.roles.everyone, {
      SendMessages: null,
      AddReactions: null,
    }, { reason: 'Channel unlocked by staff' });

    const embed = new EmbedBuilder()
      .setColor('#57F287')
      .setTitle('🔓 Channel Unlocked')
      .setDescription(`**Channel:** <#${channel.id}>\n**Moderator:** <@${executor.id}>`)
      .setTimestamp();

    await logModeration(channel.guild, embed);
    return { success: true };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

module.exports = {
  checkModerationHierarchy,
  warnMember,
  timeoutMember,
  untimeoutMember,
  kickMember,
  banMember,
  softbanMember,
  purgeMessages,
  lockChannel,
  unlockChannel,
};
