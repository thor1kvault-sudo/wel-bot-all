'use strict';

/**
 * THOR APEX — Member Mention Notification DM Service
 *
 * Automatically notifies members via Direct Message when they are mentioned in a server message.
 *
 * Security & Anti-Abuse Controls:
 *  - Excludes sender (no self-DMs).
 *  - Excludes bots (prevents bot-to-bot DM loops).
 *  - Deduplicates recipient IDs per message.
 *  - Ignores role mentions (@Role) to prevent mass spam unless user is directly mentioned.
 *  - Mass-mention cap: caps at 3 recipients per message to prevent raid weaponization.
 *  - Per-recipient rate limiting: maximum 3 mention DMs per user per 60 seconds.
 *  - Per-sender rate limiting: maximum 5 mention DMs generated per author per 60 seconds.
 *  - Untrusted text escaping: inserts zero-width space in mentions (@\u200b) to prevent unintended pings in DMs.
 *  - Graceful Discord API error handling: DiscordAPIError 50007 (Closed DMs), blocked users, or timeouts
 *    never crash the bot or disrupt message processing.
 *  - Configuration toggle: respects guildConfig.mentionDMs.enabled and legacy tagNotify flag.
 */

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const { getGuildConfig } = require('../config/guildConfig');
const { redactSecrets } = require('../utils/helpers');

// Rate limiting in-memory tracking
// recipientId -> [timestamps]
const _recipientHistory = new Map();
// senderId -> [timestamps]
const _senderHistory = new Map();

const RATE_WINDOW_MS = 60_000;
const MAX_RECIPIENT_DMS_PER_WINDOW = 3;
const MAX_SENDER_DMS_PER_WINDOW = 5;
const MAX_MENTIONS_PER_MESSAGE = 3;

/**
 * Cleans up expired rate-limit timestamps
 */
function pruneHistory(map, id, now) {
  const list = map.get(id);
  if (!list) return [];
  const valid = list.filter(ts => (now - ts) < RATE_WINDOW_MS);
  if (valid.length === 0) {
    map.delete(id);
    return [];
  }
  map.set(id, valid);
  return valid;
}

/**
 * Checks whether sender or recipient has exceeded rate limit
 */
function isRateLimited(senderId, recipientId) {
  const now = Date.now();
  const sList = pruneHistory(_senderHistory, senderId, now);
  if (sList.length >= MAX_SENDER_DMS_PER_WINDOW) {
    return true;
  }

  const rList = pruneHistory(_recipientHistory, recipientId, now);
  if (rList.length >= MAX_RECIPIENT_DMS_PER_WINDOW) {
    return true;
  }

  return false;
}

/**
 * Records a successful DM transmission for rate limiting
 */
function recordTransmission(senderId, recipientId) {
  const now = Date.now();
  const sList = _senderHistory.get(senderId) || [];
  sList.push(now);
  _senderHistory.set(senderId, sList);

  const rList = _recipientHistory.get(recipientId) || [];
  rList.push(now);
  _recipientHistory.set(recipientId, rList);
}

/**
 * Safely sanitizes message text to prevent unintended mentions in the DM notification
 */
function sanitizeContent(raw) {
  if (!raw || typeof raw !== 'string') return '';
  // Insert zero-width space after '@' to disable Discord mention parsing in DM text
  return raw.replace(/@/g, '@\u200b').trim();
}

/**
 * Dispatches mention notification DMs for a guild message
 *
 * @param {import('discord.js').Message} message
 * @param {import('discord.js').Client} client
 * @param {object} [options]
 * @returns {Promise<{ sentCount: number, skippedCount: number, errors: string[] }>}
 */
