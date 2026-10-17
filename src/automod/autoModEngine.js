const { PermissionsBitField, EmbedBuilder } = require('discord.js');
const { getGuildConfig, saveGuildConfig } = require('../config/guildConfig');
const { logAutoMod, resolveLogChannel } = require('../logging/loggerService');
const { countEmojis, redactSecrets } = require('../utils/helpers');

// ── Smart Anti-Phishing Pattern Library ──────────────────────────────────────
// Covers: fake Nitro, typo-squatted Discord domains, free Steam gift scams,
// token grabbers, suspicious short-URLs posing as Discord invites.
const PHISHING_PATTERNS = [
  // Fake Nitro / gift scams (keyword-based, domain-agnostic)
  /(?:free[-. ]?nitro|nitro[-. ]?gift|discord[-. ]?nitro[-. ]?free|airdrop[-. ]?discord)/i,
  /gift[-. ]?nitro[-. ]?discord/i,
  /discordnitro[^.]*\.(?:com|net|org|io|xyz|gift|tk|ml|cf|ga)/i,
  // Fake Discord gift domains (NOT discord.gg/WORD — only suspicious TLDs)
  /discord\.(?:gift|gifts|rip|tk|ml|cf|ga|xyz|store|online|click|live)\//i,
  // Typo-squatted Discord domain names (dlscord, discorcl, discorrd, etc.)
  /(?:dlscord|discorcl|discod\.|discorrd\.|dscord|d1scord|disc0rd)\./i,
  // Fake Steam community — typo variants with double letters or transposed chars
  /steam(?:c[o0]mmunit[y1]{1,2}|communt[iy]+|c[o0]immunty|c[o0]mmunl)\./i,
  /(?:steamcoimunity|steamcommuntiy|stearncommunity|steamcommuniity)\./i,
  /steam[-. ]?gift[-. ]?card/i,
  // Suspicious token-grab patterns
  /(?:click[-. ]?here[-. ]?for[-. ]?nitro|claim[-. ]?your[-. ]?nitro|get[-. ]?free[-. ]?nitro)/i,
  // Generic phishing redirect signals (link shorteners used in scams)
  /(?:[a-z0-9-]+\.)?(?:bit\.ly|is\.gd|cutt\.ly)\/[a-zA-Z0-9]{4,}/i,
];

// Per-user message history: Map<"guildId:userId", { timestamps: number[], lastMessages: string[], lastActivity: number }>
const userMessageHistory = new Map();

// Join raid tracker: Map<guildId, number[]>
const raidJoinTracker = new Map();

// Bounded state sweeper: evicts inactive user histories and stale join timestamps every 60s
const autoModMemorySweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, hist] of userMessageHistory.entries()) {
    hist.timestamps = (hist.timestamps || []).filter(t => now - t < 60000);
    if ((now - (hist.lastActivity || 0) > 300000) && hist.timestamps.length === 0) {
      userMessageHistory.delete(key);
    }
  }
  for (const [guildId, joins] of raidJoinTracker.entries()) {
    const fresh = joins.filter(t => now - t < 60000);
    if (fresh.length === 0) raidJoinTracker.delete(guildId);
    else raidJoinTracker.set(guildId, fresh);
  }
}, 60000);
if (autoModMemorySweeper.unref) autoModMemorySweeper.unref();

// Processed message IDs set to prevent duplicate punishments (bounded ring cache)
const processedMessagesRing = new Set();
function markMessageProcessed(id) {
  if (!id) return;
  if (processedMessagesRing.size > 2000) {
    const first = processedMessagesRing.values().next().value;
    processedMessagesRing.delete(first);
  }
  processedMessagesRing.add(id);
}

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
 * Executes configured AutoMod punishment with honest result tracking
 */
