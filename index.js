const {
  Client, GatewayIntentBits, Partials, EmbedBuilder,
  PermissionsBitField, REST, Routes, SlashCommandBuilder, AuditLogEvent,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
} = require('discord.js');
require('dotenv').config();
const fs2   = require('fs');
const http  = require('http');
const https = require('https');
const path2 = require('path');

try { const ff = require('ffmpeg-static'); if (ff) process.env.FFMPEG_PATH = ff; } catch (_) {}

process.on('unhandledRejection', r => console.error('Unhandled Rejection:', r));
process.on('uncaughtException',  e => console.error('Uncaught Exception:', e));

const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', bot: 'THOR APEX All-in-One Bot', uptime: Math.floor(process.uptime()) }));
}).listen(PORT, '0.0.0.0', () => console.log('Health check server running on port ' + PORT));

const BOT_OWNER_ID = process.env.OWNER_ID || '';
const DATA_DIR = path2.join(__dirname, 'data');
if (!fs2.existsSync(DATA_DIR)) fs2.mkdirSync(DATA_DIR, { recursive: true });

function loadData(f) {
  const p = path2.join(DATA_DIR, f);
  if (fs2.existsSync(p)) { try { return JSON.parse(fs2.readFileSync(p, 'utf8')); } catch (_) {} }
  return {};
}
function saveData(f, d) { try { fs2.writeFileSync(path2.join(DATA_DIR, f), JSON.stringify(d, null, 2)); } catch (e) { console.error('Save error:', e.message); } }

let config     = loadData('config.json');
let warnings   = loadData('warnings.json');
let inviteData = loadData('invites.json');
const saveConfig     = () => saveData('config.json',   config);
const saveWarnings   = () => saveData('warnings.json', warnings);
const saveInviteData = () => saveData('invites.json',  inviteData);

const DEFSEC = {
  antiRaid: false, antiSpam: true, antiLink: true, antiAds: true,
  wordFilter: true, altDetection: true, altMinDays: 7, antiNuke: true,
  lockdown: false,
  blacklistedWords: ['nigga','nigger','fuck','shit','bitch','asshole','retard'],
  allowedLinks: [], raidThreshold: 10, spamThreshold: 3, spamWindow: 4000, nukeThreshold: 1,
  emojiLimit: 5,
  automodPunishment: 'kick',
  tagNotify: true,
  antiCaps: true,
  antiInvites: true,
  antiMassMention: true,
  antiEmojiSpam: true,
  antiNsfwLink: true,
  whitelistedUsers: [],
  whitelistedRoles: [],
};

if (!config.embedColor) {
  config = {
    welcomeChannelId: '', leaveChannelId: '', rulesChannelId: '', rolesChannelId: '',
    generalChannelId: '', logChannelId: '', voiceLogChannelId: '', roleLogChannelId: '', memberLogChannelId: '', muteRoleId: '', autoRoleId: '',
    embedColor: '#FF0000', welcomeTitle: 'THOR APEX !',
    greetingPrefix: 'HEY BUDDY!', welcomeSubtitle: 'Welcome To THOR APEX !',
    outroText: 'Thanks For Joining. Hope You Have A Great Time Here!',
    leaveText: 'Goodbye **{username}**! We now have **{count}** members.',
    security: DEFSEC, ...config,
  };
  if (!config.security) config.security = { ...DEFSEC };
  if (config.security.tagNotify === undefined) config.security.tagNotify = true;
  saveConfig();
}

// ── Voice / Music
let voiceLib = null; try { voiceLib = require('@discordjs/voice'); } catch (e) { console.log('Voice:', e.message); }
let playdl   = null; try { playdl   = require('play-dl');          } catch (e) { console.log('play-dl:', e.message); }
let isPlayDlReady = false;
async function ensurePlayDlReady() {
  if (!playdl || isPlayDlReady) return;
  try { const c = await playdl.getFreeClientID(); if (c) { await playdl.setToken({ soundcloud: { client_id: c } }); isPlayDlReady = true; } } catch (_) {}
}

function getSpotifyTrackInfo(spotifyUrl) {
  return new Promise((resolve) => {
    try {
      const oembedUrl = 'https://open.spotify.com/oembed?url=' + encodeURIComponent(spotifyUrl);
      https.get(oembedUrl, (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(raw);
            resolve(data.title || null);
          } catch (_) { resolve(null); }
        });
      }).on('error', () => resolve(null));
    } catch (_) { resolve(null); }
  });
}

const musicQueues = new Map();
function getQ(gid) {
  if (!musicQueues.has(gid)) musicQueues.set(gid, { connection: null, player: null, queue: [], isPlaying: false });
  return musicQueues.get(gid);
}
async function playTrack(gid) {
  if (!voiceLib) return;
  const q = getQ(gid); if (!q || !q.connection) return;
  await ensurePlayDlReady();
  if (!q.player) {
    try {
      q.player = voiceLib.createAudioPlayer({ behaviors: { noSubscriber: voiceLib.NoSubscriberBehavior.Play, maxMissedFrames: Math.round(5000/20) } });
      q.connection.subscribe(q.player);
      q.player.on(voiceLib.AudioPlayerStatus.Idle, old => {
        if (old.status === voiceLib.AudioPlayerStatus.Playing || old.status === voiceLib.AudioPlayerStatus.Buffering) {
          q.queue.shift(); if (q.queue.length > 0) playTrack(gid); else q.isPlaying = false;
        }
      });
      q.player.on('error', err => {
        console.error('Audio player error:', err.message);
        q.queue.shift(); if (q.queue.length > 0) playTrack(gid); else q.isPlaying = false;
      });
    } catch (e) {
      console.error('Audio player creation error:', e.message);
      return;
    }
  } else if (q.connection) {
    try { q.connection.subscribe(q.player); } catch (_) {}
  }
  const track = q.queue[0]; if (!track) { q.isPlaying = false; return; }
  try {
    let streamObj = null;
    let searchQuery = track.query || track.title;

    if (playdl) {
      try {
        // If Spotify link, fetch title and search YouTube
        if (searchQuery.includes('spotify.com')) {
          const spTitle = await getSpotifyTrackInfo(searchQuery);
          if (spTitle) searchQuery = spTitle;
        }

        // Direct YouTube URL stream
        if (searchQuery.includes('youtube.com/watch') || searchQuery.includes('youtu.be/')) {
          const res = await playdl.stream(searchQuery).catch(() => null);
          if (res && res.stream) streamObj = res;
        }

        // Search YouTube for query / Spotify title
        if (!streamObj) {
          const searched = await playdl.search(searchQuery, { limit: 1 }).catch(() => null);
          if (searched && searched[0] && searched[0].url) {
            const res = await playdl.stream(searched[0].url).catch(() => null);
            if (res && res.stream) {
              streamObj = res;
              track.title = searched[0].title || searched[0].name || track.title;
            }
          }
        }
      } catch (err) {
        console.error('play-dl stream error:', err.message);
      }
    }

    if (streamObj && streamObj.stream) {
      const res = voiceLib.createAudioResource(streamObj.stream, { inputType: streamObj.type || voiceLib.StreamType.Arbitrary });
      q.isPlaying = true;
      q.player.play(res);
    } else if (track.url && track.url.startsWith('http') && !track.url.includes('spotify.com')) {
      const res = voiceLib.createAudioResource(track.url, { inputType: voiceLib.StreamType.Arbitrary });
      q.isPlaying = true;
      q.player.play(res);
    } else {
      console.log('Skipping unplayable track:', track.title);
      q.queue.shift();
      if (q.queue.length > 0) playTrack(gid);
      else q.isPlaying = false;
    }
  } catch (err) {
    console.error('playTrack error:', err.message);
    q.queue.shift();
    if (q.queue.length > 0) playTrack(gid);
    else q.isPlaying = false;
  }
}
function addToQ(guild, vc, user, query) {
  const q = getQ(guild.id); let title = query, isUrl = false;
  try { new URL(query); isUrl = true; title = 'Song Link'; } catch (_) {}
  const track = { title, query, url: isUrl ? query : '', requestedBy: user.id };
  q.queue.push(track);
  if (voiceLib && vc) {
    if (!q.connection) {
      try {
        q.connection = voiceLib.joinVoiceChannel({
          channelId: vc.id,
          guildId: guild.id,
          adapterCreator: guild.voiceAdapterCreator,
          selfDeaf: false,
          selfMute: false,
        });
      } catch (err) { console.error('Voice join error:', err.message); }
    } else if (q.connection.joinConfig?.channelId !== vc.id) {
      try {
        q.connection = voiceLib.joinVoiceChannel({
          channelId: vc.id,
          guildId: guild.id,
          adapterCreator: guild.voiceAdapterCreator,
          selfDeaf: false,
          selfMute: false,
        });
      } catch (err) { console.error('Voice switch error:', err.message); }
    }
    if (!q.isPlaying) playTrack(guild.id);
  }
  return { track, position: q.queue.length };
}

// ── Invite Tracking
const invCache = new Map();
async function cacheInvites(guild) {
  try {
    if (!guild?.members?.me?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) return;
    const inv = await guild.invites.fetch().catch(() => null);
    if (!inv) return;
    const m = new Map(); inv.forEach(i => m.set(i.code, i.uses || 0));
    invCache.set(guild.id, m);
  } catch (_) {}
}
async function findInviter(guild) {
  try {
    if (!guild?.members?.me?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) return null;
    const cached = invCache.get(guild.id) || new Map();
    const ni = await guild.invites.fetch().catch(() => null);
    if (!ni) return null;
    let used = null; ni.forEach(i => { if (i.uses > (cached.get(i.code) || 0) && !used) used = i; });
    const upd = new Map(); ni.forEach(i => upd.set(i.code, i.uses || 0)); invCache.set(guild.id, upd);
    if (used && used.inviter) {
      let total = 0; ni.forEach(i => { if (i.inviter && i.inviter.id === used.inviter.id) total += (i.uses || 0); });
      const uid = used.inviter.id;
      if (!inviteData[uid]) inviteData[uid] = { uses: 0 };
      inviteData[uid].uses = total; saveInviteData();
      return { inviterId: uid, inviterTag: used.inviter.tag, uses: total };
    }
  } catch (_) {}
  return null;
}

// ── Whitelist & Security Helpers
const AUTOMOD_EVENTS = [
  { id: 'antiSpam', label: 'Anti spam' },
  { id: 'antiCaps', label: 'Anti caps' },
  { id: 'antiLink', label: 'Anti link' },
  { id: 'antiInvites', label: 'Anti invites' },
  { id: 'antiMassMention', label: 'Anti mass mention' },
  { id: 'antiEmojiSpam', label: 'Anti emoji spam' },
  { id: 'antiNsfwLink', label: 'Anti NSFW link' },
];

function buildAutoModPanel(guild, statusMsg) {
  const sec = config.security || {};

  const lines = AUTOMOD_EVENTS.map(ev => {
    const active = sec[ev.id] !== false;
    return (active ? '🟩' : '🟥') + ' : **' + ev.label + '**';
  });

  if (statusMsg) {
    lines.unshift(statusMsg + '\n');
  }

  const logo = guild?.iconURL({ size: 1024, forceStatic: false });
  const embed = new EmbedBuilder()
    .setColor('#57F287')
    .setTitle(guild.name + "⚡'s Automod Setup")
    .setDescription(lines.join('\n'))
    .setTimestamp();

  if (logo) embed.setThumbnail(logo);

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('am_sel_toggle')
    .setPlaceholder('Select events to enable')
    .setMinValues(1)
    .setMaxValues(AUTOMOD_EVENTS.length)
    .addOptions(
      AUTOMOD_EVENTS.map(ev => ({
        label: ev.label,
        value: ev.id,
        description: sec[ev.id] !== false ? 'Enabled' : 'Disabled',
        emoji: sec[ev.id] !== false ? '✅' : '❌',
        default: sec[ev.id] !== false
      }))
    );

  const row1 = new ActionRowBuilder().addComponents(selectMenu);

  const enableAllBtn = new ButtonBuilder()
    .setCustomId('am_enable_all')
    .setLabel('Enable for All Events')
    .setStyle(ButtonStyle.Primary);

  const cancelBtn = new ButtonBuilder()
    .setCustomId('am_cancel')
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Danger);

  const row2 = new ActionRowBuilder().addComponents(enableAllBtn, cancelBtn);

  return { embeds: [embed], components: [row1, row2] };
}

function getEventPunishment(eventId) {
  const sec = config.security || {};
  if (sec.eventPunishments && sec.eventPunishments[eventId]) {
    const p = sec.eventPunishments[eventId];
    return p.charAt(0).toUpperCase() + p.slice(1);
  }
  const defP = sec.automodPunishment || 'Mute';
  return defP.charAt(0).toUpperCase() + defP.slice(1);
}

