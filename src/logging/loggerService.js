const { ChannelType, PermissionsBitField, EmbedBuilder } = require('discord.js');
const { getGuildConfig, saveGuildConfig } = require('../config/guildConfig');
const { redactSecrets } = require('../utils/helpers');

const LOG_CATEGORIES = [
  { key: 'member', name: 'member-logs', topic: 'Member joins, leaves, avatar & nickname changes' },
  { key: 'message', name: 'message-logs', topic: 'Message edits, deletions, and bulk purges' },
  { key: 'moderation', name: 'moderation-logs', topic: 'Staff moderation actions: warns, timeouts, kicks, bans' },
  { key: 'security', name: 'security-logs', topic: 'Security alerts, lockdowns, and configuration changes' },
  { key: 'antiNuke', name: 'anti-nuke-logs', topic: 'Anti-nuke triggers, rate limit breaches, and automated enforcement' },
  { key: 'automod', name: 'automod-logs', topic: 'AutoMod rule violations, blocked words, and invite filtering' },
  { key: 'role', name: 'role-logs', topic: 'Role creations, deletions, and permission adjustments' },
  { key: 'channel', name: 'channel-logs', topic: 'Channel creations, deletions, and overwrite modifications' },
  { key: 'voice', name: 'voice-logs', topic: 'Voice channel joins, leaves, moves, mutes, and deafens' },
  { key: 'serverSettings', name: 'server-settings-logs', topic: 'Server name, icon, banner, and security level updates' },
  { key: 'invite', name: 'invite-logs', topic: 'Server invite creations, deletions, and usage tracking' },
  { key: 'webhook', name: 'webhook-logs', topic: 'Webhook creations, deletions, and modifications' },
  { key: 'bot', name: 'bot-logs', topic: 'Bot additions, bot removals, and bot permission changes' },
  { key: 'welcome', name: 'welcome-logs', topic: 'Welcome and goodbye card delivery reports & diagnostics' },
  { key: 'drag', name: 'drag-logs', topic: 'Voice channel member drag, move, and moderator transfer activity' },
];

// Async bounded dispatch queue to ensure non-blocking log execution
const dispatchQueue = [];
let isQueueProcessing = false;

function enqueueLog(guild, categoryKey, embed) {
  if (!guild || !categoryKey || !embed) return;
  // Bound queue size to 250 to avoid memory growth during extreme event bursts
  if (dispatchQueue.length > 250) dispatchQueue.shift();
  dispatchQueue.push({ guild, categoryKey, embed });
  processQueue();
}

async function processQueue() {
  if (isQueueProcessing) return;
  isQueueProcessing = true;

  while (dispatchQueue.length > 0) {
    const item = dispatchQueue.shift();
    try {
      await sendLogImmediate(item.guild, item.categoryKey, item.embed);
    } catch (err) {
      console.error(redactSecrets(`Log dispatch error [${item.categoryKey}]: ${err.message}`));
    }
  }

  isQueueProcessing = false;
}

/**
 * Resolves or looks up the destination channel for a category
 */
async function resolveLogChannel(guild, categoryKey) {
  if (!guild) return null;
  const config = getGuildConfig(guild.id, guild.name);
  const configuredId = config.logging?.channels?.[categoryKey];

  if (configuredId) {
    const ch = guild.channels.cache.get(configuredId) || await guild.channels.fetch(configuredId).catch(() => null);
    if (ch && ch.isTextBased()) return ch;
  }

  // Fallback: search by channel name
  const catDef = LOG_CATEGORIES.find(c => c.key === categoryKey);
  if (catDef && guild.channels?.cache) {
    if (typeof guild.channels.cache.find === 'function') {
      const byName = guild.channels.cache.find(c => c.isTextBased?.() && c.name === catDef.name);
      if (byName) return byName;
    } else if (typeof guild.channels.cache.values === 'function') {
      for (const c of guild.channels.cache.values()) {
        if (c.name === catDef.name) return c;
      }
    }
  }

  // Fallback 2: general security or moderation log if specific channel is missing
  if (categoryKey === 'antiNuke' && config.logging?.channels?.security) {
    return guild.channels?.cache?.get?.(config.logging.channels.security);
  }
  if (categoryKey === 'automod' && config.logging?.channels?.moderation) {
    return guild.channels?.cache?.get?.(config.logging.channels.moderation);
  }

  return null;
}

/**
 * Sends a log embed immediately to the appropriate channel
 */
async function sendLogImmediate(guild, categoryKey, embed) {
  const channel = await resolveLogChannel(guild, categoryKey);
  if (!channel) return false;

  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!me) return false;

  const perms = channel.permissionsFor(me);
  if (!perms || !perms.has(PermissionsBitField.Flags.ViewChannel) || !perms.has(PermissionsBitField.Flags.SendMessages)) {
    return false;
  }

  try {
    await channel.send({ embeds: [embed] });
    return true;
  } catch (err) {
    console.error(redactSecrets(`Failed to send log to #${channel.name}: ${err.message}`));
    return false;
  }
}

/**
 * Sets up the dedicated Category '📁 SERVER LOGS' and all 14 channels idempotently.
 */