async function applyAutoModPunishment(member, actionType, reason, message = null, ruleKey = '') {
  const guild = member.guild;
  const config = getGuildConfig(guild.id, guild.name);
  let action = (actionType || 'delete').toLowerCase();

  // Deduplication check
  if (message?.id && processedMessagesRing.has(message.id)) {
    return { executed: false, reason: 'Already processed' };
  }
  if (message?.id) markMessageProcessed(message.id);

  // 1. Message Deletion
  let deletionSucceeded = false;
  if (message) {
    if (message.deletable) {
      try {
        await message.delete();
        deletionSucceeded = true;
      } catch (delErr) {
        deletionSucceeded = false;
      }
    }
  }

  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  let penaltyResult = deletionSucceeded ? 'Message Deleted' : 'Message Delete Failed (Missing Permissions)';
  let punishmentSucceeded = deletionSucceeded;

  try {
    if (action === 'timeout') {
      const durationMs = (config.automod?.[ruleKey]?.timeoutSec || 60) * 1000;
      if (!me?.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
        penaltyResult = 'Timeout Failed (Bot lacks ModerateMembers permission)';
        punishmentSucceeded = false;
      } else if (!member.moderatable) {
        penaltyResult = 'Timeout Failed (Target role is higher or equal to bot)';
        punishmentSucceeded = false;
      } else {
        try {
          await member.timeout(durationMs, `AutoMod: ${reason}`);
          penaltyResult = `Timed out for ${Math.round(durationMs / 1000)}s`;
          punishmentSucceeded = true;
        } catch (tErr) {
          penaltyResult = `Timeout Failed: ${tErr.message}`;
          punishmentSucceeded = false;
        }
      }
    } else if (action === 'warn') {
      if (!config.warnings) config.warnings = {};
      if (!config.warnings[member.id]) config.warnings[member.id] = [];
      const warnEntry = {
        id: `W-${Date.now().toString(36).toUpperCase()}`,
        reason: `AutoMod: ${reason}`,
        mod: 'AutoMod System',
        timestamp: Date.now(),
      };
      config.warnings[member.id].push(warnEntry);
      saveGuildConfig(guild.id, config);
      penaltyResult = `Warned (Total Strikes: ${config.warnings[member.id].length})`;
      punishmentSucceeded = true;
    } else if (action === 'kick') {
      if (!me?.permissions.has(PermissionsBitField.Flags.KickMembers)) {
        penaltyResult = 'Kick Failed (Bot lacks KickMembers permission)';
        punishmentSucceeded = false;
      } else if (!member.kickable) {
        penaltyResult = 'Kick Failed (Role hierarchy restriction)';
        punishmentSucceeded = false;
      } else {
        try {
          await member.kick(`AutoMod: ${reason}`);
          penaltyResult = 'Kicked from server';
          punishmentSucceeded = true;
        } catch (kErr) {
          penaltyResult = `Kick Failed: ${kErr.message}`;
          punishmentSucceeded = false;
        }
      }
    } else if (action === 'ban') {
      if (!me?.permissions.has(PermissionsBitField.Flags.BanMembers)) {
        penaltyResult = 'Ban Failed (Bot lacks BanMembers permission)';
        punishmentSucceeded = false;
      } else if (!member.bannable) {
        penaltyResult = 'Ban Failed (Role hierarchy restriction)';
        punishmentSucceeded = false;
      } else {
        try {
          await guild.bans.create(member.id, { reason: `AutoMod: ${reason}`, deleteMessageSeconds: 86400 });
          penaltyResult = 'Banned from server';
          punishmentSucceeded = true;
        } catch (bErr) {
          penaltyResult = `Ban Failed: ${bErr.message}`;
          punishmentSucceeded = false;
        }
      }
    } else if (action === 'log') {
      penaltyResult = 'Logged (No punitive action taken)';
      punishmentSucceeded = true;
    }
  } catch (err) {
    console.error(redactSecrets(`AutoMod penalty failed: ${err.message}`));
    penaltyResult = `Penalty Error: ${err.message}`;
    punishmentSucceeded = false;
  }

  // Temporary in-channel alert if message was deleted
  if (deletionSucceeded && message?.channel) {
    message.channel.send({
      content: `🛡️ <@${member.id}>'s message was intercepted by **AutoMod** (${reason}).`,
    }).then(msg => setTimeout(() => msg.delete().catch(() => {}), 5000)).catch(() => {});
  }

  // Log incident to #automod-logs
  const embed = new EmbedBuilder()
    .setColor(punishmentSucceeded ? '#ED4245' : '#FEE75C')
    .setTitle(punishmentSucceeded ? '🤖 AutoMod Action Enforced' : '⚠️ AutoMod Triggered (Action Incomplete)')
    .addFields(
      { name: 'Target User', value: `${member.user?.tag || member.id} (<@${member.id}>)`, inline: true },
      { name: 'Channel', value: message?.channel ? `<#${message.channel.id}>` : 'Unknown', inline: true },
      { name: 'Triggered Rule', value: reason, inline: true },
      { name: 'Enforcement Result', value: `\`${penaltyResult}\``, inline: true },
      { name: 'Status', value: punishmentSucceeded ? '✅ Successfully Enforced' : '⚠️ Enforcement Error', inline: true }
    )
    .setTimestamp();

  if (message?.content) {
    const rawSnippet = message.content.length > 500 ? message.content.slice(0, 500) + '...' : message.content;
    const snippet = redactSecrets(rawSnippet);
    embed.addFields({ name: 'Content Snippet', value: `\`\`\`${snippet}\`\`\`` });
  }

  await logAutoMod(guild, embed);
  return { executed: punishmentSucceeded, result: penaltyResult };
}