function buildPunishmentPanel(guild, statusMsg, selectedEventId) {
  const sec = config.security || {};
  if (!sec.eventPunishments) sec.eventPunishments = {};

  const lines = [];
  if (statusMsg) lines.push(statusMsg + '\n');

  AUTOMOD_EVENTS.forEach(ev => {
    const pun = getEventPunishment(ev.id);
    lines.push(`**${ev.label}**\n${pun}\n`);
  });

  const logo = guild?.iconURL({ size: 1024, forceStatic: false });
  const embed = new EmbedBuilder()
    .setColor('#57F287')
    .setTitle(`Current Automod Punishments for ${guild.name} ⚡`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Keep the default punishment (Mute) to prevent server raids without kicking or banning raiders' })
    .setTimestamp();

  if (logo) embed.setThumbnail(logo);

  const components = [];

  if (!selectedEventId) {
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('am_pun_sel_event')
      .setPlaceholder('Select events to update punishment')
      .addOptions(
        AUTOMOD_EVENTS.map(ev => ({
          label: ev.label,
          value: ev.id,
          description: 'Current Punishment: ' + getEventPunishment(ev.id),
        }))
      );
    components.push(new ActionRowBuilder().addComponents(selectMenu));
  } else {
    const evObj = AUTOMOD_EVENTS.find(e => e.id === selectedEventId);
    const actionMenu = new StringSelectMenuBuilder()
      .setCustomId('am_pun_sel_action_' + selectedEventId)
      .setPlaceholder(`Select action for ${evObj?.label || 'Event'}`)
      .addOptions([
        { label: 'Mute', value: 'mute', description: 'Mute the member', emoji: '🔇' },
        { label: 'Kick', value: 'kick', description: 'Kick the member from server', emoji: '🚫' },
        { label: 'Ban', value: 'ban', description: 'Ban the member from server', emoji: '⛔' },
        { label: 'Warn', value: 'warn', description: 'Issue warning to member', emoji: '⚠️' },
        { label: 'Delete Message Only', value: 'delete', description: 'Delete message without member penalty', emoji: '🗑️' },
      ]);
    components.push(new ActionRowBuilder().addComponents(actionMenu));
  }

  return { embeds: [embed], components };
}
const PERM_LIST = [
  { id: 'antiBan', label: 'Anti Ban' },
  { id: 'antiUnban', label: 'Anti Unban' },
  { id: 'antiKick', label: 'Anti Kick' },
  { id: 'antiMemberPrune', label: 'Anti Member Prune' },
  { id: 'antiBotAdd', label: 'Anti Bot Add' },
  { id: 'antiChannelCreate', label: 'Anti Channel Create' },
  { id: 'antiChannelDelete', label: 'Anti Channel Delete' },
  { id: 'antiChannelUpdate', label: 'Anti Channel Update' },
  { id: 'antiRoleCreate', label: 'Anti Role Create' },
  { id: 'antiRoleDelete', label: 'Anti Role Delete' },
  { id: 'antiRoleUpdate', label: 'Anti Role Update' },
  { id: 'antiMemberUpdate', label: 'Anti Member Update' },
  { id: 'antiEmojiCreate', label: 'Anti Emoji/Sticker Create' },
  { id: 'antiEmojiDelete', label: 'Anti Emoji/Sticker Delete' },
  { id: 'antiEmojiUpdate', label: 'Anti Emoji/Sticker Update' },
  { id: 'antiEveryonePing', label: 'Anti Everyone/Here Ping' },
  { id: 'antiRolePing', label: 'Anti Role Ping' },
  { id: 'antiIntegration', label: 'Anti Integration' },
  { id: 'antiGuildUpdate', label: 'Anti Guild Update' },
  { id: 'antiWebhookCreate', label: 'Anti Webhook Create' },
  { id: 'antiWebhookDelete', label: 'Anti Webhook Delete' },
  { id: 'antiWebhookUpdate', label: 'Anti Webhook Update' },
];

function isWhitelisted(member, permType) {
  if (!member) return false;
  if (member.id === BOT_OWNER_ID || member.id === member.guild?.ownerId) return true;
  if (member.id === member.guild?.client?.user?.id) return true;

  // Administrator only bypasses general chat automod (when permType is undefined)
  if (!permType && member.permissions?.has(PermissionsBitField.Flags.Administrator)) return true;

  const s = config.security || {};
  const wUsers = s.whitelistedUsers || [];
  const wRoles = s.whitelistedRoles || [];
  if (wUsers.includes(member.id)) return true;
  if (member.roles?.cache?.some(r => wRoles.includes(r.id))) return true;

  if (permType && s.whitelistData) {
    const userPerms = s.whitelistData[member.id];
    if (userPerms && userPerms[permType]) return true;
    if (member.roles?.cache) {
      for (const [rId] of member.roles.cache) {
        if (s.whitelistData[rId] && s.whitelistData[rId][permType]) return true;
      }
    }
  }

  return false;
}

function buildWhitelistPanel(guild, targetId) {
  if (!config.security) config.security = {};
  if (!config.security.whitelistData) config.security.whitelistData = {};
  const targetData = config.security.whitelistData[targetId] || {};

  const lines = PERM_LIST.map(p => {
    const active = !!targetData[p.id];
    return (active ? '🟩' : '🟥') + ' : **' + p.label + '**';
  });

  const logo = guild?.iconURL({ size: 1024, forceStatic: false });
  const embed = new EmbedBuilder()
    .setColor('#1E1F22')
    .setDescription(lines.join('\n') + '\n\n**Target:** <@' + targetId + '>')
    .setFooter({ text: 'Powered by THOR APEX Development' });

  if (logo) embed.setThumbnail(logo);

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('wl_sel_' + targetId)
    .setPlaceholder('❯ Choose Permissions to Grant')
    .addOptions(
      PERM_LIST.slice(0, 25).map(p => ({
        label: p.label,
        value: p.id,
        description: targetData[p.id] ? 'Granted (Click to revoke)' : 'Revoked (Click to grant)',
        emoji: targetData[p.id] ? '✅' : '❌'
      }))
    );

  const row1 = new ActionRowBuilder().addComponents(selectMenu);

  const grantBtn = new ButtonBuilder()
    .setCustomId('wl_grant_all_' + targetId)
    .setLabel('Grant All Permissions')
    .setStyle(ButtonStyle.Success);

  const removeBtn = new ButtonBuilder()
    .setCustomId('wl_remove_all_' + targetId)
    .setLabel('Remove Permissions')
    .setStyle(ButtonStyle.Danger);

  const row2 = new ActionRowBuilder().addComponents(grantBtn, removeBtn);

  return { embeds: [embed], components: [row1, row2] };
}

function countEmojis(str) {
  if (!str) return 0;
  const custom = (str.match(/<a?:[a-zA-Z0-9_]+:[0-9]+>/g) || []).length;
  const unicode = (str.match(/(\u00a9|\u00ae|[\u2000-\u3300]|\ud83c[\ud000-\udfff]|\ud83d[\ud000-\udfff]|\ud83e[\ud000-\udfff])/g) || []).length;
  return custom + unicode;
}

async function executePunishment(member, action, reason, channel, eventId) {
  const guild = member.guild;
  const user  = member.user || member;
  const sec   = config.security || {};
  let pun = action;
  if (!pun && eventId && sec.eventPunishments && sec.eventPunishments[eventId]) {
    pun = sec.eventPunishments[eventId];
  }
  if (!pun) pun = sec.automodPunishment || 'mute';
  pun = pun.toLowerCase();

  try {
    if (pun === 'kick') {
      try { await user.send('You were kicked from **' + guild.name + '** by AutoMod. Reason: ' + reason); } catch (_) {}
      await member.kick('AutoMod: ' + reason);
      if (channel) channel.send({ content: '🚫 **' + user.tag + '** was **KICKED** by AutoMod (' + reason + ').' }).catch(() => {});
    } else if (pun === 'ban') {
      try { await user.send('You were banned from **' + guild.name + '** by AutoMod. Reason: ' + reason); } catch (_) {}
      await guild.members.ban(user.id, { reason: 'AutoMod: ' + reason });
      if (channel) channel.send({ content: '⛔ **' + user.tag + '** was **BANNED** by AutoMod (' + reason + ').' }).catch(() => {});
    } else if (pun === 'mute') {
      const mr = await getMuteRole(guild);
      if (mr) await member.roles.add(mr, 'AutoMod: ' + reason);
      if (channel) channel.send({ content: '🔇 <@' + user.id + '> was **MUTED** by AutoMod (' + reason + ').' }).catch(() => {});
    } else if (pun === 'warn') {
      if (!warnings[user.id]) warnings[user.id] = [];
      warnings[user.id].push({ reason: 'AutoMod: ' + reason, mod: 'AutoMod System', ts: Date.now() });
      saveWarnings();
      if (channel) channel.send({ content: '⚠️ <@' + user.id + '> was **WARNED** by AutoMod (' + reason + ').' }).catch(() => {});
    } else {
      if (channel) channel.send({ content: '⚠️ <@' + user.id + '> Warning: ' + reason }).catch(() => {});
    }
  } catch (err) { console.error('Punishment execution error:', err.message); }

  await sendLog(guild, new EmbedBuilder()
    .setColor('#FF0000')
    .setTitle('🤖 AutoMod Punishment Triggered')
    .addFields(
      { name: 'User', value: user.tag + ' (`' + user.id + '`)', inline: true },
      { name: 'Action Taken', value: pun.toUpperCase(), inline: true },
      { name: 'Reason', value: reason }
    )
    .setTimestamp()
  );
}

const spamMap = new Map();
function isSpamming(uid) {
  const now = Date.now(), thr = config.security?.spamThreshold || 3, win = config.security?.spamWindow || 4000;
  if (!spamMap.has(uid)) spamMap.set(uid, []);
  const t = spamMap.get(uid).filter(x => now - x < win); t.push(now); spamMap.set(uid, t);
  return t.length >= thr;
}
const recentJoins = [];
function isRaiding() {
  const now = Date.now(), thr = config.security?.raidThreshold || 10;
  const r = recentJoins.filter(t => now - t < 10000); r.push(now); recentJoins.length = 0; recentJoins.push(...r);
  return r.length >= thr;
}
const nukeMap = new Map();
function isNuking(uid) {
  const now = Date.now(), thr = config.security?.nukeThreshold || 1;
  if (!nukeMap.has(uid)) nukeMap.set(uid, []);
  const t = nukeMap.get(uid).filter(x => now - x < 15000); t.push(now); nukeMap.set(uid, t);
  return t.length >= thr;
}

async function handleNukeAction(guild, executor, permType, actionName) {
  if (!config.security?.antiNuke) return;
  if (!executor || (executor.bot && executor.id === guild.client.user.id)) return;
  if (executor.id === BOT_OWNER_ID || executor.id === guild.ownerId) return;

  const member = guild.members.cache.get(executor.id) || await guild.members.fetch(executor.id).catch(() => null);

  if (isWhitelisted(member, permType)) return;

  console.log(`🚨 ANTI-NUKE EMERGENCY ACTION: ${executor.tag} performed ${actionName}`);

  try {
    if (member) {
      const rolesToRemove = member.roles.cache.filter(r => r.id !== guild.roles.everyone.id);
      await member.roles.remove(rolesToRemove, 'Anti-Nuke: ' + actionName).catch(() => {});
    }

    await guild.bans.create(executor.id, { reason: 'Anti-Nuke: ' + actionName }).catch(() => {});

    await sendLog(guild, new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('🚨 ANTI-NUKE EMERGENCY ACTION TAKEN!')
      .setDescription(`**Executor:** **${executor.tag}** (\`${executor.id}\`)\n**Action Attempted:** ${actionName}\n**Action Taken:** **INSTANT BAN & ROLES STRIPPED**`)
      .setFooter({ text: 'THOR APEX Ultimate Anti-Nuke System' })
      .setTimestamp()
    );
  } catch (err) {
    console.error('Anti-Nuke enforcement error:', err.message);
  }
}

function isHex(s) { return /^#[0-9A-Fa-f]{6}$/.test(s); }
async function getLogChannel(guild, primaryId, fallbackRegexes) {
  if (!guild) return null;
  if (guild.channels?.cache?.size === 0) {
    await guild.channels.fetch().catch(() => {});
  }
  if (primaryId) {
    let ch = guild.channels.cache.get(primaryId);
    if (!ch) ch = await guild.channels.fetch(primaryId).catch(() => null);
    if (ch && ch.isTextBased()) return ch;
  }
  if (config.logChannelId && config.logChannelId !== primaryId) {
    let ch = guild.channels.cache.get(config.logChannelId);
    if (!ch) ch = await guild.channels.fetch(config.logChannelId).catch(() => null);
    if (ch && ch.isTextBased()) return ch;
  }
  if (fallbackRegexes && fallbackRegexes.length > 0) {
    for (const regex of fallbackRegexes) {
      const found = guild.channels.cache.find(c => c.isTextBased() && regex.test(c.name));
      if (found) return found;
    }
  }
  return guild.channels.cache.find(c => c.isTextBased() && /log|audit/i.test(c.name)) || null;
}
async function sendLog(guild, embed) {
  try {
    const ch = await getLogChannel(guild, config.logChannelId, [/mod-log|modlog|audit-log|security-log|logs|log/i]);
    if (ch) await ch.send({ embeds: [embed] }).catch(err => console.error('sendLog error:', err.message));
    else console.log('sendLog: No log channel configured or found in ' + (guild?.name || 'guild'));
  } catch (err) { console.error('sendLog error:', err.message); }
}
async function sendVoiceLog(guild, embed) {
  try {
    const ch = await getLogChannel(guild, config.voiceLogChannelId, [/voice-log|voicelog|voice-logs|v-log/i]);
    if (ch) await ch.send({ embeds: [embed] }).catch(err => console.error('sendVoiceLog error:', err.message));
    else console.log('sendVoiceLog: No voice log channel configured or found in ' + (guild?.name || 'guild'));
  } catch (err) { console.error('sendVoiceLog error:', err.message); }
}
async function sendRoleLog(guild, embed) {
  try {
    const ch = await getLogChannel(guild, config.roleLogChannelId, [/role-log|rolelog|role-logs|r-log/i]);
    if (ch) await ch.send({ embeds: [embed] }).catch(err => console.error('sendRoleLog error:', err.message));
    else console.log('sendRoleLog: No role log channel configured or found in ' + (guild?.name || 'guild'));
  } catch (err) { console.error('sendRoleLog error:', err.message); }
}
async function sendMemberLog(guild, embed) {
  try {
    const ch = await getLogChannel(guild, config.memberLogChannelId, [/member-log|memberlog|user-log|join-log|leave-log|m-log/i]);
    if (ch) await ch.send({ embeds: [embed] }).catch(err => console.error('sendMemberLog error:', err.message));
    else console.log('sendMemberLog: No member log channel configured or found in ' + (guild?.name || 'guild'));
  } catch (err) { console.error('sendMemberLog error:', err.message); }
}
async function safeReply(i, content, eph = true) {
  try { if (i.replied || i.deferred) await i.followUp({ content, ephemeral: eph }); else await i.reply({ content, ephemeral: eph }); } catch (_) {}
}
async function getMuteRole(guild) {
  if (config.muteRoleId) { const r = guild.roles.cache.get(config.muteRoleId); if (r) return r; }
  let role = guild.roles.cache.find(r => r.name.toLowerCase() === 'muted');
  if (role) return role;
  try {
    role = await guild.roles.create({ name: 'Muted', color: '#818386', reason: 'THOR APEX Security' });
    for (const [, ch] of guild.channels.cache) if (ch.isTextBased()) await ch.permissionOverwrites.create(role, { SendMessages: false, AddReactions: false }).catch(() => {});
    config.muteRoleId = role.id; saveConfig(); return role;
  } catch (_) { return null; }
}

// ── Embed Builders
function mkWelcomeEmbed(member, guild, inviterData) {
  const userId = member?.user?.id ?? member?.id ?? '000000000000000000';
  const channels = guild?.channels?.cache;

  const rCh   = (config.rulesChannelId && channels?.get(config.rulesChannelId)) || channels?.find(c => /rule/i.test(c.name));
  const funCh  = channels?.find(c => /fun/i.test(c.name));
  const editCh = channels?.find(c => /edit|pc/i.test(c.name));
  const gameCh = channels?.find(c => /gaming|game/i.test(c.name));
  const genCh  = (config.generalChannelId && channels?.get(config.generalChannelId)) || channels?.find(c => /general|chat/i.test(c.name));

  const tag = (ch, fallback) => ch ? `<#${typeof ch === 'string' ? ch : ch.id}>` : `\`# ${fallback}\``;

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

  const embed = new EmbedBuilder()
    .setColor('#FF0000')
    .setDescription(lines.join('\n'));

  const logoUrl = guild?.iconURL({ size: 1024, forceStatic: false });
  if (logoUrl) {
    embed.setAuthor({ name: 'THOR APEX !', iconURL: logoUrl });
    embed.setThumbnail(logoUrl);
  } else {
    embed.setAuthor({ name: 'THOR APEX !' });
  }

  const bannerUrl = guild?.bannerURL({ size: 1024 });
  if (bannerUrl) embed.setImage(bannerUrl);

  return embed;
}
function mkLeaveEmbed(member, guild) {
  const username = member.user?.tag || member.user?.username || 'Member';
  const logo = guild.iconURL({ size: 1024, forceStatic: false });
  const msg  = (config.leaveText || 'Goodbye **{username}**! We now have **{count}** members.').replace(/{user}/g, '<@' + member.id + '>').replace(/{username}/g, username).replace(/{server}/g, guild.name).replace(/{count}/g, guild.memberCount || 0);
  const embed = new EmbedBuilder().setColor('#ED4245').setTitle('Member Left - ' + guild.name).setDescription('### ' + msg).setTimestamp();
  const av = member?.user?.displayAvatarURL({ size: 256, forceStatic: false }); if (av) embed.setThumbnail(av);
  embed.setFooter({ text: 'THOR APEX Total Members: ' + (guild.memberCount || 0), iconURL: logo || undefined });
  return embed;
}

// ── Slash Commands Builder
function buildCmds() {
  return [
    new SlashCommandBuilder().setName('setup').setDescription('Auto-setup the bot').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
    new SlashCommandBuilder().setName('setwelcome').setDescription('Set welcome channel').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(false)),
    new SlashCommandBuilder().setName('setleave').setDescription('Set leave channel').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)),
    new SlashCommandBuilder().setName('setrules').setDescription('Set rules channel').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)),
    new SlashCommandBuilder().setName('setroles').setDescription('Set roles channel').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)),
    new SlashCommandBuilder().setName('setgeneral').setDescription('Set general channel').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)),
    new SlashCommandBuilder().setName('setlog').setDescription('Set mod & security log channel').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)),
    new SlashCommandBuilder().setName('setvoicelog').setDescription('Set voice activity log channel').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)),
    new SlashCommandBuilder().setName('setrolelog').setDescription('Set role updates log channel').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)),
    new SlashCommandBuilder().setName('setmemberlog').setDescription('Set member join/leave log channel').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)),
    new SlashCommandBuilder().setName('setwelcomecolor').setDescription('Set embed color').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addStringOption(o => o.setName('color').setDescription('Hex e.g. #FF5733').setRequired(true)),
    new SlashCommandBuilder().setName('setwelcometext').setDescription('Customize welcome text').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addStringOption(o => o.setName('greeting').setDescription('Greeting prefix').setRequired(false)).addStringOption(o => o.setName('subtitle').setDescription('Welcome subtitle').setRequired(false)).addStringOption(o => o.setName('outro').setDescription('Closing line').setRequired(false)),
    new SlashCommandBuilder().setName('setleavetext').setDescription('Customize leave text').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addStringOption(o => o.setName('message').setDescription('Use {username} {user} {count}').setRequired(true)),
    new SlashCommandBuilder().setName('setautorole').setDescription('Set auto-role for new members').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)),
    new SlashCommandBuilder().setName('welcomeconfig').setDescription('View bot config').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
    new SlashCommandBuilder().setName('testwelcome').setDescription('Preview welcome message'),
    new SlashCommandBuilder().setName('testleave').setDescription('Preview leave message'),
    new SlashCommandBuilder().setName('security').setDescription('View security settings').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
    new SlashCommandBuilder().setName('antispam').setDescription('Toggle anti-spam').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addStringOption(o => o.setName('toggle').setDescription('on or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })),
    new SlashCommandBuilder().setName('antilink').setDescription('Toggle anti-link/ads').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addStringOption(o => o.setName('toggle').setDescription('on or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })),
    new SlashCommandBuilder().setName('antiraid').setDescription('Toggle anti-raid').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addStringOption(o => o.setName('toggle').setDescription('on or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })),
    new SlashCommandBuilder().setName('antinuke').setDescription('Toggle anti-nuke').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addStringOption(o => o.setName('toggle').setDescription('on or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })),
    new SlashCommandBuilder().setName('altdetection').setDescription('Toggle alt account detection').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addStringOption(o => o.setName('toggle').setDescription('on or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })).addIntegerOption(o => o.setName('mindays').setDescription('Min account age in days').setRequired(false)),
    new SlashCommandBuilder().setName('wordfilter').setDescription('Toggle word filter').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addStringOption(o => o.setName('toggle').setDescription('on or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })),
    new SlashCommandBuilder().setName('addword').setDescription('Add word to blacklist').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addStringOption(o => o.setName('word').setDescription('Word').setRequired(true)),
    new SlashCommandBuilder().setName('removeword').setDescription('Remove word from blacklist').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addStringOption(o => o.setName('word').setDescription('Word').setRequired(true)),
    new SlashCommandBuilder().setName('lockdown').setDescription('Toggle server lockdown').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addStringOption(o => o.setName('toggle').setDescription('on or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })),
    new SlashCommandBuilder().setName('warn').setDescription('Warn a member').setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers).addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),
    new SlashCommandBuilder().setName('warnings').setDescription('View warnings for a user').setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers).addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
    new SlashCommandBuilder().setName('clearwarns').setDescription('Clear all warnings for a user').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
    new SlashCommandBuilder().setName('mute').setDescription('Mute a member').setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers).addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),
    new SlashCommandBuilder().setName('unmute').setDescription('Unmute a member').setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers).addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
    new SlashCommandBuilder().setName('kick').setDescription('Kick a member').setDefaultMemberPermissions(PermissionsBitField.Flags.KickMembers).addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),
    new SlashCommandBuilder().setName('ban').setDescription('Ban a member').setDefaultMemberPermissions(PermissionsBitField.Flags.BanMembers).addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),
    new SlashCommandBuilder().setName('unban').setDescription('Unban a user by ID').setDefaultMemberPermissions(PermissionsBitField.Flags.BanMembers).addStringOption(o => o.setName('userid').setDescription('User ID').setRequired(true)),
    new SlashCommandBuilder().setName('purge').setDescription('Delete messages in bulk').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages).addIntegerOption(o => o.setName('amount').setDescription('1-100').setRequired(true).setMinValue(1).setMaxValue(100)),
    new SlashCommandBuilder().setName('myinvites').setDescription('Check your total invites'),
    new SlashCommandBuilder().setName('invites').setDescription('Check invites for a user').addUserOption(o => o.setName('user').setDescription('User').setRequired(false)),
    new SlashCommandBuilder().setName('invitetop').setDescription('Top inviters leaderboard'),
    new SlashCommandBuilder().setName('play').setDescription('Play a song').addStringOption(o => o.setName('song').setDescription('Song name or link').setRequired(true)),
    new SlashCommandBuilder().setName('pause').setDescription('Pause music'),
    new SlashCommandBuilder().setName('resume').setDescription('Resume music'),
    new SlashCommandBuilder().setName('skip').setDescription('Skip current song'),
    new SlashCommandBuilder().setName('stop').setDescription('Stop music and leave voice'),
    new SlashCommandBuilder().setName('queue').setDescription('View or add to music queue').addStringOption(o => o.setName('song').setDescription('Song to add').setRequired(false)),
    new SlashCommandBuilder().setName('nowplaying').setDescription('Show currently playing song'),
    new SlashCommandBuilder().setName('radio').setDescription('Play 24/7 radio stream').addStringOption(o => o.setName('genre').setDescription('Genre').setRequired(false).addChoices({ name: 'Lofi Chill', value: 'lofi' }, { name: 'Gaming Beats', value: 'gaming' }, { name: 'Pop Hits', value: 'pop' }, { name: 'Chill Hop', value: 'chill' })),
    new SlashCommandBuilder().setName('automod').setDescription('Toggle or view AutoMod setup').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices({ name: 'enable', value: 'enable' }, { name: 'disable', value: 'disable' }, { name: 'status', value: 'status' }, { name: 'punishment', value: 'punishment' })),
    new SlashCommandBuilder().setName('automodpunishment').setDescription('Manage AutoMod punishment actions for each event').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
    new SlashCommandBuilder().setName('whitelist').setDescription('Interactive Whitelist management for Anti-Nuke & Security').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices({ name: 'manage (interactive panel)', value: 'manage' }, { name: 'add user', value: 'add_user' }, { name: 'remove user', value: 'remove_user' }, { name: 'add role', value: 'add_role' }, { name: 'remove role', value: 'remove_role' }, { name: 'list whitelisted', value: 'list' })).addUserOption(o => o.setName('user').setDescription('User').setRequired(false)).addRoleOption(o => o.setName('role').setDescription('Role').setRequired(false)),
    new SlashCommandBuilder().setName('tagnotify').setDescription('Toggle DM notifications when someone is tagged in server').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addStringOption(o => o.setName('toggle').setDescription('on or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })),
    new SlashCommandBuilder().setName('help').setDescription('Show all bot commands'),
  ].map(c => c.toJSON());
}

const RADIO_STREAMS = {
  lofi:   { name: 'Lofi Chill 24/7',   url: 'https://stream.zeno.fm/f3wvbbqmdg8uv' },
  gaming: { name: 'Gaming Beats 24/7', url: 'https://stream.zeno.fm/0r0xa792kwzuv' },
  pop:    { name: 'Pop Hits 24/7',     url: 'https://stream.zeno.fm/z52x2szx0h8uv' },
  chill:  { name: 'Chill Hop 24/7',    url: 'https://stream.zeno.fm/f3wvbbqmdg8uv' },
};

// ── Main Bot
async function startBot() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildInvites, GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildModeration,
    ],
    partials: [Partials.GuildMember, Partials.User, Partials.Channel, Partials.Message],
  });

  client.on('error', err => console.error('Discord Client Error:', err?.message || err));
  client.on('warn',  info => console.warn('Discord Client Warning:', info));

  client.once('clientReady', async () => {
    console.log('=======================================================');
    console.log('THOR APEX All-in-One Bot is ONLINE!');
    console.log('Logged in as: ' + client.user.tag);
    console.log('Servers: ' + client.guilds.cache.size);
    client.guilds.cache.forEach(g => console.log('  ' + g.name + ' (' + g.id + ')'));
    console.log('=======================================================');
    for (const g of client.guilds.cache.values()) await cacheInvites(g);
    await regCmds(client);
  });

  async function regCmds(c) {
    const token = process.env.DISCORD_TOKEN; if (!token) return;
    const rest  = new REST({ version: '10' }).setToken(token);
    const cmds  = buildCmds();
    try {
      // Clear old guild-level commands to eliminate duplicate commands in Discord
      for (const guild of c.guilds.cache.values()) {
        await rest.put(Routes.applicationGuildCommands(c.user.id, guild.id), { body: [] }).catch(() => {});
      }
      // Register global commands cleanly (only 1 copy per command in Discord)
      await rest.put(Routes.applicationCommands(c.user.id), { body: cmds });
      console.log('Global slash commands updated cleanly (no duplicates)!');
    } catch (err) { console.error('Command registration error:', err.message); }
  }

  client.on('guildCreate', async (guild) => {
    console.log('Joined: ' + guild.name);
    await cacheInvites(guild);
    const token = process.env.DISCORD_TOKEN;
    if (token) {
      const rest = new REST({ version: '10' }).setToken(token);
      await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: [] }).catch(() => {});
    }
  });

  // ── Member Joined
  client.on('guildMemberAdd', async (member) => {
    try {
      if (member.partial) { member = await member.fetch().catch(() => null); if (!member) return; }
      const guild = member.guild; const sec = config.security || {};
      console.log('Joined: ' + member.user.tag + ' in ' + guild.name);

      // Alt Detection
      if (sec.altDetection) {
        const minDays = sec.altMinDays || 7;
        const ageDays = Math.floor((Date.now() - member.user.createdTimestamp) / 86400000);
        if (ageDays < minDays) {
          try { await member.kick('Alt account - ' + ageDays + ' days old, min ' + minDays); } catch (_) {}
          await sendLog(guild, new EmbedBuilder().setColor('#FF0000').setTitle('Alt Account Kicked').addFields({ name: 'User', value: member.user.tag + ' (' + member.id + ')' }, { name: 'Account Age', value: ageDays + ' days' }, { name: 'Minimum', value: minDays + ' days' }).setTimestamp());
          return;
        }
      }
      // Anti-Raid
      if (sec.antiRaid && isRaiding()) {
        config.security.lockdown = true; saveConfig();
        try { await member.kick('Anti-Raid: raid detected'); } catch (_) {}
        await sendLog(guild, new EmbedBuilder().setColor('#FF6600').setTitle('RAID DETECTED - Lockdown Activated!').setTimestamp());
        return;
      }
      // Lockdown
      if (sec.lockdown) { try { await member.kick('Server is in lockdown.'); } catch (_) {} return; }

      const inviterData = await findInviter(guild);

      // Welcome
      let wCh = null;
      if (config.welcomeChannelId) wCh = guild.channels.cache.get(config.welcomeChannelId) || await guild.channels.fetch(config.welcomeChannelId).catch(() => null);
      if (!wCh) wCh = guild.channels.cache.find(c => c.isTextBased() && /welcome|join|arrivals/i.test(c.name));
      if (!wCh) wCh = guild.systemChannel;
      if (wCh) { await wCh.send({ content: 'Welcome <@' + member.id + '> to **THOR APEX ⚡**! 🎉', embeds: [mkWelcomeEmbed(member, guild, inviterData)] }); console.log('Welcome sent for ' + member.user.tag); }

      // Auto-Role
      if (config.autoRoleId) { try { const role = guild.roles.cache.get(config.autoRoleId); if (role) await member.roles.add(role, 'Auto-Role'); } catch (_) {} }

      // Log Member Join
      await sendMemberLog(guild, new EmbedBuilder().setColor('#57F287').setTitle('📥 Member Joined Server').setDescription('**User:** ' + member.user.tag + ' (<@' + member.id + '>)\n**Total Members:** ' + guild.memberCount).setThumbnail(member.user.displayAvatarURL({ size: 256 })).setTimestamp());
    } catch (err) { console.error('guildMemberAdd error:', err); }
  });

  // ── Member Left
  client.on('guildMemberRemove', async (member) => {
    try {
      if (member.partial) { member = await member.fetch().catch(() => null); if (!member) return; }
      let lCh = null;
      if (config.leaveChannelId) lCh = member.guild.channels.cache.get(config.leaveChannelId);
      if (!lCh) lCh = member.guild.channels.cache.find(c => c.isTextBased() && /leave|goodbye|farewell/i.test(c.name));
      if (lCh) await lCh.send({ embeds: [mkLeaveEmbed(member, member.guild)] });

      // Log Member Leave
      await sendMemberLog(member.guild, new EmbedBuilder().setColor('#ED4245').setTitle('📤 Member Left Server').setDescription('**User:** ' + member.user.tag + ' (<@' + member.id + '>)\n**Total Members:** ' + member.guild.memberCount).setThumbnail(member.user.displayAvatarURL({ size: 256 })).setTimestamp());
    } catch (err) { console.error('guildMemberRemove error:', err); }
  });

  // ── Voice State Activity Logs (Join, Leave, Move/Drag, Mute, Deafen)
  client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
      const member = newState.member || oldState.member;
      if (!member || member.user.bot) return;
      const guild = newState.guild || oldState.guild;

      // Joined Voice
      if (!oldState.channelId && newState.channelId) {
        await sendVoiceLog(guild, new EmbedBuilder().setColor('#57F287').setTitle('🔊 Member Joined Voice Channel').setDescription('**User:** ' + member.user.tag + ' (<@' + member.id + '>)\n**Channel:** <#' + newState.channelId + '>').setTimestamp());
        return;
      }
      // Left Voice
      if (oldState.channelId && !newState.channelId) {
        await sendVoiceLog(guild, new EmbedBuilder().setColor('#ED4245').setTitle('🔇 Member Left Voice Channel').setDescription('**User:** ' + member.user.tag + ' (<@' + member.id + '>)\n**Channel:** <#' + oldState.channelId + '>').setTimestamp());
        return;
      }
      // Switched / Dragged Voice Channel
      if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
        let dragger = null;
        try {
          const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberMove, limit: 1 }).catch(() => null);
          const entry = logs?.entries.first();
          if (entry && Date.now() - entry.createdTimestamp < 4000) dragger = entry.executor;
        } catch (_) {}
        const desc = '**User:** ' + member.user.tag + ' (<@' + member.id + '>)\n**From:** <#' + oldState.channelId + '>\n**To:** <#' + newState.channelId + '>' + (dragger ? '\n**Moved By:** ' + dragger.tag + ' (<@' + dragger.id + '>)' : '');
        await sendVoiceLog(guild, new EmbedBuilder().setColor('#FEE75C').setTitle('🔁 Voice Channel Switch / Member Dragged').setDescription(desc).setTimestamp());
        return;
      }
      // Mute / Unmute
      if (oldState.serverMute !== newState.serverMute || oldState.selfMute !== newState.selfMute) {
        const isMuted = newState.serverMute || newState.selfMute;
        const isServer = oldState.serverMute !== newState.serverMute;
        let executor = null;
        if (isServer) {
          try {
            const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberUpdate, limit: 1 }).catch(() => null);
            const entry = logs?.entries.first();
            if (entry && Date.now() - entry.createdTimestamp < 5000) executor = entry.executor;
          } catch (_) {}
        }
        const actionType = isServer ? 'Server Mute' : 'Self Mute';
        const titleText = isMuted ? '🎙️ Member Muted in Voice' : '🎙️ Member Unmuted in Voice';
        let desc = '**User:** ' + member.user.tag + ' (<@' + member.id + '>)\n' +
                   '**Channel:** ' + (newState.channelId ? '<#' + newState.channelId + '>' : 'Voice Channel') + '\n' +
                   '**Type:** ' + actionType;
        if (isServer) {
          desc += '\n**Action By:** ' + (executor ? executor.tag + ' (<@' + executor.id + '>)' : 'Moderator / Staff');
        } else {
          desc += '\n**Action By:** Self (' + member.user.tag + ')';
        }
        await sendVoiceLog(guild, new EmbedBuilder().setColor(isMuted ? '#ED4245' : '#57F287').setTitle(titleText).setDescription(desc).setTimestamp());
        return;
      }
      // Deafen / Undeafen
      if (oldState.serverDeaf !== newState.serverDeaf || oldState.selfDeaf !== newState.selfDeaf) {
        const isDeaf = newState.serverDeaf || newState.selfDeaf;
        const isServer = oldState.serverDeaf !== newState.serverDeaf;
        let executor = null;
        if (isServer) {
          try {
            const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberUpdate, limit: 1 }).catch(() => null);
            const entry = logs?.entries.first();
            if (entry && Date.now() - entry.createdTimestamp < 5000) executor = entry.executor;
          } catch (_) {}
        }
        const actionType = isServer ? 'Server Deafen' : 'Self Deafen';
        const titleText = isDeaf ? '🎧 Member Deafened in Voice' : '🎧 Member Undeafened in Voice';
        let desc = '**User:** ' + member.user.tag + ' (<@' + member.id + '>)\n' +
                   '**Channel:** ' + (newState.channelId ? '<#' + newState.channelId + '>' : 'Voice Channel') + '\n' +
                   '**Type:** ' + actionType;
        if (isServer) {
          desc += '\n**Action By:** ' + (executor ? executor.tag + ' (<@' + executor.id + '>)' : 'Moderator / Staff');
        } else {
          desc += '\n**Action By:** Self (' + member.user.tag + ')';
        }
        await sendVoiceLog(guild, new EmbedBuilder().setColor(isDeaf ? '#ED4245' : '#57F287').setTitle(titleText).setDescription(desc).setTimestamp());
        return;
      }
    } catch (_) {}
  });

  // ── Role Given / Removed & Nickname Change Logs
  client.on('guildMemberUpdate', async (oldMember, newMember) => {
    try {
      const guild = newMember.guild;
      const oldRoles = oldMember.roles.cache;
      const newRoles = newMember.roles.cache;

      // Role Added
      const addedRoles = newRoles.filter(r => !oldRoles.has(r.id));
      if (addedRoles.size > 0) {
        let executor = null;
        try {
          const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 1 }).catch(() => null);
          const entry = logs?.entries.first();
          if (entry && Date.now() - entry.createdTimestamp < 4000) executor = entry.executor;
        } catch (_) {}

        for (const [, role] of addedRoles) {
          await sendRoleLog(guild, new EmbedBuilder().setColor('#57F287').setTitle('➕ Role Given to Member').setDescription('**User:** ' + newMember.user.tag + ' (<@' + newMember.id + '>)\n**Role Given:** <@&' + role.id + '> (`' + role.name + '`)' + (executor ? '\n**Given By:** ' + executor.tag + ' (<@' + executor.id + '>)' : '')).setTimestamp());
        }
      }

      // Role Removed
      const removedRoles = oldRoles.filter(r => !newRoles.has(r.id));
      if (removedRoles.size > 0) {
        let executor = null;
        try {
          const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 1 }).catch(() => null);
          const entry = logs?.entries.first();
          if (entry && Date.now() - entry.createdTimestamp < 4000) executor = entry.executor;
        } catch (_) {}

        for (const [, role] of removedRoles) {
          await sendRoleLog(guild, new EmbedBuilder().setColor('#ED4245').setTitle('➖ Role Removed from Member').setDescription('**User:** ' + newMember.user.tag + ' (<@' + newMember.id + '>)\n**Role Removed:** <@&' + role.id + '> (`' + role.name + '`)' + (executor ? '\n**Removed By:** ' + executor.tag + ' (<@' + executor.id + '>)' : '')).setTimestamp());
        }
      }

      // Nickname Change
      if (oldMember.nickname !== newMember.nickname) {
        await sendMemberLog(guild, new EmbedBuilder().setColor('#FEE75C').setTitle('📝 Nickname Changed').setDescription('**User:** ' + newMember.user.tag + ' (<@' + newMember.id + '>)\n**Old:** ' + (oldMember.nickname || '*None*') + '\n**New:** ' + (newMember.nickname || '*None*')).setTimestamp());
      }
    } catch (_) {}
  });

  // ── Messages
  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    const member = message.member;
    const sec = config.security || {};

    if (!isWhitelisted(member)) {
      // 1. Anti-Spam Check (> 3 messages)
      if (sec.antiSpam !== false && isSpamming(message.author.id)) {
        await message.delete().catch(() => {});
        await executePunishment(member, null, 'Spamming (> ' + (sec.spamThreshold || 3) + ' msgs)', message.channel, 'antiSpam');
        return;
      }
      // 2. Anti-Caps Check (> 70% uppercase)
      if (sec.antiCaps !== false) {
        const letters = message.content.replace(/[^a-zA-Z]/g, '');
        if (letters.length > 10) {
          const caps = letters.replace(/[^A-Z]/g, '').length;
          if (caps / letters.length > 0.7) {
            await message.delete().catch(() => {});
            await executePunishment(member, null, 'Excessive CAPS lock', message.channel, 'antiCaps');
            return;
          }
        }
      }
      // 3. Anti-Invites Check
      if (sec.antiInvites !== false) {
        if (/discord\.gg\/|discord\.com\/invite\/|dsc\.gg\//i.test(message.content)) {
          await message.delete().catch(() => {});
          await executePunishment(member, null, 'Discord Invite Link', message.channel, 'antiInvites');
          return;
        }
      }
      // 4. Anti-Link Check
      if (sec.antiLink !== false) {
        if (/https?:\/\/(?!discord\.com)/i.test(message.content)) {
          const ok = (sec.allowedLinks || []).some(d => message.content.includes(d));
          if (!ok) {
            await message.delete().catch(() => {});
            await executePunishment(member, null, 'External Link / Advertisement', message.channel, 'antiLink');
            return;
          }
        }
      }
      // 5. Anti-NSFW Link Check
      if (sec.antiNsfwLink !== false) {
        if (/https?:\/\/[^\s]*(porn|xxx|hentai|sex|nsfw|adult|xvideos|pornhub)/i.test(message.content)) {
          await message.delete().catch(() => {});
          await executePunishment(member, null, 'NSFW Link Detected', message.channel, 'antiNsfwLink');
          return;
        }
      }
      // 6. Anti-Mass Mention Check
      if (sec.antiMassMention !== false) {
        const totalMentions = message.mentions.users.size + message.mentions.roles.size;
        if (totalMentions >= 5) {
          await message.delete().catch(() => {});
          await executePunishment(member, null, 'Mass Mention (' + totalMentions + ' mentions)', message.channel, 'antiMassMention');
          return;
        }
      }
      // 7. Anti-Emoji Spam Check
      if (sec.antiEmojiSpam !== false) {
        const eCount = countEmojis(message.content);
        if (eCount > (sec.emojiLimit || 5)) {
          await message.delete().catch(() => {});
          await executePunishment(member, null, 'Emoji Spam (' + eCount + ' emojis)', message.channel, 'antiEmojiSpam');
          return;
        }
      }
      // 8. Word Filter
      if (sec.wordFilter !== false) {
        const lower = message.content.toLowerCase();
        const bad = (sec.blacklistedWords || []).find(w => lower.includes(w.toLowerCase()));
        if (bad) {
          await message.delete().catch(() => {});
          await executePunishment(member, null, 'Word Filter Violation', message.channel, 'wordFilter');
          return;
        }
      }
    }

    // ── Tag / Mention Notification DM
    if (sec.tagNotify !== false) {
      const mentionedUserIds = new Set();

      if (message.mentions?.users?.size > 0) {
        message.mentions.users.forEach(u => {
          if (!u.bot && u.id !== message.author.id) mentionedUserIds.add(u.id);
        });
      }

      const regexMentions = message.content.match(/<@!?([0-9]+)>/g);
      if (regexMentions) {
        for (const m of regexMentions) {
          const id = m.replace(/[^0-9]/g, '');
          if (id && id !== message.author.id && id !== client.user.id) {
            mentionedUserIds.add(id);
          }
        }
      }

      for (const targetId of mentionedUserIds) {
        try {
          const targetUser = await client.users.fetch(targetId).catch(() => null);
          if (!targetUser || targetUser.bot) continue;

          const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('🔔 You were tagged in ' + message.guild.name + '!')
            .setDescription(
              '**Sender:** **' + message.author.tag + '** (<@' + message.author.id + '>)\n' +
              '**Server:** **' + message.guild.name + '**\n' +
              '**Channel:** <#' + message.channel.id + '>\n\n' +
              '**Message Content:**\n> ' + (message.content.length > 500 ? message.content.slice(0, 500) + '...' : message.content)
            )
            .addFields({ name: 'Jump to Message', value: '[Click Here to View Message](' + message.url + ')' })
            .setTimestamp();

          await targetUser.send({ embeds: [embed] }).catch(err => {
            console.log('Could not send Mention DM to ' + targetUser.tag + ': ' + err.message);
          });
        } catch (e) {
          console.error('Mention DM error:', e.message);
        }
      }
    }

    const content = message.content.trim();
    if (!content.startsWith('!')) return;
    const args = content.slice(1).trim().split(/ +/);
    const cmd  = args.shift().toLowerCase();

    if (cmd === 'play' || cmd === 'p') { const inp = args.join(' '); const vc = message.member?.voice?.channel; if (!vc) return message.reply('Join a Voice Channel first!'); if (!inp) return message.reply('Provide a song name or link!'); const r = addToQ(message.guild, vc, message.author, inp); return message.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle(r.position === 1 ? 'Now Playing' : 'Added to Queue').setDescription('**' + r.track.title + '**').setTimestamp()] }); }
    if (cmd === 'stop') { const q = getQ(message.guild.id); q.queue = []; q.isPlaying = false; if (q.connection) { try { q.connection.destroy(); } catch (_) {} q.connection = null; } return message.reply('Stopped.'); }
    if (cmd === 'skip' || cmd === 's') { const q = getQ(message.guild.id); if (q.queue.length > 0) { const s = q.queue.shift(); return message.reply('Skipped: **' + (s?.title || 'Song') + '**'); } return message.reply('Queue empty!'); }
    if (cmd === 'pause') return message.reply('Paused.');
    if (cmd === 'resume') return message.reply('Resumed.');
    if (cmd === 'queue' || cmd === 'q') { const inp = args.join(' '); const vc = message.member?.voice?.channel; if (inp) { if (!vc) return message.reply('Join Voice first!'); const r = addToQ(message.guild, vc, message.author, inp); return message.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('Added to Queue').setDescription('**' + r.track.title + '**').setTimestamp()] }); } const q = getQ(message.guild.id); if (q.queue.length === 0) return message.reply('Queue empty! Use !play'); const list = q.queue.slice(0, 10).map((t, i) => (i + 1) + '. **' + t.title + '**').join('\n'); return message.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('Music Queue').setDescription(list).setFooter({ text: 'Total: ' + q.queue.length }).setTimestamp()] }); }
    if (cmd === 'np' || cmd === 'nowplaying') { const q = getQ(message.guild.id); const t = q.queue[0]; if (!t) return message.reply('Nothing playing!'); return message.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('Now Playing').setDescription('**' + t.title + '**').setTimestamp()] }); }
    if (cmd === 'radio') { const vc = message.member?.voice?.channel; if (!vc) return message.reply('Join Voice first!'); const genre = args[0]?.toLowerCase() || 'lofi'; const sel = RADIO_STREAMS[genre] || RADIO_STREAMS.lofi; const q = getQ(message.guild.id); if (voiceLib) { if (!q.connection) { try { q.connection = voiceLib.joinVoiceChannel({ channelId: vc.id, guildId: message.guild.id, adapterCreator: message.guild.voiceAdapterCreator, selfDeaf: false }); } catch (_) {} } if (!q.player) { q.player = voiceLib.createAudioPlayer(); q.connection?.subscribe(q.player); } try { q.player.play(voiceLib.createAudioResource(sel.url, { inputType: voiceLib.StreamType.Arbitrary })); } catch (_) {} } return message.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('Radio: ' + sel.name).setDescription('Playing in <#' + vc.id + '>!').setTimestamp()] }); }
    if (cmd === 'testwelcome') return message.reply({ content: '[TEST] Welcome <@' + message.author.id + '> to **THOR APEX ⚡**! 🎉', embeds: [mkWelcomeEmbed(message.member, message.guild)] });
    if (cmd === 'warn' && isMod) { const uid = args[0]?.replace(/[<@!>]/g, ''); const reason = args.slice(1).join(' ') || 'No reason'; if (!uid) return message.reply('Usage: !warn @user [reason]'); if (!warnings[uid]) warnings[uid] = []; warnings[uid].push({ reason, mod: message.author.tag, ts: Date.now() }); saveWarnings(); return message.reply('<@' + uid + '> warned. Reason: **' + reason + '** (Total: ' + warnings[uid].length + ')'); }
    if (cmd === 'mute' && isMod) { const uid = args[0]?.replace(/[<@!>]/g, ''); const reason = args.slice(1).join(' ') || 'No reason'; if (!uid) return message.reply('Usage: !mute @user'); try { const t = await message.guild.members.fetch(uid); const mr = await getMuteRole(message.guild); if (mr) { await t.roles.add(mr, reason); return message.reply('<@' + uid + '> muted.'); } } catch (_) { return message.reply('Could not mute.'); } }
    if (cmd === 'unmute' && isMod) { const uid = args[0]?.replace(/[<@!>]/g, ''); if (!uid) return message.reply('Usage: !unmute @user'); try { const t = await message.guild.members.fetch(uid); const mr = await getMuteRole(message.guild); if (mr) { await t.roles.remove(mr); return message.reply('<@' + uid + '> unmuted.'); } } catch (_) { return message.reply('Could not unmute.'); } }
    if (cmd === 'kick' && member?.permissions?.has(PermissionsBitField.Flags.KickMembers)) { const uid = args[0]?.replace(/[<@!>]/g, ''); const reason = args.slice(1).join(' ') || 'No reason'; if (!uid) return message.reply('Usage: !kick @user'); try { const t = await message.guild.members.fetch(uid); await t.kick(reason); return message.reply('<@' + uid + '> kicked.'); } catch (_) { return message.reply('Could not kick.'); } }
    if (cmd === 'ban' && member?.permissions?.has(PermissionsBitField.Flags.BanMembers)) { const uid = args[0]?.replace(/[<@!>]/g, ''); const reason = args.slice(1).join(' ') || 'No reason'; if (!uid) return message.reply('Usage: !ban @user'); try { await message.guild.members.ban(uid, { reason }); return message.reply('<@' + uid + '> banned.'); } catch (_) { return message.reply('Could not ban.'); } }
    if (cmd === 'lockdown' && isAdmin) { config.security.lockdown = !config.security.lockdown; saveConfig(); if (config.security.lockdown) { for (const [, ch] of message.guild.channels.cache) if (ch.isTextBased()) await ch.permissionOverwrites.create(message.guild.roles.everyone, { SendMessages: false }).catch(() => {}); return message.reply('LOCKDOWN ACTIVATED!'); } else { for (const [, ch] of message.guild.channels.cache) if (ch.isTextBased()) await ch.permissionOverwrites.delete(message.guild.roles.everyone).catch(() => {}); return message.reply('Lockdown lifted!'); } }
  });

  // ── Message Delete & Edit Logging
  client.on('messageDelete', async (message) => {
    try {
      if (!message.guild || message.author?.bot) return;
      let executor = null;
      try {
        const logs = await message.guild.fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 1 }).catch(() => null);
        const entry = logs?.entries.first();
        if (entry && entry.target?.id === message.author?.id && Date.now() - entry.createdTimestamp < 4000) {
          executor = entry.executor;
        }
      } catch (_) {}

      const embed = new EmbedBuilder()
        .setColor('#ED4245')
        .setTitle('🗑️ Message Deleted')
        .setDescription(`**Author:** ${message.author ? `${message.author.tag} (<@${message.author.id}>)` : 'Unknown'}\n**Channel:** <#${message.channel.id}>\n**Content:**\n${message.content || '*[Attachment / Embed]*'}${executor ? `\n**Deleted By:** ${executor.tag} (<@${executor.id}>)` : ''}`)
        .setTimestamp();
      await sendLog(message.guild, embed);
    } catch (_) {}
  });

  client.on('messageUpdate', async (oldMessage, newMessage) => {
    try {
      if (!newMessage.guild || newMessage.author?.bot) return;
      if (oldMessage.content === newMessage.content) return;

      const embed = new EmbedBuilder()
        .setColor('#FEE75C')
        .setTitle('✏️ Message Edited')
        .setDescription(`**Author:** ${newMessage.author.tag} (<@${newMessage.author.id}>)\n**Channel:** <#${newMessage.channel.id}>\n**Before:** ${oldMessage.content || '*None*'}\n**After:** ${newMessage.content || '*None*'}`)
        .setTimestamp();
      await sendLog(newMessage.guild, embed);
    } catch (_) {}
  });

  // ── Ultimate Anti-Nuke Event Handlers & Server Logs
  client.on('channelDelete', async (channel) => {
    if (!channel.guild) return;
    try {
      const logs = await channel.guild.fetchAuditLogs({ type: AuditLogEvent.ChannelDelete, limit: 1 }).catch(() => null);
      const entry = logs?.entries.first();
      if (entry && Date.now() - entry.createdTimestamp < 8000) {
        await handleNukeAction(channel.guild, entry.executor, 'antiChannelDelete', 'Channel Deleted (' + channel.name + ')');
      }
      await sendLog(channel.guild, new EmbedBuilder().setColor('#ED4245').setTitle('🗑️ Channel Deleted').setDescription(`**Channel:** #${channel.name} (\`${channel.id}\`)${entry?.executor ? `\n**Action By:** ${entry.executor.tag} (<@${entry.executor.id}>)` : ''}`).setTimestamp());
    } catch (_) {}
  });

  client.on('channelCreate', async (channel) => {
    if (!channel.guild) return;
    try {
      const logs = await channel.guild.fetchAuditLogs({ type: AuditLogEvent.ChannelCreate, limit: 1 }).catch(() => null);
      const entry = logs?.entries.first();
      if (entry && Date.now() - entry.createdTimestamp < 8000) {
        await handleNukeAction(channel.guild, entry.executor, 'antiChannelCreate', 'Channel Created (' + channel.name + ')');
      }
      await sendLog(channel.guild, new EmbedBuilder().setColor('#57F287').setTitle('📁 Channel Created').setDescription(`**Channel:** <#${channel.id}> (\`${channel.name}\`)${entry?.executor ? `\n**Created By:** ${entry.executor.tag} (<@${entry.executor.id}>)` : ''}`).setTimestamp());
    } catch (_) {}
  });

  client.on('channelUpdate', async (oldChannel, newChannel) => {
    if (!newChannel.guild) return;
    try {
      const logs = await newChannel.guild.fetchAuditLogs({ type: AuditLogEvent.ChannelUpdate, limit: 1 }).catch(() => null);
      const entry = logs?.entries.first();
      if (entry && Date.now() - entry.createdTimestamp < 8000) {
        await handleNukeAction(newChannel.guild, entry.executor, 'antiChannelUpdate', 'Channel Modified (' + newChannel.name + ')');
      }
      await sendLog(newChannel.guild, new EmbedBuilder().setColor('#FEE75C').setTitle('⚙️ Channel Updated').setDescription(`**Channel:** <#${newChannel.id}>${entry?.executor ? `\n**Updated By:** ${entry.executor.tag} (<@${entry.executor.id}>)` : ''}`).setTimestamp());
    } catch (_) {}
  });

  client.on('roleDelete', async (role) => {
    if (!role.guild) return;
    try {
      const logs = await role.guild.fetchAuditLogs({ type: AuditLogEvent.RoleDelete, limit: 1 }).catch(() => null);
      const entry = logs?.entries.first();
      if (entry && Date.now() - entry.createdTimestamp < 8000) {
        await handleNukeAction(role.guild, entry.executor, 'antiRoleDelete', 'Role Deleted (' + role.name + ')');
      }
      await sendRoleLog(role.guild, new EmbedBuilder().setColor('#ED4245').setTitle('🗑️ Role Deleted').setDescription(`**Role:** ${role.name} (\`${role.id}\`)${entry?.executor ? `\n**Deleted By:** ${entry.executor.tag} (<@${entry.executor.id}>)` : ''}`).setTimestamp());
    } catch (_) {}
  });

  client.on('roleCreate', async (role) => {
    if (!role.guild) return;
    try {
      const logs = await role.guild.fetchAuditLogs({ type: AuditLogEvent.RoleCreate, limit: 1 }).catch(() => null);
      const entry = logs?.entries.first();
      if (entry && Date.now() - entry.createdTimestamp < 8000) {
        await handleNukeAction(role.guild, entry.executor, 'antiRoleCreate', 'Role Created (' + role.name + ')');
      }
      await sendRoleLog(role.guild, new EmbedBuilder().setColor('#57F287').setTitle('🛡️ Role Created').setDescription(`**Role:** <@&${role.id}> (\`${role.name}\`)${entry?.executor ? `\n**Created By:** ${entry.executor.tag} (<@${entry.executor.id}>)` : ''}`).setTimestamp());
    } catch (_) {}
  });

  client.on('roleUpdate', async (oldRole, newRole) => {
    if (!newRole.guild) return;
    try {
      const dangerous = [
        PermissionsBitField.Flags.Administrator, PermissionsBitField.Flags.ManageGuild,
        PermissionsBitField.Flags.ManageRoles, PermissionsBitField.Flags.ManageChannels,
        PermissionsBitField.Flags.BanMembers, PermissionsBitField.Flags.KickMembers,
      ];
      const gained = dangerous.some(f => !oldRole.permissions.has(f) && newRole.permissions.has(f));
      const logs = await newRole.guild.fetchAuditLogs({ type: AuditLogEvent.RoleUpdate, limit: 1 }).catch(() => null);
      const entry = logs?.entries.first();

      if (gained && entry && Date.now() - entry.createdTimestamp < 8000) {
        await handleNukeAction(newRole.guild, entry.executor, 'antiRoleUpdate', 'Dangerous Permissions Granted to Role (' + newRole.name + ')');
      }
      await sendRoleLog(newRole.guild, new EmbedBuilder().setColor('#FEE75C').setTitle('🛠️ Role Updated').setDescription(`**Role:** <@&${newRole.id}> (\`${newRole.name}\`)${entry?.executor ? `\n**Updated By:** ${entry.executor.tag} (<@${entry.executor.id}>)` : ''}`).setTimestamp());
    } catch (_) {}
  });

  client.on('guildBanAdd', async (ban) => {
    try {
      const logs = await ban.guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanAdd, limit: 1 }).catch(() => null);
      const entry = logs?.entries.first();
      if (entry && Date.now() - entry.createdTimestamp < 8000) {
        await handleNukeAction(ban.guild, entry.executor, 'antiBan', 'Member Banned (' + ban.user.tag + ')');
      }
      await sendLog(ban.guild, new EmbedBuilder().setColor('#ED4245').setTitle('⛔ Member Banned').setDescription(`**User:** ${ban.user.tag} (\`${ban.user.id}\`)${entry?.executor ? `\n**Banned By:** ${entry.executor.tag} (<@${entry.executor.id}>)` : ''}`).setTimestamp());
    } catch (_) {}
  });

  client.on('guildBanRemove', async (ban) => {
    try {
      const logs = await ban.guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanRemove, limit: 1 }).catch(() => null);
      const entry = logs?.entries.first();
      await sendLog(ban.guild, new EmbedBuilder().setColor('#57F287').setTitle('🔓 Member Unbanned').setDescription(`**User:** ${ban.user.tag} (\`${ban.user.id}\`)${entry?.executor ? `\n**Unbanned By:** ${entry.executor.tag} (<@${entry.executor.id}>)` : ''}`).setTimestamp());
    } catch (_) {}
  });

  client.on('webhookUpdate', async (channel) => {
    if (!channel.guild) return;
    try {
      const logs = await channel.guild.fetchAuditLogs({ type: AuditLogEvent.WebhookCreate, limit: 1 }).catch(() => null);
      const entry = logs?.entries.first();
      if (entry && Date.now() - entry.createdTimestamp < 8000) {
        await handleNukeAction(channel.guild, entry.executor, 'antiWebhookCreate', 'Webhook Created in #' + channel.name);
      }
      await sendLog(channel.guild, new EmbedBuilder().setColor('#FEE75C').setTitle('🔗 Webhook Updated').setDescription(`**Channel:** <#${channel.id}>${entry?.executor ? `\n**Action By:** ${entry.executor.tag} (<@${entry.executor.id}>)` : ''}`).setTimestamp());
    } catch (_) {}
  });

  client.on('guildUpdate', async (oldGuild, newGuild) => {
    try {
      const logs = await newGuild.fetchAuditLogs({ type: AuditLogEvent.GuildUpdate, limit: 1 }).catch(() => null);
      const entry = logs?.entries.first();
      if (entry && Date.now() - entry.createdTimestamp < 8000) {
        await handleNukeAction(newGuild, entry.executor, 'antiGuildUpdate', 'Server Settings Modified');
      }
      await sendLog(newGuild, new EmbedBuilder().setColor('#FEE75C').setTitle('🏰 Server Settings Updated').setDescription(`**Server Name:** ${newGuild.name}${entry?.executor ? `\n**Updated By:** ${entry.executor.tag} (<@${entry.executor.id}>)` : ''}`).setTimestamp());
    } catch (_) {}
  });

  client.on('inviteCreate', async (inv) => { await cacheInvites(inv.guild).catch(() => {}); });
  client.on('inviteDelete', async (inv) => { await cacheInvites(inv.guild).catch(() => {}); });

  // ── Discord Native AutoMod Setup
  async function setupAutoMod(guild, logChannelId) {
    const results = [];
    try {
      // Fetch existing rules so we don't duplicate
      const existing = await guild.autoModerationRules.fetch().catch(() => null);
      const existingNames = existing ? [...existing.values()].map(r => r.name) : [];

      const actions = [{ type: 1 }]; // Block message
      if (logChannelId) actions.push({ type: 2, metadata: { channelId: logChannelId } }); // Send alert

      // Rule 1: Block bad words / profanity
      if (!existingNames.includes('THOR APEX - Word Filter')) {
        await guild.autoModerationRules.create({
          name: 'THOR APEX - Word Filter',
          eventType: 1,
          triggerType: 1, // Keyword
          triggerMetadata: {
            keywordFilter: ['nigga','nigger','fuck','shit','bitch','asshole','retard','cunt','whore','faggot'],
            regexPatterns: [],
          },
          actions,
          enabled: true,
          reason: 'THOR APEX AutoMod: Word Filter',
        }).then(() => results.push('Word Filter rule created')).catch(e => results.push('Word Filter: ' + e.message));
      } else { results.push('Word Filter rule already exists'); }

      // Rule 2: Block Discord invite links
      if (!existingNames.includes('THOR APEX - Block Invites')) {
        await guild.autoModerationRules.create({
          name: 'THOR APEX - Block Invites',
          eventType: 1,
          triggerType: 3, // Keyword preset
          triggerMetadata: { presets: [3] }, // 3 = Slurs (discord.js preset - invites are handled via keyword)
          actions,
          enabled: true,
          reason: 'THOR APEX AutoMod: Block Invites',
        }).catch(() => {});
        // Use keyword rule for invite links instead (more reliable)
        await guild.autoModerationRules.create({
          name: 'THOR APEX - Block Invites',
          eventType: 1,
          triggerType: 1,
          triggerMetadata: {
            keywordFilter: ['discord.gg/', 'discord.com/invite/', 'dsc.gg/', 'invite.gg/'],
            regexPatterns: [],
          },
          actions,
          enabled: true,
          reason: 'THOR APEX AutoMod: Block Discord Invites',
        }).then(() => results.push('Block Invites rule created')).catch(e => results.push('Block Invites: ' + e.message));
      } else { results.push('Block Invites rule already exists'); }

      // Rule 3: Anti-Spam (mention spam)
      if (!existingNames.includes('THOR APEX - Anti Mention Spam')) {
        await guild.autoModerationRules.create({
          name: 'THOR APEX - Anti Mention Spam',
          eventType: 1,
          triggerType: 5, // Mention spam
          triggerMetadata: { mentionTotalLimit: 5 },
          actions,
          enabled: true,
          reason: 'THOR APEX AutoMod: Anti Mention Spam',
        }).then(() => results.push('Anti Mention Spam rule created')).catch(e => results.push('Anti Mention Spam: ' + e.message));
      } else { results.push('Anti Mention Spam rule already exists'); }

      // Rule 4: Block spam content (built-in preset)
      if (!existingNames.includes('THOR APEX - Anti Spam Content')) {
        await guild.autoModerationRules.create({
          name: 'THOR APEX - Anti Spam Content',
          eventType: 1,
          triggerType: 3, // Keyword preset
          triggerMetadata: { presets: [1, 2] }, // 1=Profanity, 2=Sexual
          actions,
          enabled: true,
          reason: 'THOR APEX AutoMod: Block Spam/Sexual Content',
        }).then(() => results.push('Anti Spam Content rule created')).catch(e => results.push('Anti Spam Content: ' + e.message));
      } else { results.push('Anti Spam Content rule already exists'); }

    } catch (err) { results.push('AutoMod setup error: ' + err.message); }
    return results;
  }

  async function disableAutoMod(guild) {
    const results = [];
    try {
      const rules = await guild.autoModerationRules.fetch().catch(() => null);
      if (!rules || rules.size === 0) return ['No AutoMod rules found'];
      const thorRules = rules.filter(r => r.name.startsWith('THOR APEX'));
      for (const [, rule] of thorRules) {
        await rule.edit({ enabled: false }).then(() => results.push('Disabled: ' + rule.name)).catch(e => results.push('Failed: ' + rule.name + ' - ' + e.message));
      }
      if (results.length === 0) results.push('No THOR APEX AutoMod rules found');
    } catch (err) { results.push('Error: ' + err.message); }
    return results;
  }

  // ── Slash Command Handler
  client.on('interactionCreate', async (interaction) => {
    if (interaction.isStringSelectMenu()) {
      const id = interaction.customId;
      if (id === 'am_sel_toggle') {
        const selected = interaction.values;
        if (!config.security) config.security = {};
        AUTOMOD_EVENTS.forEach(ev => {
          config.security[ev.id] = selected.includes(ev.id);
        });
        saveConfig();
        await interaction.update(buildAutoModPanel(interaction.guild, '✅ **Selected AutoMod events updated!**'));
        return;
      }
      if (id === 'am_pun_sel_event') {
        const selectedEventId = interaction.values[0];
        await interaction.update(buildPunishmentPanel(interaction.guild, null, selectedEventId));
        return;
      }
      if (id.startsWith('am_pun_sel_action_')) {
        const eventId = id.replace('am_pun_sel_action_', '');
        const selectedAction = interaction.values[0];
        if (!config.security) config.security = {};
        if (!config.security.eventPunishments) config.security.eventPunishments = {};
        config.security.eventPunishments[eventId] = selectedAction;
        config.security.automodPunishment = selectedAction;
        saveConfig();
        const evObj = AUTOMOD_EVENTS.find(e => e.id === eventId);
        await interaction.update(buildPunishmentPanel(interaction.guild, `✅ **Punishment for ${evObj?.label || 'Event'} set to ${selectedAction.toUpperCase()}!**`));
        return;
      }
      if (id.startsWith('wl_sel_')) {
        const targetId = id.replace('wl_sel_', '');
        const selectedPerm = interaction.values[0];
        if (!config.security.whitelistData) config.security.whitelistData = {};
        if (!config.security.whitelistData[targetId]) config.security.whitelistData[targetId] = {};
        config.security.whitelistData[targetId][selectedPerm] = !config.security.whitelistData[targetId][selectedPerm];
        saveConfig();
        await interaction.update(buildWhitelistPanel(interaction.guild, targetId));
        return;
      }
    }

    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id === 'am_enable_all') {
        await interaction.deferUpdate().catch(() => {});
        if (!config.security) config.security = {};
        AUTOMOD_EVENTS.forEach(ev => config.security[ev.id] = true);
        config.security.antiSpam = true;
        config.security.antiLink = true;
        config.security.wordFilter = true;
        config.security.antiNuke = true;
        saveConfig();
        await setupAutoMod(interaction.guild, config.logChannelId).catch(() => {});
        await interaction.editReply(buildAutoModPanel(interaction.guild, '✅ **ALL 7 AutoMod events & Native Discord rules are now ENABLED!**')).catch(() => {});
        return;
      }
      if (id === 'am_cancel') {
        await interaction.update({ content: '❌ AutoMod Setup Cancelled.', embeds: [], components: [] });
        return;
      }
      if (id.startsWith('wl_grant_all_')) {
        const targetId = id.replace('wl_grant_all_', '');
        if (!config.security.whitelistData) config.security.whitelistData = {};
        const obj = {}; PERM_LIST.forEach(p => obj[p.id] = true);
        config.security.whitelistData[targetId] = obj;
        if (!config.security.whitelistedUsers) config.security.whitelistedUsers = [];
        if (!config.security.whitelistedUsers.includes(targetId)) config.security.whitelistedUsers.push(targetId);
        saveConfig();
        await interaction.update(buildWhitelistPanel(interaction.guild, targetId));
        return;
      }
      if (id.startsWith('wl_remove_all_')) {
        const targetId = id.replace('wl_remove_all_', '');
        if (config.security.whitelistData) delete config.security.whitelistData[targetId];
        config.security.whitelistedUsers = (config.security.whitelistedUsers || []).filter(u => u !== targetId);
        config.security.whitelistedRoles = (config.security.whitelistedRoles || []).filter(r => r !== targetId);
        saveConfig();
        await interaction.update(buildWhitelistPanel(interaction.guild, targetId));
        return;
      }
    }

    if (!interaction.isChatInputCommand()) return;
    const { commandName, guild } = interaction;

    if (commandName === 'setup') {
      await interaction.deferReply({ ephemeral: true });
      const channels = guild.channels.cache; const results = [];
      const detect = kws => channels.find(c => c.isTextBased() && kws.some(k => c.name.toLowerCase().includes(k)));
      const wCh = detect(['welcome','join','arrivals']), lCh = detect(['leave','goodbye','farewell','bye']),
            rCh = detect(['rule','rules','guidelines']), rolCh = detect(['role','roles','selfrole']),
            gCh = detect(['general','chat','lounge','main']), logCh = detect(['log','logs','mod-log','modlog','audit']);
      if (wCh)   { config.welcomeChannelId = wCh.id;   results.push('✅ Welcome: <#' + wCh.id + '>'); }   else results.push('⚠️ Welcome channel not found - use /setwelcome');
      if (lCh)   { config.leaveChannelId   = lCh.id;   results.push('✅ Leave: <#' + lCh.id + '>'); }
      if (rCh)   { config.rulesChannelId   = rCh.id;   results.push('✅ Rules: <#' + rCh.id + '>'); }
      if (rolCh) { config.rolesChannelId   = rolCh.id; results.push('✅ Roles: <#' + rolCh.id + '>'); }
      if (gCh)   { config.generalChannelId = gCh.id;   results.push('✅ General: <#' + gCh.id + '>'); }
      if (logCh) { config.logChannelId     = logCh.id; results.push('✅ Log: <#' + logCh.id + '>'); }
      results.push('🛡️ Security: Anti-Spam ON | Anti-Link ON | Word Filter ON | Alt Detection ON | Anti-Nuke ON');
      saveConfig();
      // Auto-setup Discord Native AutoMod
      results.push('');
      results.push('**Discord AutoMod Rules:**');
      const autoModResults = await setupAutoMod(guild, config.logChannelId);
      autoModResults.forEach(r => results.push('🤖 ' + r));
      await interaction.editReply({ embeds: [new EmbedBuilder().setColor('#57F287').setTitle('✅ Auto-Setup Complete!').setDescription(results.join('\n')).addFields({ name: 'Next Steps', value: 'Run /testwelcome to preview\nRun /security to view security settings\nRun /automod status to check AutoMod rules\nRun /help for all commands' }).setThumbnail(guild.iconURL({ size: 256 })).setTimestamp()] });
      return;
    }

    if (commandName === 'automod') {
      const action = interaction.options.getString('action');
      await interaction.deferReply({ ephemeral: true });

      if (action === 'punishment') {
        await interaction.editReply(buildPunishmentPanel(guild));
        return;
      }
      if (action === 'disable') {
        if (!config.security) config.security = {};
        AUTOMOD_EVENTS.forEach(ev => config.security[ev.id] = false);
        saveConfig();
        const amResults = await disableAutoMod(guild);
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor('#ED4245').setTitle('🤖 AutoMod Disabled').setDescription(amResults.join('\n')).setTimestamp()] });
        return;
      }
      await interaction.editReply(buildAutoModPanel(guild));
      return;
    }

    if (commandName === 'automodpunishment') {
      await interaction.deferReply({ ephemeral: true });
      await interaction.editReply(buildPunishmentPanel(guild));
      return;
    }

    if (commandName === 'whitelist') {
      const action = interaction.options.getString('action');
      const targetUser = interaction.options.getUser('user');
      const targetRole = interaction.options.getRole('role');
      const sec = config.security || {};
      if (!sec.whitelistedUsers) sec.whitelistedUsers = [];
      if (!sec.whitelistedRoles) sec.whitelistedRoles = [];

      if (action === 'manage') {
        const target = targetUser || targetRole || interaction.user;
        await interaction.reply(buildWhitelistPanel(guild, target.id));
        return;
      }
      if (action === 'add_user') {
        if (!targetUser) return safeReply(interaction, 'Please select a user to whitelist!');
        if (!sec.whitelistedUsers.includes(targetUser.id)) sec.whitelistedUsers.push(targetUser.id);
        saveConfig();
        return safeReply(interaction, '✅ **' + targetUser.tag + '** is now **whitelisted**! They will bypass AutoMod and Anti-Spam.');
      }
      if (action === 'remove_user') {
        if (!targetUser) return safeReply(interaction, 'Please select a user to remove!');
        sec.whitelistedUsers = sec.whitelistedUsers.filter(id => id !== targetUser.id);
        saveConfig();
        return safeReply(interaction, '❌ **' + targetUser.tag + '** removed from whitelist.');
      }
      if (action === 'add_role') {
        if (!targetRole) return safeReply(interaction, 'Please select a role to whitelist!');
        if (!sec.whitelistedRoles.includes(targetRole.id)) sec.whitelistedRoles.push(targetRole.id);
        saveConfig();
        return safeReply(interaction, '✅ Role **' + targetRole.name + '** is now **whitelisted**! Members with this role bypass AutoMod.');
      }
      if (action === 'remove_role') {
        if (!targetRole) return safeReply(interaction, 'Please select a role to remove!');
        sec.whitelistedRoles = sec.whitelistedRoles.filter(id => id !== targetRole.id);
        saveConfig();
        return safeReply(interaction, '❌ Role **' + targetRole.name + '** removed from whitelist.');
      }
      if (action === 'list') {
        const uList = sec.whitelistedUsers.length > 0 ? sec.whitelistedUsers.map(id => '<@' + id + '>').join(', ') : 'None';
        const rList = sec.whitelistedRoles.length > 0 ? sec.whitelistedRoles.map(id => '<@&' + id + '>').join(', ') : 'None';
        await interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('🛡️ AutoMod Whitelist - ' + guild.name).addFields({ name: 'Whitelisted Users', value: uList }, { name: 'Whitelisted Roles', value: rList }).setTimestamp()] });
        return;
      }
    }

    if (commandName === 'tagnotify') {
      config.security.tagNotify = interaction.options.getString('toggle') === 'on';
      saveConfig();
      return safeReply(interaction, '🔔 Tag DM Notifications are now **' + (config.security.tagNotify ? 'ON' : 'OFF') + '**!');
    }

    if (commandName === 'setwelcome')    { const ch = interaction.options.getChannel('channel') || interaction.channel; config.welcomeChannelId = ch.id; saveConfig(); return safeReply(interaction, 'Welcome channel set!'); }
    if (commandName === 'setleave')      { config.leaveChannelId   = interaction.options.getChannel('channel').id; saveConfig(); return safeReply(interaction, 'Leave channel set!'); }
    if (commandName === 'setrules')      { config.rulesChannelId   = interaction.options.getChannel('channel').id; saveConfig(); return safeReply(interaction, 'Rules channel set!'); }
    if (commandName === 'setroles')      { config.rolesChannelId   = interaction.options.getChannel('channel').id; saveConfig(); return safeReply(interaction, 'Roles channel set!'); }
    if (commandName === 'setgeneral')    { config.generalChannelId = interaction.options.getChannel('channel').id; saveConfig(); return safeReply(interaction, 'General channel set!'); }
    if (commandName === 'setlog')        { config.logChannelId     = interaction.options.getChannel('channel').id; saveConfig(); return safeReply(interaction, 'Mod Log channel set!'); }
    if (commandName === 'setvoicelog')   { config.voiceLogChannelId  = interaction.options.getChannel('channel').id; saveConfig(); return safeReply(interaction, 'Voice Log channel set to <#' + config.voiceLogChannelId + '>!'); }
    if (commandName === 'setrolelog')    { config.roleLogChannelId   = interaction.options.getChannel('channel').id; saveConfig(); return safeReply(interaction, 'Role Log channel set to <#' + config.roleLogChannelId + '>!'); }
    if (commandName === 'setmemberlog')  { config.memberLogChannelId = interaction.options.getChannel('channel').id; saveConfig(); return safeReply(interaction, 'Member Log channel set to <#' + config.memberLogChannelId + '>!'); }
    if (commandName === 'setautorole')   { config.autoRoleId = interaction.options.getRole('role').id; saveConfig(); return safeReply(interaction, 'Auto-role set to **' + interaction.options.getRole('role').name + '**!'); }
    if (commandName === 'setwelcomecolor') { const color = interaction.options.getString('color').trim(); if (!isHex(color)) return safeReply(interaction, 'Invalid hex color! Use #RRGGBB'); config.embedColor = color; saveConfig(); return safeReply(interaction, 'Color set to **' + color + '**!'); }
    if (commandName === 'setwelcometext') { const g = interaction.options.getString('greeting'), s = interaction.options.getString('subtitle'), o = interaction.options.getString('outro'); if (!g && !s && !o) return safeReply(interaction, 'Provide at least one option!'); if (g) config.greetingPrefix = g; if (s) config.welcomeSubtitle = s; if (o) config.outroText = o; saveConfig(); return safeReply(interaction, 'Welcome text updated!'); }
    if (commandName === 'setleavetext')  { config.leaveText = interaction.options.getString('message'); saveConfig(); return safeReply(interaction, 'Leave text updated!'); }
    if (commandName === 'testwelcome')   { await interaction.reply({ content: '[TEST] Welcome <@' + interaction.user.id + '> to **THOR APEX ⚡**! 🎉', embeds: [mkWelcomeEmbed(interaction.member, guild)] }); return; }
    if (commandName === 'testleave')     { await interaction.reply({ content: '[TEST] Goodbye <@' + interaction.user.id + '>!', embeds: [mkLeaveEmbed(interaction.member, guild)] }); return; }
    if (commandName === 'welcomeconfig') {
      const c = config;
      await interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(isHex(c.embedColor) ? c.embedColor : '#5865F2').setTitle('THOR APEX Bot Config').addFields(
        { name: 'Channels', value: ['Welcome: ' + (c.welcomeChannelId ? '<#' + c.welcomeChannelId + '>' : 'Not set'), 'Leave: ' + (c.leaveChannelId ? '<#' + c.leaveChannelId + '>' : 'Not set'), 'Rules: ' + (c.rulesChannelId ? '<#' + c.rulesChannelId + '>' : 'Not set'), 'Roles: ' + (c.rolesChannelId ? '<#' + c.rolesChannelId + '>' : 'Not set'), 'General: ' + (c.generalChannelId ? '<#' + c.generalChannelId + '>' : 'Not set'), 'Log: ' + (c.logChannelId ? '<#' + c.logChannelId + '>' : 'Not set')].join('\n') },
        { name: 'Settings', value: 'Color: ' + c.embedColor + '\nAuto-Role: ' + (c.autoRoleId ? '<@&' + c.autoRoleId + '>' : 'Not set') },
      ).setTimestamp()] });
      return;
    }
    if (commandName === 'security') {
      const s = config.security || {}; const ic = v => v ? 'YES' : 'NO';
      await interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor('#ED4245').setTitle('THOR APEX Security Settings').addFields({ name: 'Modules', value: ['Anti-Raid: ' + ic(s.antiRaid) + ' (threshold: ' + (s.raidThreshold || 10) + ' joins/10s)', 'Anti-Spam: ' + ic(s.antiSpam) + ' (threshold: ' + (s.spamThreshold || 5) + ' msgs/' + ((s.spamWindow || 5000) / 1000) + 's)', 'Anti-Link/Ads: ' + ic(s.antiLink), 'Word Filter: ' + ic(s.wordFilter) + ' (' + (s.blacklistedWords ? s.blacklistedWords.length : 0) + ' words)', 'Alt Detection: ' + ic(s.altDetection) + ' (min: ' + (s.altMinDays || 7) + ' days)', 'Anti-Nuke: ' + ic(s.antiNuke), 'Lockdown: ' + (s.lockdown ? 'ACTIVE' : 'OFF')].join('\n') }).setFooter({ text: 'Use /antispam /antilink /antinuke /lockdown to toggle' }).setTimestamp()] });
      return;
    }
    const togMap = { antispam: 'antiSpam', antilink: 'antiLink', antiraid: 'antiRaid', antinuke: 'antiNuke' };
    if (togMap[commandName]) { config.security[togMap[commandName]] = interaction.options.getString('toggle') === 'on'; saveConfig(); return safeReply(interaction, commandName + ' is now ' + (config.security[togMap[commandName]] ? 'ON' : 'OFF')); }
    if (commandName === 'altdetection') { config.security.altDetection = interaction.options.getString('toggle') === 'on'; const d = interaction.options.getInteger('mindays'); if (d) config.security.altMinDays = d; saveConfig(); return safeReply(interaction, 'Alt Detection is now ' + (config.security.altDetection ? 'ON' : 'OFF') + ' (min: ' + config.security.altMinDays + ' days)'); }
    if (commandName === 'wordfilter')   { config.security.wordFilter = interaction.options.getString('toggle') === 'on'; saveConfig(); return safeReply(interaction, 'Word Filter is now ' + (config.security.wordFilter ? 'ON' : 'OFF')); }
    if (commandName === 'addword')      { const word = interaction.options.getString('word').toLowerCase(); if (!config.security.blacklistedWords.includes(word)) config.security.blacklistedWords.push(word); saveConfig(); return safeReply(interaction, 'Word added! (Total: ' + config.security.blacklistedWords.length + ')'); }
    if (commandName === 'removeword')   { const word = interaction.options.getString('word').toLowerCase(); config.security.blacklistedWords = config.security.blacklistedWords.filter(w => w !== word); saveConfig(); return safeReply(interaction, 'Word removed!'); }
    if (commandName === 'lockdown') {
      const enable = interaction.options.getString('toggle') === 'on'; config.security.lockdown = enable; saveConfig();
      await interaction.deferReply({ ephemeral: false });
      for (const [, ch] of guild.channels.cache) if (ch.isTextBased()) { if (enable) await ch.permissionOverwrites.create(guild.roles.everyone, { SendMessages: false }).catch(() => {}); else await ch.permissionOverwrites.delete(guild.roles.everyone).catch(() => {}); }
      await interaction.editReply({ content: enable ? 'LOCKDOWN ACTIVATED! No one can send messages.' : 'Lockdown lifted! Server is back to normal.' }); return;
    }
    if (commandName === 'warn') {
      const target = interaction.options.getUser('user'), reason = interaction.options.getString('reason') || 'No reason';
      if (!warnings[target.id]) warnings[target.id] = [];
      warnings[target.id].push({ reason, mod: interaction.user.tag, ts: Date.now() }); saveWarnings();
      try { await target.send('You were warned in **' + guild.name + '**. Reason: ' + reason); } catch (_) {}
      await sendLog(guild, new EmbedBuilder().setColor('#FEE75C').setTitle('Member Warned').addFields({ name: 'User', value: target.tag, inline: true }, { name: 'Mod', value: interaction.user.tag, inline: true }, { name: 'Reason', value: reason }, { name: 'Total', value: '' + warnings[target.id].length, inline: true }).setTimestamp());
      return safeReply(interaction, '<@' + target.id + '> warned. Reason: **' + reason + '** (Total: ' + warnings[target.id].length + ')');
    }
    if (commandName === 'warnings') { const target = interaction.options.getUser('user'); const list = warnings[target.id] || []; if (list.length === 0) return safeReply(interaction, '<@' + target.id + '> has no warnings!'); const desc = list.map((w, i) => (i + 1) + '. ' + w.reason + ' - by ' + w.mod).join('\n'); await interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor('#FEE75C').setTitle('Warnings for ' + target.tag).setDescription(desc).setFooter({ text: 'Total: ' + list.length }).setTimestamp()] }); return; }
    if (commandName === 'clearwarns') { const target = interaction.options.getUser('user'); delete warnings[target.id]; saveWarnings(); return safeReply(interaction, 'All warnings cleared for <@' + target.id + '>!'); }
    if (commandName === 'mute') { const target = interaction.options.getUser('user'), reason = interaction.options.getString('reason') || 'No reason'; await interaction.deferReply({ ephemeral: true }); try { const m = await guild.members.fetch(target.id); const mr = await getMuteRole(guild); if (!mr) return interaction.editReply('Could not find/create Muted role.'); await m.roles.add(mr, reason); await sendLog(guild, new EmbedBuilder().setColor('#FF6600').setTitle('Member Muted').addFields({ name: 'User', value: target.tag, inline: true }, { name: 'Mod', value: interaction.user.tag, inline: true }, { name: 'Reason', value: reason }).setTimestamp()); await interaction.editReply('<@' + target.id + '> muted.'); } catch (_) { await interaction.editReply('Could not mute that user.'); } return; }
    if (commandName === 'unmute') { const target = interaction.options.getUser('user'); await interaction.deferReply({ ephemeral: true }); try { const m = await guild.members.fetch(target.id); const mr = await getMuteRole(guild); if (mr) await m.roles.remove(mr); await interaction.editReply('<@' + target.id + '> unmuted.'); } catch (_) { await interaction.editReply('Could not unmute.'); } return; }
    if (commandName === 'kick') { const target = interaction.options.getUser('user'), reason = interaction.options.getString('reason') || 'No reason'; await interaction.deferReply({ ephemeral: true }); try { const m = await guild.members.fetch(target.id); await m.kick(reason); await sendLog(guild, new EmbedBuilder().setColor('#FF6600').setTitle('Member Kicked').addFields({ name: 'User', value: target.tag, inline: true }, { name: 'Mod', value: interaction.user.tag, inline: true }, { name: 'Reason', value: reason }).setTimestamp()); await interaction.editReply('**' + target.tag + '** kicked.'); } catch (_) { await interaction.editReply('Could not kick.'); } return; }
    if (commandName === 'ban') { const target = interaction.options.getUser('user'), reason = interaction.options.getString('reason') || 'No reason'; await interaction.deferReply({ ephemeral: true }); try { await guild.members.ban(target.id, { reason }); await sendLog(guild, new EmbedBuilder().setColor('#ED4245').setTitle('Member Banned').addFields({ name: 'User', value: target.tag, inline: true }, { name: 'Mod', value: interaction.user.tag, inline: true }, { name: 'Reason', value: reason }).setTimestamp()); await interaction.editReply('**' + target.tag + '** banned.'); } catch (_) { await interaction.editReply('Could not ban.'); } return; }
    if (commandName === 'unban') { const uid = interaction.options.getString('userid'); await interaction.deferReply({ ephemeral: true }); try { await guild.bans.remove(uid, 'Unbanned by mod'); await interaction.editReply('User **' + uid + '** unbanned.'); } catch (_) { await interaction.editReply('Could not unban. Check the ID.'); } return; }
    if (commandName === 'purge') { const amount = interaction.options.getInteger('amount'); await interaction.deferReply({ ephemeral: true }); try { const deleted = await interaction.channel.bulkDelete(amount, true); await interaction.editReply('Deleted **' + deleted.size + '** messages.'); } catch (_) { await interaction.editReply('Could not delete messages. They may be older than 14 days.'); } return; }
    if (commandName === 'myinvites') { try { const inv = await guild.invites.fetch().catch(() => null); let total = 0; if (inv) inv.forEach(i => { if (i.inviter && i.inviter.id === interaction.user.id) total += (i.uses || 0); }); await interaction.reply({ ephemeral: true, content: 'You have **' + total + '** total invites in **' + guild.name + '**!' }); } catch (_) { await safeReply(interaction, 'Could not fetch invite data.'); } return; }
    if (commandName === 'invites') { const target = interaction.options.getUser('user') || interaction.user; try { const inv = await guild.invites.fetch().catch(() => null); let total = 0; if (inv) inv.forEach(i => { if (i.inviter && i.inviter.id === target.id) total += (i.uses || 0); }); await interaction.reply({ ephemeral: true, content: '**' + target.tag + '** has **' + total + '** total invites!' }); } catch (_) { await safeReply(interaction, 'Could not fetch invite data.'); } return; }
    if (commandName === 'invitetop') { try { const inv = await guild.invites.fetch().catch(() => null); if (!inv || inv.size === 0) return safeReply(interaction, 'No invites found!'); const totals = new Map(); inv.forEach(i => { if (!i.inviter) return; totals.set(i.inviter.id, (totals.get(i.inviter.id) || 0) + (i.uses || 0)); }); const sorted = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10); const desc = sorted.map((e, i) => (i + 1) + '. <@' + e[0] + '> - **' + e[1] + '** invites').join('\n'); await interaction.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('Top Inviters - ' + guild.name).setDescription(desc || 'No data').setTimestamp()] }); } catch (_) { await safeReply(interaction, 'Could not fetch invite data.'); } return; }
    if (commandName === 'play') { const vc = interaction.member?.voice?.channel; if (!vc) return safeReply(interaction, 'Join a Voice Channel first!'); const r = addToQ(guild, vc, interaction.user, interaction.options.getString('song')); await interaction.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle(r.position === 1 ? 'Now Playing' : 'Added to Queue').setDescription('**' + r.track.title + '**').addFields({ name: 'Voice', value: '<#' + vc.id + '>', inline: true }, { name: 'By', value: '<@' + interaction.user.id + '>', inline: true }).setTimestamp()] }); return; }
    if (commandName === 'pause')  { return safeReply(interaction, 'Paused.', false); }
    if (commandName === 'resume') { return safeReply(interaction, 'Resumed.', false); }
    if (commandName === 'skip')   { const q = getQ(guild.id); if (q.queue.length > 0) { const s = q.queue.shift(); return safeReply(interaction, 'Skipped: **' + (s?.title || 'Song') + '**', false); } return safeReply(interaction, 'Queue is empty!'); }
    if (commandName === 'stop')   { const q = getQ(guild.id); q.queue = []; q.isPlaying = false; if (q.connection) { try { q.connection.destroy(); } catch (_) {} q.connection = null; } return safeReply(interaction, 'Stopped and left voice channel.', false); }
    if (commandName === 'queue')  { const vc = interaction.member?.voice?.channel; const sp = interaction.options.getString('song'); if (sp) { if (!vc) return safeReply(interaction, 'Join Voice first!'); const r = addToQ(guild, vc, interaction.user, sp); return interaction.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('Added to Queue').setDescription('**' + r.track.title + '**').addFields({ name: 'Position', value: '#' + r.position }).setTimestamp()] }); } const q = getQ(guild.id); if (q.queue.length === 0) return safeReply(interaction, 'Queue empty! Use /play'); const list = q.queue.slice(0, 10).map((t, i) => (i + 1) + '. **' + t.title + '** (<@' + t.requestedBy + '>)').join('\n'); await interaction.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('Music Queue').setDescription(list).setFooter({ text: 'Total: ' + q.queue.length }).setTimestamp()] }); return; }
    if (commandName === 'nowplaying') { const t = getQ(guild.id).queue[0]; if (!t) return safeReply(interaction, 'Nothing playing! Use /play'); await interaction.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('Now Playing').setDescription('**' + t.title + '**').addFields({ name: 'By', value: '<@' + t.requestedBy + '>' }).setTimestamp()] }); return; }
    if (commandName === 'radio') { const vc = interaction.member?.voice?.channel; if (!vc) return safeReply(interaction, 'Join a Voice Channel first!'); const genre = interaction.options.getString('genre') || 'lofi'; const sel = RADIO_STREAMS[genre] || RADIO_STREAMS.lofi; const q = getQ(guild.id); if (voiceLib) { if (!q.connection) { try { q.connection = voiceLib.joinVoiceChannel({ channelId: vc.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false }); } catch (_) {} } if (!q.player) { q.player = voiceLib.createAudioPlayer(); q.connection?.subscribe(q.player); } try { q.player.play(voiceLib.createAudioResource(sel.url, { inputType: voiceLib.StreamType.Arbitrary })); } catch (_) {} } await interaction.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('Radio: ' + sel.name).setDescription('Playing in <#' + vc.id + '>!').setTimestamp()] }); return; }
    if (commandName === 'help') {
      await interaction.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('THOR APEX - All-in-One Bot Commands').setThumbnail(guild.iconURL({ size: 256 })).addFields(
        { name: '⚙️ Setup', value: '/setup /setwelcome /setleave /setrules /setroles /setgeneral /setlog /setautorole' },
        { name: '🎉 Welcome Customize', value: '/setwelcomecolor /setwelcometext /setleavetext /testwelcome /testleave /welcomeconfig' },
        { name: '🛡️ Security', value: '/security /antispam /antilink /antiraid /antinuke /altdetection /wordfilter /addword /removeword /lockdown' },
        { name: '🤖 AutoMod (Discord Native)', value: '/automod enable — Setup Discord AutoMod rules\n/automod disable — Disable AutoMod rules\n/automod status — View all AutoMod rules' },
        { name: '⚔️ Moderation', value: '/warn /warnings /clearwarns /mute /unmute /kick /ban /unban /purge\nAlso: !warn !mute !kick !ban !lockdown' },
        { name: '📩 Inviter', value: '/myinvites /invites [@user] /invitetop' },
        { name: '🎵 Music', value: '/play /pause /resume /skip /stop /queue /nowplaying /radio\nAlso: !play !skip !stop !queue !np' },
      ).setFooter({ text: 'THOR APEX - Made exclusively for this server' }).setTimestamp()] }); return;
    }
  });

  const TOKEN = process.env.DISCORD_TOKEN;
  if (!TOKEN || TOKEN === 'your_bot_token_here') { console.error('DISCORD_TOKEN is missing!'); process.exit(1); }
  client.login(TOKEN).catch(err => {
    if (err.message.includes('disallowed intents') || err.message.includes('Privileged intent')) {
      console.error('PRIVILEGED INTENTS ERROR! Enable SERVER MEMBERS INTENT and MESSAGE CONTENT INTENT at: https://discord.com/developers/applications');
      process.exit(1);
    } else { console.error('Login error:', err.message); process.exit(1); }
  });
}
startBot();
