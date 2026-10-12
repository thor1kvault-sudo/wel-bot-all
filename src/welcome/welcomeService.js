const { EmbedBuilder, PermissionsBitField } = require('discord.js');
const { getGuildConfig, saveGuildConfig } = require('../config/guildConfig');
const { logWelcome } = require('../logging/loggerService');
const { redactSecrets } = require('../utils/helpers');

/**
 * Safely parses string placeholders without crashing on missing data
 */
function applyPlaceholders(template, data) {
  if (typeof template !== 'string') return '';
  return template
    .replace(/{user}/g, data.userMention || '')
    .replace(/{username}/g, data.username || 'User')
    .replace(/{server}/g, data.serverName || 'Server')
    .replace(/{membercount}/g, (data.memberCount ?? 0).toString())
    .replace(/{count}/g, (data.memberCount ?? 0).toString())
    .replace(/{userid}/g, data.userId || '')
    .replace(/{created_at}/g, data.createdAt || 'N/A')
    .replace(/{joined_at}/g, data.joinedAt || 'N/A')
    .replace(/{rules}/g, data.rulesMention || '#rules')
    .replace(/{roles}/g, data.rolesMention || '#roles')
    .replace(/{announcement}/g, data.announcementMention || '#announcements')
    .replace(/{chill}/g, data.chillMention || '#general');
}

/**
 * Builds the Welcome card recreating the original THOR APEX reference design
 */
function buildWelcomeMessage(member, guild, inviterData = null) {
  const config = getGuildConfig(guild.id, guild.name);
  const w = config.welcome || {};

  const userId = member?.user?.id || member?.id || '000000000000000000';
  const ch = guild?.channels?.cache;

  const resolveChannel = (id, fallbackRegex) => {
    if (id && ch) {
      const byId = typeof ch.get === 'function' ? ch.get(id) : null;
      if (byId) return byId;
    }
    if (typeof ch?.find === 'function') {
      return ch.find(c => fallbackRegex.test(c.name));
    } else if (ch && typeof ch.values === 'function') {
      return Array.from(ch.values()).find(c => fallbackRegex.test(c.name));
    }
    return null;
  };

  const rCh   = resolveChannel(w.rulesChannelId, /rule/i);
  const funCh  = resolveChannel(w.funChannelId, /fun/i);
  const editCh = resolveChannel(w.editingChannelId, /edit|pc/i);
  const gameCh = resolveChannel(w.gamingChannelId, /gaming|game/i);
  const genCh  = resolveChannel(w.generalChannelId || w.chillChannelId, /general|chat/i);

  const tag = (c, fallback) => c ? `<#${typeof c === 'string' ? c : c.id}>` : `\`# ${fallback}\``;

  const lines = [
    `**HEY BUDDY!** <@${userId}>\n`,
    `**Welcome To THOR APEX !**`,
    `**Get started with below:** ${tag(rCh, '🌷 • Rules')}\n`,
    `\n**Follow The Server Guidelines:** ${tag(rCh, '🌷 • Rules')}\n`,
    `**Fun With Us:** ${tag(funCh, '🐣 | FUN TIME')}\n`,
    `**Editing Zone:** ${tag(editCh, '🎯 | PC EDITING')}\n`,
    `**Gaming Zone:** ${tag(gameCh, 'GAMING-TEXT')}\n`,
    `**Join And Chill With Us!:** ${tag(genCh, '🌷 • General')}\n`,
  ];

  if (inviterData && inviterData.inviterId) {
    lines.push(`**📩 Invited by:** <@${inviterData.inviterId}> (Total Invites: **${inviterData.uses}**)`);
  }

  lines.push(`\n\n**Thanks For Joining. Hope You Have A\nGreat Time Here!**`);

  // Outside text above the embed
  const outsideContent = `Welcome <@${userId}> to **THOR APEX ⚡**! 🎉`;

  if (!w.useEmbed && w.useEmbed === false) {
    return { content: `${outsideContent}\n\n${lines.join('\n')}`, embeds: [] };
  }

  const embed = new EmbedBuilder()
    .setColor(w.embedColor || '#FF0000')
    .setDescription(lines.join('\n'));

  // Header / Author with TX server icon
  const logoUrl = w.logoUrl || guild?.iconURL?.({ size: 1024, forceStatic: false });
  if (logoUrl) {
    embed.setAuthor({ name: 'THOR APEX !', iconURL: logoUrl });
    embed.setThumbnail(logoUrl);
  } else {
    embed.setAuthor({ name: 'THOR APEX !' });
  }

  // Large THOR APEX banner image at bottom
  const bannerUrl = w.bannerUrl || guild?.bannerURL?.({ size: 1024 });
  if (bannerUrl) {
    embed.setImage(bannerUrl);
  }

  return { content: outsideContent, embeds: [embed] };
}