async function setupAllLogChannels(guild) {
  if (!guild) return { success: false, message: 'Invalid guild.' };

  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!me || !me.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
    return { success: false, message: 'Bot lacks `Manage Channels` permission to create log channels.' };
  }

  const config = getGuildConfig(guild.id, guild.name);
  if (!config.logging) config.logging = { categoryChannelId: '', channels: {} };
  if (!config.logging.channels) config.logging.channels = {};

  const findInCache = (predicate) => {
    if (!guild.channels?.cache) return null;
    if (typeof guild.channels.cache.find === 'function') {
      return guild.channels.cache.find(predicate);
    }
    if (typeof guild.channels.cache.values === 'function') {
      for (const val of guild.channels.cache.values()) {
        if (predicate(val)) return val;
      }
    }
    return null;
  };

  // 1. Find or create Category '📁 SERVER LOGS'
  let category = null;
  if (config.logging.categoryChannelId) {
    category = guild.channels.cache.get(config.logging.categoryChannelId) || await guild.channels.fetch(config.logging.categoryChannelId).catch(() => null);
  }
  if (!category) {
    category = findInCache(c => c.type === ChannelType.GuildCategory && /server logs/i.test(c.name));
  }
  if (!category && guild.channels.create) {
    try {
      category = await guild.channels.create({
        name: '📁 SERVER LOGS',
        type: ChannelType.GuildCategory,
        permissionOverwrites: [
          {
            id: guild.roles?.everyone?.id || guild.id,
            deny: [PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ViewChannel],
          },
          {
            id: me.id,
            allow: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.SendMessages,
              PermissionsBitField.Flags.EmbedLinks,
              PermissionsBitField.Flags.AttachFiles,
              PermissionsBitField.Flags.ReadMessageHistory,
            ],
          },
        ],
        reason: 'Automated Log Setup: Server Logs Category',
      });
      config.logging.categoryChannelId = category.id;
    } catch (err) {
      return { success: false, message: `Could not create category: ${err.message}` };
    }
  } else if (category) {
    config.logging.categoryChannelId = category.id;
  }

  const results = [];

  // 2. Find or create each of the 14 log channels
  for (const cat of LOG_CATEGORIES) {
    let existing = null;
    const currentId = config.logging.channels[cat.key];
    if (currentId) {
      existing = guild.channels.cache.get(currentId) || await guild.channels.fetch(currentId).catch(() => null);
    }
    if (!existing) {
      existing = findInCache(c => c.isTextBased?.() && c.name === cat.name);
    }

    if (existing) {
      config.logging.channels[cat.key] = existing.id;
      // If channel is not under the category, move it
      if (category && existing.parentId !== category.id && existing.manageable) {
        await existing.setParent(category.id, { lockPermissions: false }).catch(() => {});
      }
      results.push(`🔹 **#${existing.name}** linked (${cat.key})`);
    } else if (guild.channels.create) {
      try {
        const newChan = await guild.channels.create({
          name: cat.name,
          type: ChannelType.GuildText,
          parent: category?.id || null,
          topic: cat.topic,
          reason: `Automated Log Setup: #${cat.name}`,
          permissionOverwrites: [
            {
              id: guild.roles?.everyone?.id || guild.id,
              deny: [PermissionsBitField.Flags.SendMessages],
            },
            {
              id: me.id,
              allow: [
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.SendMessages,
                PermissionsBitField.Flags.EmbedLinks,
                PermissionsBitField.Flags.AttachFiles,
                PermissionsBitField.Flags.ReadMessageHistory,
              ],
            },
          ],
        });
        config.logging.channels[cat.key] = newChan.id;

        // Post welcome announcement into the new log channel
        const initEmbed = new EmbedBuilder()
          .setColor('#5865F2')
          .setTitle(`📋 #${cat.name} Initialized`)
          .setDescription(`This channel will record all **${cat.topic}**.\n\nOnly server administrators and the bot have access to send here.`)
          .setFooter({ text: 'Discord Security & Logging System' })
          .setTimestamp();
        await newChan.send({ embeds: [initEmbed] }).catch(() => {});

        results.push(`✅ **#${newChan.name}** created`);
      } catch (err) {
        results.push(`⚠️ Failed to create #${cat.name}: ${err.message}`);
      }
    }
  }

  saveGuildConfig(guild.id, config);
  return { success: true, categoryId: category?.id || null, details: results };
}

module.exports = {
  LOG_CATEGORIES,
  enqueueLog,
  setupAllLogChannels,
  resolveLogChannel,
  logMember: (g, e) => enqueueLog(g, 'member', e),
  logMessage: (g, e) => enqueueLog(g, 'message', e),
  logModeration: (g, e) => enqueueLog(g, 'moderation', e),
  logSecurity: (g, e) => enqueueLog(g, 'security', e),
  logAntiNuke: (g, e) => enqueueLog(g, 'antiNuke', e),
  logAutoMod: (g, e) => enqueueLog(g, 'automod', e),
  logRole: (g, e) => enqueueLog(g, 'role', e),
  logChannel: (g, e) => enqueueLog(g, 'channel', e),
  logVoice: (g, e) => enqueueLog(g, 'voice', e),
  logServerSettings: (g, e) => enqueueLog(g, 'serverSettings', e),
  logInvite: (g, e) => enqueueLog(g, 'invite', e),
  logWebhook: (g, e) => enqueueLog(g, 'webhook', e),
  logBot: (g, e) => enqueueLog(g, 'bot', e),
  logWelcome: (g, e) => enqueueLog(g, 'welcome', e),
  logDrag: (g, e) => enqueueLog(g, 'drag', e),
};