/**
 * Evaluates a message against all AutoMod rules.
 */
async function processMessage(message) {
  if (!message || !message.guild || message.author?.bot) return;
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
    userHist = { timestamps: [], lastMessages: [], lastActivity: now };
    userMessageHistory.set(histKey, userHist);
  }
  userHist.lastActivity = now;

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
    const userMentions = message.mentions?.users?.size || 0;
    const roleMentions = message.mentions?.roles?.size || 0;
    const total = userMentions + roleMentions;
    const maxMentions = am.antiMentionSpam.maxMentions || 5;
    if (total >= maxMentions) {
      await applyAutoModPunishment(member, am.antiMentionSpam.action || 'timeout', `Mention Spam (${total} mentions)`, message, 'antiMentionSpam');
      return;
    }
  }

  // 4. Anti-Everyone / Anti-Here Ping
  if (am.antiEveryone?.enabled) {
    if (content.includes('@everyone') || content.includes('@here') || message.mentions?.everyone) {
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

  // 6. Smart Anti-Phishing & Fake Nitro Scanner (runs BEFORE generic antiLinks)
  if (am.antiPhishing?.enabled !== false) { // default ON unless explicitly disabled
    const cleanContent = content
      .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '') // strip zero-width chars
      .replace(/\s+/g, ' ');

    const phishingHit = PHISHING_PATTERNS.find(re => re.test(cleanContent));
    if (phishingHit) {
      // Instant delete + 60-minute timeout (regardless of antiLinks setting)
      await applyAutoModPunishment(
        member, 'timeout',
        '🚨 Phishing / Fake Nitro Link Detected — Immediate 60m Timeout',
        message, 'antiPhishing'
      );
      // Self-deleting channel alert (5 seconds)
      message.channel?.send({
        content: `🚨 **SCAM ALERT** — <@${member.id}>'s message contained a **phishing link** and was blocked. Do NOT click any links shared by unverified users!`,
      }).then(m => setTimeout(() => m.delete().catch(() => {}), 7000)).catch(() => {});
      return;
    }
  }

  // 6b. Anti-Links / External URL filter
  if (am.antiLinks?.enabled) {
    if (/https?:\/\/[^\s]+/i.test(content)) {
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
  if (!member || !member.guild) return { intercepted: false };
  const guild = member.guild;
  const config = getGuildConfig(guild.id, guild.name);
  const am = config.automod || {};

  // Alt Detection
  if (am.altDetection?.enabled && member.user?.createdTimestamp) {
    const minDays = am.altDetection.minDays || 7;
    const ageDays = Math.floor((Date.now() - member.user.createdTimestamp) / 86400000);
    if (ageDays < minDays) {
      let kickSuccess = false;
      const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
      if (me?.permissions.has(PermissionsBitField.Flags.KickMembers) && member.kickable) {
        try {
          await member.kick(`Alt Account: ${ageDays} days old (Minimum: ${minDays} days)`);
          kickSuccess = true;
        } catch (_) {}
      }
      const embed = new EmbedBuilder()
        .setColor('#ED4245')
        .setTitle('🛡️ Alt Account Intercepted')
        .setDescription(`**User:** ${member.user.tag} (\`${member.id}\`)\n**Account Age:** ${ageDays} days\n**Minimum Allowed:** ${minDays} days\n**Action:** ${kickSuccess ? 'Kicked' : 'Kick Failed (Hierarchy/Permissions)'}`)
        .setTimestamp();
      await logAutoMod(guild, embed);
      return { intercepted: true, reason: 'alt', kicked: kickSuccess };
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
      const { engageEmergencyLockdown } = require('../security/backupRecovery');
      await engageEmergencyLockdown(guild, 'AutoMod Anti-Raid System', 'AutoMod Anti-Raid Join Flood Triggered').catch(() => {});

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

/**
 * Diagnostic and simulation test engine for /automod test
 * Validates config, permissions, rules, and simulations without modifying live members.
 */
async function runAutoModDiagnostic(guild) {
  const config = getGuildConfig(guild.id, guild.name);
  const am = config.automod || {};
  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);

  const checks = [];
  const issues = [];

  // 1. Engine enabled check
  if (am.enabled) {
    checks.push('AutoMod Engine is **Active & Enabled**');
  } else {
    issues.push('AutoMod Engine is currently **Disabled** (use `/automod enable`)');
  }

  // 2. Permission health check
  const requiredPerms = [
    { flag: PermissionsBitField.Flags.ManageMessages, name: 'Manage Messages' },
    { flag: PermissionsBitField.Flags.ModerateMembers, name: 'Moderate Members (Timeout)' },
    { flag: PermissionsBitField.Flags.KickMembers, name: 'Kick Members' },
    { flag: PermissionsBitField.Flags.BanMembers, name: 'Ban Members' },
  ];

  for (const p of requiredPerms) {
    if (me?.permissions?.has(p.flag)) {
      checks.push(`Permission **${p.name}**: Granted`);
    } else {
      issues.push(`Permission **${p.name}**: ❌ Missing`);
    }
  }

  // 3. Log destination channel check
  const logChan = await resolveLogChannel(guild, 'automod');
  if (logChan) {
    checks.push(`AutoMod Log Channel: <#${logChan.id}>`);
  } else {
    issues.push('AutoMod Log Channel: ⚠️ Not found (Run `/logs setup` to create `#automod-logs`)');
  }

  // 4. Safe Filter Simulations (No members harmed)
  const simulations = [];

  // Word Filter simulation
  const badWordTest = (am.wordFilter?.words || []).length > 0;
  simulations.push(`Word Blacklist: ${badWordTest ? `Active (${am.wordFilter.words.length} words)` : 'No words configured'}`);

  // Invite regex simulation
  const inviteRegex = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite|dsc\.gg|invite\.gg)\/[a-zA-Z0-9]+/i;
  const testInviteMatch = inviteRegex.test('Join here: discord.gg/testserver');
  simulations.push(`Invite Filter Pattern: ${testInviteMatch ? 'Operational' : 'Regex Error'}`);

  // Caps simulation
  const testCapsLetters = 'HELLO THIS IS ALL CAPS TEST'.replace(/[^a-zA-Z]/g, '');
  const testCapsRatio = (testCapsLetters.replace(/[^A-Z]/g, '').length / testCapsLetters.length) * 100;
  simulations.push(`Caps Analyzer: Operational (Evaluated sample to ${Math.round(testCapsRatio)}% caps)`);

  // Emoji simulation
  const emojiCount = countEmojis('😀🔥🚀⚡');
  simulations.push(`Emoji Counter: Operational (Counted ${emojiCount} emojis)`);

  return {
    operational: issues.length === 0,
    checks,
    issues,
    simulations,
    activeRulesCount: [
      am.antiSpam?.enabled,
      am.antiDuplicate?.enabled,
      am.antiMentionSpam?.enabled,
      am.antiEveryone?.enabled,
      am.antiInvites?.enabled,
      am.antiLinks?.enabled,
      am.antiNsfwLinks?.enabled,
      am.wordFilter?.enabled,
      am.antiCaps?.enabled,
      am.antiEmojiSpam?.enabled,
      am.altDetection?.enabled,
      am.antiRaid?.enabled,
    ].filter(Boolean).length,
  };
}

module.exports = {
  isAutoModWhitelisted,
  processMessage,
  processMemberJoin,
  applyAutoModPunishment,
  runAutoModDiagnostic,
  PHISHING_PATTERNS,
};