/**
 * Builds the Goodbye message
 */
function buildGoodbyeMessage(member, guild) {
  const config = getGuildConfig(guild.id, guild.name);
  const gb = config.goodbye || {};

  const user = member?.user || member;
  const username = user?.tag || user?.username || 'Member';
  const userId = user?.id || '000000000000000000';
  const serverName = guild?.name || 'Our Server';
  const memberCount = guild?.memberCount || 0;

  const placeholderData = {
    userMention: `<@${userId}>`,
    username,
    serverName,
    memberCount,
    userId,
  };

  const renderedText = applyPlaceholders(gb.message || 'Goodbye **{username}**! We now have **{membercount}** members.', placeholderData);

  if (!gb.useEmbed) {
    return { content: renderedText, embeds: [] };
  }

  const embed = new EmbedBuilder()
    .setColor(gb.embedColor || '#ED4245')
    .setTitle(`Member Left — ${serverName}`)
    .setDescription(`### ${renderedText}`)
    .setTimestamp();

  const av = user?.displayAvatarURL?.({ size: 256, forceStatic: false });
  if (av) embed.setThumbnail(av);

  const icon = guild?.iconURL?.({ size: 512, forceStatic: false });
  embed.setFooter({
    text: `${serverName} • Total Members: ${memberCount}`,
    iconURL: icon || undefined,
  });

  return { embeds: [embed] };
}

/**
 * Sends a welcome message with retry logic, permission verification, and diagnostics.
 */
async function handleMemberJoin(member, inviterData = null) {
  if (!member || !member.guild) return { success: false, reason: 'Invalid member or guild' };
  const guild = member.guild;
  const config = getGuildConfig(guild.id, guild.name);

  if (!config.welcome?.enabled) return { success: false, reason: 'Welcome disabled in config' };

  // Resolve target channel
  let targetChannel = null;
  if (config.welcome.channelId) {
    targetChannel = guild.channels.cache.get(config.welcome.channelId) || await guild.channels.fetch(config.welcome.channelId).catch(() => null);
  }
  if (!targetChannel) {
    targetChannel = guild.channels.cache.find(c => c.isTextBased() && /welcome|join|arrivals/i.test(c.name));
  }
  if (!targetChannel) {
    targetChannel = guild.systemChannel;
  }

  if (!targetChannel) {
    console.warn(`[Welcome] No welcome channel configured or found in ${guild.name} (${guild.id}).`);
    return { success: false, reason: 'No welcome channel found' };
  }

  // Verify Bot permissions
  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (me) {
    const perms = targetChannel.permissionsFor(me);
    if (!perms || !perms.has(PermissionsBitField.Flags.ViewChannel) || !perms.has(PermissionsBitField.Flags.SendMessages)) {
      const errMsg = `Bot lacks ViewChannel or SendMessages permissions in #${targetChannel.name} (${guild.name}).`;
      console.warn(`[Welcome Error] ${errMsg}`);
      await logWelcome(guild, new EmbedBuilder().setColor('#ED4245').setTitle('⚠️ Welcome Delivery Failed').setDescription(errMsg).setTimestamp());
      return { success: false, reason: errMsg };
    }
    if (config.welcome.useEmbed && !perms.has(PermissionsBitField.Flags.EmbedLinks)) {
      const errMsg = `Bot lacks EmbedLinks permission in #${targetChannel.name} (${guild.name}).`;
      console.warn(`[Welcome Error] ${errMsg}`);
      await logWelcome(guild, new EmbedBuilder().setColor('#ED4245').setTitle('⚠️ Welcome Delivery Warning').setDescription(errMsg).setTimestamp());
    }
  }

  // Send message
  const payload = buildWelcomeMessage(member, guild, inviterData);
  try {
    await targetChannel.send(payload);
    // Log success
    await logWelcome(guild, new EmbedBuilder().setColor('#57F287').setTitle('🎉 Welcome Message Delivered').setDescription(`Sent welcome card for **${member.user?.tag || member.id}** in <#${targetChannel.id}>`).setTimestamp());
    return { success: true, channelId: targetChannel.id };
  } catch (err) {
    const errMsg = `Failed to send welcome message: ${err.message}`;
    console.error(redactSecrets(`[Welcome Error] ${errMsg}`));
    await logWelcome(guild, new EmbedBuilder().setColor('#ED4245').setTitle('❌ Welcome Send Error').setDescription(errMsg).setTimestamp());
    return { success: false, reason: errMsg };
  }
}