async function handleMentionNotification(message, client, options = {}) {
  const result = { sentCount: 0, skippedCount: 0, errors: [] };

  if (!message || message.author?.bot || !message.guild) {
    return result;
  }

  // 1. Check guild configuration
  const config = options.customConfig || getGuildConfig(message.guild.id, message.guild.name);
  const isEnabled = config.mentionDMs?.enabled !== false && config.tagNotify !== false;
  if (!isEnabled) {
    return result;
  }

  // 2. Extract valid mentioned users (deduplicated, excluding sender and bots)
  const rawMentions = message.mentions?.users;
  if (!rawMentions || rawMentions.size === 0) {
    return result;
  }

  const targetUsers = [];
  const seenIds = new Set();

  for (const [userId, userObj] of rawMentions) {
    if (seenIds.has(userId)) continue;
    seenIds.add(userId);

    // Exclude self-mention
    if (userId === message.author.id) continue;

    // Exclude bot users
    if (userObj.bot || (client?.user && userId === client.user.id)) continue;

    targetUsers.push(userObj);
  }

  if (targetUsers.length === 0) {
    return result;
  }

  // 3. Mass-mention safeguard: limit to MAX_MENTIONS_PER_MESSAGE to prevent raid abuse
  const eligibleUsers = targetUsers.slice(0, MAX_MENTIONS_PER_MESSAGE);
  if (targetUsers.length > MAX_MENTIONS_PER_MESSAGE) {
    result.skippedCount += (targetUsers.length - MAX_MENTIONS_PER_MESSAGE);
  }

  // 4. Safely format content snippet
  const rawContent = message.content || '';
  const sanitized = sanitizeContent(rawContent);
  const snippet = sanitized.length > 500
    ? sanitized.slice(0, 500) + '...'
    : (sanitized || '*[Attachment, embed, or empty message content]*');

  const channelName = message.channel?.name ? `#${message.channel.name}` : 'Private Channel';
  const messageUrl = message.url || `https://discord.com/channels/${message.guild.id}/${message.channel?.id}/${message.id}`;

  // 5. Construct notification embed
  const embed = new EmbedBuilder()
    .setColor('#5865F2')
    .setAuthor({
      name: `${message.guild.name} — Mention Alert`,
      iconURL: message.guild.iconURL({ dynamic: true, size: 64 }) || undefined,
    })
    .setTitle('⚡ You were mentioned!')
    .setDescription(
      `**Server:** ${message.guild.name}\n` +
      `**Mentioned by:** **${message.author.username || message.author.tag}** (<@${message.author.id}>)\n` +
      `**Channel:** ${channelName}\n\n` +
      `**Message:**\n> ${snippet.replace(/\n/g, '\n> ')}`
    )
    .addFields({
      name: 'Jump to Message',
      value: `[Click here to view original message](${messageUrl})`,
    })
    .setFooter({
      text: 'THOR APEX • Mention Notification System',
      iconURL: client?.user?.displayAvatarURL ? client.user.displayAvatarURL({ size: 32 }) : undefined,
    })
    .setTimestamp(message.createdAt || new Date());

  // Link button component
  let row = null;
  try {
    row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Jump to Message')
        .setStyle(ButtonStyle.Link)
        .setURL(messageUrl)
    );
  } catch (_) {}

  // 6. Deliver notifications with rate-limit and error isolation
  for (const targetUser of eligibleUsers) {
    try {
      if (isRateLimited(message.author.id, targetUser.id)) {
        result.skippedCount++;
        continue;
      }

      const payload = { embeds: [embed] };
      if (row) payload.components = [row];

      await targetUser.send(payload);
      recordTransmission(message.author.id, targetUser.id);
      result.sentCount++;
    } catch (err) {
      // 50007: Cannot send messages to this user (closed DMs or blocked)
      const errCode = err.code || err.status;
      const isClosedDm = errCode === 50007 || (err.message && err.message.includes('Cannot send messages to this user'));
      if (isClosedDm) {
        result.errors.push(`Closed DMs for user ${targetUser.id}`);
      } else {
        result.errors.push(`Failed sending DM to ${targetUser.id}: ${redactSecrets(err.message)}`);
      }
    }
  }

  return result;
}

/**
 * Resets rate limit cache (useful for testing)
 */
function _resetRateLimits() {
  _recipientHistory.clear();
  _senderHistory.clear();
}

module.exports = {
  handleMentionNotification,
  sanitizeContent,
  isRateLimited,
  _resetRateLimits,
  MAX_MENTIONS_PER_MESSAGE,
  MAX_RECIPIENT_DMS_PER_WINDOW,
  MAX_SENDER_DMS_PER_WINDOW,
};