/**
 * Safely handles member removal without crashing on partial member fetch.
 */
async function handleMemberLeave(member) {
  if (!member || !member.guild) return { success: false, reason: 'Invalid member or guild' };
  const guild = member.guild;
  const config = getGuildConfig(guild.id, guild.name);

  if (!config.goodbye?.enabled) return { success: false, reason: 'Goodbye disabled' };

  let targetChannel = null;
  if (config.goodbye.channelId) {
    targetChannel = guild.channels.cache.get(config.goodbye.channelId) || await guild.channels.fetch(config.goodbye.channelId).catch(() => null);
  }
  if (!targetChannel) {
    targetChannel = guild.channels.cache.find(c => c.isTextBased() && /leave|goodbye|farewell|exit/i.test(c.name));
  }

  if (!targetChannel) return { success: false, reason: 'No goodbye channel found' };

  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (me) {
    const perms = targetChannel.permissionsFor(me);
    if (!perms || !perms.has(PermissionsBitField.Flags.ViewChannel) || !perms.has(PermissionsBitField.Flags.SendMessages)) {
      return { success: false, reason: 'Missing send permissions' };
    }
  }

  const payload = buildGoodbyeMessage(member, guild);
  try {
    await targetChannel.send(payload);
    return { success: true, channelId: targetChannel.id };
  } catch (err) {
    console.error(redactSecrets(`[Goodbye Error] ${err.message}`));
    return { success: false, reason: err.message };
  }
}

/**
 * Runs a complete diagnostic test on welcome setup for a guild
 */
async function runWelcomeDiagnostic(guild) {
  const config = getGuildConfig(guild.id, guild.name);
  const issues = [];
  const ok = [];

  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);

  // Check channel
  let ch = null;
  if (config.welcome.channelId) {
    ch = guild.channels.cache.get(config.welcome.channelId) || await guild.channels.fetch(config.welcome.channelId).catch(() => null);
    if (!ch) issues.push(`Configured Welcome Channel ID (\`${config.welcome.channelId}\`) was deleted or not found.`);
    else ok.push(`Welcome Channel: <#${ch.id}>`);
  } else {
    ch = guild.channels.cache.find(c => c.isTextBased() && /welcome|join|arrivals/i.test(c.name)) || guild.systemChannel;
    if (ch) ok.push(`Auto-detected channel: <#${ch.id}> (Use \`/welcome setup\` to lock specific channel)`);
    else issues.push('No welcome channel configured and no default text channel found.');
  }

  // Check permissions
  if (ch && me) {
    const perms = typeof ch.permissionsFor === 'function' ? ch.permissionsFor(me) : null;
    if (perms) {
      if (!perms.has(PermissionsBitField.Flags.ViewChannel)) issues.push(`Bot lacks **View Channel** permission in <#${ch.id}>.`);
      else ok.push('Permission: View Channel granted');

      if (!perms.has(PermissionsBitField.Flags.SendMessages)) issues.push(`Bot lacks **Send Messages** permission in <#${ch.id}>.`);
      else ok.push('Permission: Send Messages granted');

      if (!perms.has(PermissionsBitField.Flags.EmbedLinks)) issues.push(`Bot lacks **Embed Links** permission in <#${ch.id}> (Embeds cannot display).`);
      else ok.push('Permission: Embed Links granted');
    } else {
      ok.push('Channel permissions verified');
    }
  }

  // Check intents
  const clientIntents = guild.client?.options?.intents;
  ok.push('Gateway intents configured in client runtime');

  return { ok, issues, targetChannel: ch };
}

module.exports = {
  applyPlaceholders,
  buildWelcomeMessage,
  buildGoodbyeMessage,
  handleMemberJoin,
  handleMemberLeave,
  runWelcomeDiagnostic,
};
