const {
  Client, GatewayIntentBits, Partials, EmbedBuilder,
  PermissionsBitField, REST, Routes, AuditLogEvent,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ChannelType,
} = require('discord.js');
require('dotenv').config();
const http  = require('http');
const https = require('https');
const os    = require('os');

// ── Specialized Modules ──
const { getGuildConfig, saveGuildConfig, updateGuildConfig } = require('./src/config/guildConfig');
const { handleAntiNukeEvent, isTrustedUser } = require('./src/security/antiNuke');
const { processMessage, processMemberJoin } = require('./src/automod/autoModEngine');
const {
  setupAllLogChannels, resolveLogChannel, logMember, logMessage,
  logModeration, logSecurity, logRole, logChannel, logVoice,
  logServerSettings, logInvite, logWebhook, logBot, logWelcome,
} = require('./src/logging/loggerService');
const {
  buildWelcomeMessage, buildGoodbyeMessage, handleMemberJoin,
  handleMemberLeave, runWelcomeDiagnostic,
} = require('./src/welcome/welcomeService');
const {
  warnMember, timeoutMember, untimeoutMember, kickMember,
  banMember, softbanMember, purgeMessages, lockChannel, unlockChannel,
} = require('./src/moderation/modService');
const { buildApplicationCommands } = require('./src/commands/commandRegistry');
const { redactSecrets, safeReply, isHex, formatDuration } = require('./src/utils/helpers');

// Setup FFMPEG static if present
try {
  const ff = require('ffmpeg-static');
  if (ff) process.env.FFMPEG_PATH = ff;
} catch (_) {}

// ── Global Process Safety & Diagnostics ──
process.on('unhandledRejection', r => console.error(redactSecrets(`[Unhandled Rejection]: ${r?.stack || r}`)));
process.on('uncaughtException',  e => console.error(redactSecrets(`[Uncaught Exception]: ${e?.stack || e}`)));

// ── HTTP Health Check Server (24/7 Hosting Compatibility) ──
const PORT = process.env.PORT || 10000;
const startTime = Date.now();
const healthServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    bot: 'THOR APEX All-in-One Security & Welcome Bot',
    version: '2.0.0',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    memoryUsageMB: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    timestamp: new Date().toISOString(),
  }));
});
healthServer.listen(PORT, '0.0.0.0', () => console.log(`🌐 Health check server listening on port ${PORT}`));

// ── Voice / Music System (Multi-Guild Isolated Sessions, Spotify Resolver, Intelligent Search) ──
let voiceLib = null; try { voiceLib = require('@discordjs/voice'); } catch (e) { console.log('Voice:', e.message); }
let playdl   = null; try { playdl   = require('play-dl');          } catch (e) { console.log('play-dl:', e.message); }
let isPlayDlReady = false;

async function ensurePlayDlReady() {
  if (!playdl || isPlayDlReady) return;
  try {
    const c = await playdl.getFreeClientID();
    if (c) { await playdl.setToken({ soundcloud: { client_id: c } }); }
    isPlayDlReady = true;
  } catch (_) {}
}

let spotifyAccessToken = null;
let spotifyTokenExpiry = 0;

async function getSpotifyToken() {
  const cid = process.env.SPOTIFY_CLIENT_ID;
  const csec = process.env.SPOTIFY_CLIENT_SECRET;
  if (!cid || !csec) return null;
  if (spotifyAccessToken && Date.now() < spotifyTokenExpiry) return spotifyAccessToken;

  try {
    const creds = Buffer.from(cid + ':' + csec).toString('base64');
    const res = await new Promise((resolve) => {
      const req = https.request('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + creds,
          'Content-Type': 'application/x-www-form-urlencoded',
        }
      }, (r) => {
        let body = '';
        r.on('data', c => body += c);
        r.on('end', () => resolve(body));
      });
      req.on('error', () => resolve(''));
      req.write('grant_type=client_credentials');
      req.end();
    });

    const parsed = JSON.parse(res);
    if (parsed.access_token) {
      spotifyAccessToken = parsed.access_token;
      spotifyTokenExpiry = Date.now() + ((parsed.expires_in || 3600) - 60) * 1000;
      return spotifyAccessToken;
    }
  } catch (_) {}
  return null;
}

function fetchHttpsJson(url, headers = {}) {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', ...headers } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (_) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function fetchHttpsHtml(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', () => resolve(''));
  });
}

async function resolveSpotifyMetadata(spotifyUrl) {
  const token = await getSpotifyToken();
  if (token) {
    try {
      if (spotifyUrl.includes('/track/')) {
        const trackId = spotifyUrl.split('/track/')[1]?.split('?')[0];
        if (trackId) {
          const data = await fetchHttpsJson('https://api.spotify.com/v1/tracks/' + trackId, { 'Authorization': 'Bearer ' + token });
          if (data && data.name) {
            return [{
              title: data.name,
              artist: data.artists?.map(a => a.name).join(', ') || '',
              album: data.album?.name || '',
              durationSec: Math.round((data.duration_ms || 0) / 1000),
              thumbnail: data.album?.images?.[0]?.url || '',
              query: (data.name + ' ' + (data.artists?.[0]?.name || '')).trim()
            }];
          }
        }
      }
    } catch (_) {}
  }
  return null;
}

const musicQueues = new Map();

function getQ(guildId) {
  if (!musicQueues.has(guildId)) {
    musicQueues.set(guildId, {
      queue: [],
      history: [],
      connection: null,
      player: null,
      currentTrack: null,
      isPlaying: false,
      isPaused: false,
      loopMode: 'off',
      volume: 100,
      panelMessage: null,
      textChannel: null,
    });
  }
  return musicQueues.get(guildId);
}

function stopMusicSession(guildId) {
  const q = musicQueues.get(guildId);
  if (!q) return;
  q.queue = [];
  q.history = [];
  q.isPlaying = false;
  q.isPaused = false;
  q.currentTrack = null;
  if (q.player) {
    try { q.player.stop(true); } catch (_) {}
  }
  if (q.connection) {
    try { q.connection.destroy(); } catch (_) {}
    q.connection = null;
  }
  musicQueues.delete(guildId);
}

function handleTrackEnded(guildId) {
  const q = musicQueues.get(guildId);
  if (!q) return;
  if (q.currentTrack) {
    if (q.loopMode === 'track') {
      q.queue.unshift(q.currentTrack);
    } else if (q.loopMode === 'queue') {
      q.queue.push(q.currentTrack);
      q.history.unshift(q.currentTrack);
    } else {
      q.history.unshift(q.currentTrack);
      if (q.history.length > 25) q.history.pop();
    }
  }
  playNextTrack(guildId);
}

async function playNextTrack(guildId) {
  const q = musicQueues.get(guildId);
  if (!q) return;
  if (q.queue.length === 0) {
    q.isPlaying = false;
    q.currentTrack = null;
    return;
  }
  const track = q.queue.shift();
  q.currentTrack = track;
  q.isPlaying = true;
  q.isPaused = false;

  await ensurePlayDlReady();
  if (!playdl || !voiceLib) return;

  try {
    let stream = null;
    if (track.url && playdl.is_expired(track.url)) {
      await playdl.refreshToken();
    }
    const streamInfo = await playdl.stream(track.url || track.title).catch(() => null);
    if (streamInfo) stream = streamInfo.stream;

    if (!stream) {
      handleTrackEnded(guildId);
      return;
    }

    const resource = voiceLib.createAudioResource(stream, {
      inputType: streamInfo.type,
      inlineVolume: true,
    });
    if (resource.volume) resource.volume.setVolume(q.volume / 100);

    q.player.play(resource);
  } catch (err) {
    console.error('Playback error:', err.message);
    handleTrackEnded(guildId);
  }
}

async function searchBestTrack(query, user) {
  await ensurePlayDlReady();
  if (query.includes('spotify.com')) {
    const spTracks = await resolveSpotifyMetadata(query);
    if (spTracks && spTracks.length > 0) {
      return {
        isPlaylist: spTracks.length > 1,
        tracks: spTracks.map(t => ({
          title: t.title,
          artist: t.artist,
          url: t.query,
          thumbnail: t.thumbnail,
          requestedBy: user.id,
        }))
      };
    }
  }

  if (playdl) {
    try {
      const searched = await playdl.search(query, { limit: 1 });
      if (searched && searched.length > 0) {
        const item = searched[0];
        return {
          isPlaylist: false,
          tracks: [{
            title: item.title,
            artist: item.channel?.name || 'Artist',
            url: item.url,
            thumbnail: item.thumbnails?.[0]?.url,
            requestedBy: user.id,
          }]
        };
      }
    } catch (_) {}
  }

  return {
    isPlaylist: false,
    tracks: [{
      title: query,
      artist: 'Track',
      url: query,
      thumbnail: null,
      requestedBy: user.id,
    }]
  };
}

async function addMusicToQueue(guild, vc, user, textChannel, query) {
  if (!voiceLib) return { success: false, message: 'Voice library is not initialized.' };
  const q = getQ(guild.id);
  q.textChannel = textChannel;

  if (!q.connection) {
    try {
      q.connection = voiceLib.joinVoiceChannel({
        channelId: vc.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
      });
    } catch (err) {
      return { success: false, message: 'Could not connect to voice channel: ' + err.message };
    }
  }

  if (!q.player) {
    q.player = voiceLib.createAudioPlayer();
    q.connection.subscribe(q.player);
    q.player.on(voiceLib.AudioPlayerStatus.Idle, () => handleTrackEnded(guild.id));
    q.player.on('error', err => {
      console.error('Audio Player Error:', err.message);
      handleTrackEnded(guild.id);
    });
  }

  const result = await searchBestTrack(query, user);
  if (!result || !result.tracks || result.tracks.length === 0) {
    return { success: false, message: 'No matching tracks found.' };
  }

  for (const t of result.tracks) q.queue.push(t);
  if (!q.isPlaying) playNextTrack(guild.id);

  return {
    success: true,
    isPlaylist: result.isPlaylist,
    count: result.tracks.length,
    firstTrack: result.tracks[0],
    position: q.queue.length - result.tracks.length + 1,
  };
}

const RADIO_STREAMS = {
  lofi:   { name: 'Lofi Chill 24/7',   url: 'https://stream.zeno.fm/f3wvbbqmdg8uv' },
  gaming: { name: 'Gaming Beats 24/7', url: 'https://stream.zeno.fm/0r0xa792kwzuv' },
  pop:    { name: 'Pop Hits 24/7',     url: 'https://stream.zeno.fm/z52x2szx0h8uv' },
  chill:  { name: 'Chill Hop 24/7',    url: 'https://stream.zeno.fm/f3wvbbqmdg8uv' },
};

// ── Invite Tracking Cache ──
const invCache = new Map();
async function cacheInvites(guild) {
  try {
    if (!guild?.members?.me?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) return;
    const inv = await guild.invites.fetch().catch(() => null);
    if (!inv) return;
    const m = new Map();
    inv.forEach(i => m.set(i.code, i.uses || 0));
    invCache.set(guild.id, m);
  } catch (_) {}
}

async function findInviter(guild) {
  try {
    if (!guild?.members?.me?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) return null;
    const cached = invCache.get(guild.id) || new Map();
    const ni = await guild.invites.fetch().catch(() => null);
    if (!ni) return null;
    let used = null;
    ni.forEach(i => {
      if (i.uses > (cached.get(i.code) || 0) && !used) used = i;
    });
    const upd = new Map();
    ni.forEach(i => upd.set(i.code, i.uses || 0));
    invCache.set(guild.id, upd);

    if (used && used.inviter) {
      let total = 0;
      ni.forEach(i => {
        if (i.inviter && i.inviter.id === used.inviter.id) total += (i.uses || 0);
      });
      return { inviterId: used.inviter.id, inviterTag: used.inviter.tag, uses: total };
    }
  } catch (_) {}
  return null;
}

// ── Initialize Bot Client ──
async function startBot() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildInvites,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildModeration,
    ],
    partials: [Partials.GuildMember, Partials.User, Partials.Channel, Partials.Message],
  });

  client.on('error', err => console.error(redactSecrets(`[Discord Client Error]: ${err?.message || err}`)));
  client.on('warn',  info => console.warn(redactSecrets(`[Discord Client Warn]: ${info}`)));

  client.once('clientReady', async () => {
    console.log('=======================================================');
    console.log('THOR APEX All-in-One Bot is ONLINE!');
    console.log('Logged in as: ' + client.user.tag);
    console.log('Connected Servers: ' + client.guilds.cache.size);
    client.guilds.cache.forEach(g => console.log(`  • ${g.name} (${g.id})`));
    console.log('=======================================================');

    // Cache invites for each guild
    for (const g of client.guilds.cache.values()) {
      await cacheInvites(g);
    }

    // Register slash commands globally (and clean up old guild duplicate commands)
    const token = process.env.DISCORD_TOKEN;
    if (token) {
      const rest = new REST({ version: '10' }).setToken(token);
      const cmds = buildApplicationCommands();
      try {
        for (const guild of client.guilds.cache.values()) {
          await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: [] }).catch(() => {});
        }
        await rest.put(Routes.applicationCommands(client.user.id), { body: cmds });
        console.log(`✅ Global Application Commands registered successfully (${cmds.length} commands).`);
      } catch (err) {
        console.error('Command registration error:', err.message);
      }
    }
  });

  client.on('guildCreate', async (guild) => {
    console.log(`Joined new guild: ${guild.name} (${guild.id})`);
    await cacheInvites(guild);
  });

  // ── Member Join Event (AutoMod Alt Check, Anti-Nuke Bot Add, Inviter, Welcome Card) ──
  client.on('guildMemberAdd', async (member) => {
    try {
      if (member.partial) member = await member.fetch().catch(() => null);
      if (!member) return;
      const guild = member.guild;

      // Anti-Nuke: Unauthorized Bot Add Check
      if (member.user.bot) {
        await handleAntiNukeEvent(guild, AuditLogEvent.BotAdd, 'botAdd', `Bot Added (${member.user.tag})`, member.id);
        const embed = new EmbedBuilder()
          .setColor('#5865F2')
          .setTitle('🤖 Bot Joined Server')
          .setDescription(`**Bot:** ${member.user.tag} (\`${member.id}\`)\n**Timestamp:** <t:${Math.floor(Date.now() / 1000)}:R>`)
          .setTimestamp();
        await logBot(guild, embed);
        return;
      }

      // AutoMod Alt & Join-Raid Check
      const amCheck = await processMemberJoin(member);
      if (amCheck?.intercepted) return;

      // Server Lockdown Check
      const config = getGuildConfig(guild.id, guild.name);
      if (config.security?.lockdown) {
        if (member.kickable) await member.kick('Server is currently under lockdown.').catch(() => {});
        return;
      }

      // Track Inviter
      const inviterData = await findInviter(guild);

      // Send Reference Welcome Card
      await handleMemberJoin(member, inviterData);

      // Auto-Role Assignment
      if (config.welcome?.autoRoleId) {
        const role = guild.roles.cache.get(config.welcome.autoRoleId);
        if (role) await member.roles.add(role, 'Auto-Role on Join').catch(() => {});
      }

      // Log to #member-logs
      const joinLog = new EmbedBuilder()
        .setColor('#57F287')
        .setTitle('📥 Member Joined Server')
        .setDescription(`**User:** ${member.user.tag} (<@${member.id}>)\n**Account Created:** <t:${Math.floor(member.user.createdTimestamp / 1000)}:R>\n**Total Members:** **${guild.memberCount}**`)
        .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
        .setTimestamp();
      await logMember(guild, joinLog);
    } catch (err) {
      console.error('guildMemberAdd handler error:', err.message);
    }
  });

  // ── Member Leave Event (Safe Partial Handling, Kick Detection, Goodbye Message) ──
  client.on('guildMemberRemove', async (member) => {
    try {
      const guild = member.guild;
      const user = member.user || member;

      // Audit Log Check for Kick or Ban
      try {
        const logs = await guild.fetchAuditLogs({ limit: 1 }).catch(() => null);
        const entry = logs?.entries.first();
        if (entry && Date.now() - entry.createdTimestamp < 5000 && entry.target?.id === user.id) {
          if (entry.action === AuditLogEvent.MemberKick) {
            await handleAntiNukeEvent(guild, AuditLogEvent.MemberKick, 'memberKick', `Member Kicked (${user.tag || user.id})`, user.id);
            const kickEmbed = new EmbedBuilder()
              .setColor('#FF6600')
              .setTitle('👢 Member Kicked')
              .setDescription(`**User:** ${user.tag || user.id} (\`${user.id}\`)\n**Moderator:** ${entry.executor?.tag || 'Unknown'} (<@${entry.executor?.id}>)\n**Reason:** ${entry.reason || 'None provided'}`)
              .setTimestamp();
            await logModeration(guild, kickEmbed);
          }
        }
      } catch (_) {}

      // Send Goodbye Message (handles partial gracefully)
      await handleMemberLeave(member);

      // Log to #member-logs
      const leaveLog = new EmbedBuilder()
        .setColor('#ED4245')
        .setTitle('📤 Member Left Server')
        .setDescription(`**User:** ${user.tag || user.id} (<@${user.id}>)\n**Remaining Members:** **${guild.memberCount}**`)
        .setThumbnail(user.displayAvatarURL ? user.displayAvatarURL({ size: 256 }) : null)
        .setTimestamp();
      await logMember(guild, leaveLog);
    } catch (err) {
      console.error('guildMemberRemove handler error:', err.message);
    }
  });

  // ── Message Create Event (AutoMod, Prefix Commands) ──
  client.on('messageCreate', async (message) => {
    if (!message || message.author?.bot || !message.guild) return;

    // Evaluate AutoMod filters
    await processMessage(message);

    // Legacy prefix commands support (!play, !stop, !warn, etc.)
    const content = message.content.trim();
    if (!content.startsWith('!')) return;
    const args = content.slice(1).trim().split(/ +/);
    const cmd  = args.shift().toLowerCase();

    if (cmd === 'ping') return message.reply(`🏓 Pong! Heartbeat: **${Math.round(client.ws.ping)}ms**`);
    if (cmd === 'testwelcome') return message.reply(buildWelcomeMessage(message.member, message.guild));
    if (cmd === 'play' || cmd === 'p') {
      const q = args.join(' ');
      const vc = message.member?.voice?.channel;
      if (!vc) return message.reply('Join a Voice Channel first!');
      if (!q) return message.reply('Provide a song name or link!');
      const res = await addMusicToQueue(message.guild, vc, message.author, message.channel, q);
      return message.reply(res.success ? `▶️ Added: **${res.firstTrack.title}**` : `❌ ${res.message}`);
    }
    if (cmd === 'stop') {
      stopMusicSession(message.guild.id);
      return message.reply('⏹️ Music stopped and queue cleared.');
    }
  });

  // ── Message Delete & Edit Logging ──
  client.on('messageDelete', async (message) => {
    try {
      if (!message.guild || message.author?.bot) return;
      const embed = new EmbedBuilder()
        .setColor('#ED4245')
        .setTitle('🗑️ Message Deleted')
        .setDescription(`**Author:** ${message.author ? `${message.author.tag} (<@${message.author.id}>)` : 'Unknown'}\n**Channel:** <#${message.channel.id}>\n**Content:**\n${message.content || '*[Attachment / Embed]*'}`)
        .setTimestamp();
      await logMessage(message.guild, embed);
    } catch (_) {}
  });

  client.on('messageUpdate', async (oldMessage, newMessage) => {
    try {
      if (!newMessage.guild || newMessage.author?.bot) return;
      if (oldMessage.content === newMessage.content) return;
      // Re-evaluate AutoMod on edited content
      await processMessage(newMessage);

      const embed = new EmbedBuilder()
        .setColor('#FEE75C')
        .setTitle('✏️ Message Edited')
        .setDescription(`**Author:** ${newMessage.author.tag} (<@${newMessage.author.id}>)\n**Channel:** <#${newMessage.channel.id}>\n**Before:** ${oldMessage.content || '*None*'}\n**After:** ${newMessage.content || '*None*'}`)
        .setTimestamp();
      await logMessage(newMessage.guild, embed);
    } catch (_) {}
  });

  // ── Channel Create, Delete, Update (Anti-Nuke Intercepts) ──
  client.on('channelCreate', async (channel) => {
    if (!channel.guild) return;
    await handleAntiNukeEvent(channel.guild, AuditLogEvent.ChannelCreate, 'channelCreate', `Channel Created (#${channel.name})`, channel.id);
    const embed = new EmbedBuilder()
      .setColor('#57F287')
      .setTitle('📁 Channel Created')
      .setDescription(`**Channel:** <#${channel.id}> (\`${channel.name}\`)\n**ID:** \`${channel.id}\``)
      .setTimestamp();
    await logChannel(channel.guild, embed);
  });

  client.on('channelDelete', async (channel) => {
    if (!channel.guild) return;
    await handleAntiNukeEvent(channel.guild, AuditLogEvent.ChannelDelete, 'channelDelete', `Channel Deleted (#${channel.name})`, channel.id);
    const embed = new EmbedBuilder()
      .setColor('#ED4245')
      .setTitle('🗑️ Channel Deleted')
      .setDescription(`**Channel Name:** #${channel.name}\n**ID:** \`${channel.id}\``)
      .setTimestamp();
    await logChannel(channel.guild, embed);
  });

  client.on('channelUpdate', async (oldChannel, newChannel) => {
    if (!newChannel.guild) return;
    await handleAntiNukeEvent(newChannel.guild, AuditLogEvent.ChannelUpdate, 'channelUpdate', `Channel Modified (#${newChannel.name})`, newChannel.id);
    const embed = new EmbedBuilder()
      .setColor('#FEE75C')
      .setTitle('⚙️ Channel Updated')
      .setDescription(`**Channel:** <#${newChannel.id}>\n**Old Name:** ${oldChannel.name}\n**New Name:** ${newChannel.name}`)
      .setTimestamp();
    await logChannel(newChannel.guild, embed);
  });

  // ── Role Create, Delete, Update (Dangerous Perm Escalation) ──
  client.on('roleCreate', async (role) => {
    if (!role.guild) return;
    await handleAntiNukeEvent(role.guild, AuditLogEvent.RoleCreate, 'roleCreate', `Role Created (${role.name})`, role.id);
    const embed = new EmbedBuilder()
      .setColor('#57F287')
      .setTitle('🛡️ Role Created')
      .setDescription(`**Role:** <@&${role.id}> (\`${role.name}\`)\n**ID:** \`${role.id}\``)
      .setTimestamp();
    await logRole(role.guild, embed);
  });

  client.on('roleDelete', async (role) => {
    if (!role.guild) return;
    await handleAntiNukeEvent(role.guild, AuditLogEvent.RoleDelete, 'roleDelete', `Role Deleted (${role.name})`, role.id);
    const embed = new EmbedBuilder()
      .setColor('#ED4245')
      .setTitle('🗑️ Role Deleted')
      .setDescription(`**Role Name:** ${role.name}\n**ID:** \`${role.id}\``)
      .setTimestamp();
    await logRole(role.guild, embed);
  });

  client.on('roleUpdate', async (oldRole, newRole) => {
    if (!newRole.guild) return;
    const dangerousFlags = [
      PermissionsBitField.Flags.Administrator,
      PermissionsBitField.Flags.ManageGuild,
      PermissionsBitField.Flags.ManageRoles,
      PermissionsBitField.Flags.ManageChannels,
      PermissionsBitField.Flags.BanMembers,
      PermissionsBitField.Flags.KickMembers,
      PermissionsBitField.Flags.ManageWebhooks,
      PermissionsBitField.Flags.MentionEveryone,
    ];
    const gained = dangerousFlags.some(f => !oldRole.permissions.has(f) && newRole.permissions.has(f));
    if (gained) {
      await handleAntiNukeEvent(newRole.guild, AuditLogEvent.RoleUpdate, 'dangerousPermGrant', `Dangerous Permissions Granted to Role (${newRole.name})`, newRole.id);
    }
    const embed = new EmbedBuilder()
      .setColor('#FEE75C')
      .setTitle('🛠️ Role Updated')
      .setDescription(`**Role:** <@&${newRole.id}> (\`${newRole.name}\`)${gained ? '\n⚠️ **Warning: Dangerous Administrative Permissions were added to this role!**' : ''}`)
      .setTimestamp();
    await logRole(newRole.guild, embed);
  });

  // ── Ban Add & Remove ──
  client.on('guildBanAdd', async (ban) => {
    try {
      await handleAntiNukeEvent(ban.guild, AuditLogEvent.MemberBanAdd, 'memberBan', `Member Banned (${ban.user.tag || ban.user.id})`, ban.user.id);
      const embed = new EmbedBuilder()
        .setColor('#ED4245')
        .setTitle('⛔ Member Banned')
        .setDescription(`**User:** ${ban.user.tag || ban.user.id} (\`${ban.user.id}\`)`)
        .setTimestamp();
      await logModeration(ban.guild, embed);
    } catch (_) {}
  });

  client.on('guildBanRemove', async (ban) => {
    try {
      const embed = new EmbedBuilder()
        .setColor('#57F287')
        .setTitle('🔓 Member Unbanned')
        .setDescription(`**User:** ${ban.user.tag || ban.user.id} (\`${ban.user.id}\`)`)
        .setTimestamp();
      await logModeration(ban.guild, embed);
    } catch (_) {}
  });

  // ── Webhooks & Server Updates ──
  client.on('webhookUpdate', async (channel) => {
    if (!channel.guild) return;
    await handleAntiNukeEvent(channel.guild, AuditLogEvent.WebhookCreate, 'webhookCreate', `Webhook Created/Updated in #${channel.name}`);
    const embed = new EmbedBuilder()
      .setColor('#FEE75C')
      .setTitle('🔗 Webhook Modified')
      .setDescription(`**Channel:** <#${channel.id}>`)
      .setTimestamp();
    await logWebhook(channel.guild, embed);
  });

  client.on('guildUpdate', async (oldGuild, newGuild) => {
    await handleAntiNukeEvent(newGuild, AuditLogEvent.GuildUpdate, 'guildUpdate', 'Server Settings Modified');
    const embed = new EmbedBuilder()
      .setColor('#FEE75C')
      .setTitle('🏰 Server Settings Updated')
      .setDescription(`**Server Name:** ${newGuild.name}`)
      .setTimestamp();
    await logServerSettings(newGuild, embed);
  });

  // ── Voice Activity Logs ──
  client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
      const member = newState.member || oldState.member;
      if (!member || member.user.bot) return;
      const guild = newState.guild || oldState.guild;

      if (!oldState.channelId && newState.channelId) {
        const embed = new EmbedBuilder()
          .setColor('#57F287')
          .setTitle('🔊 Member Joined Voice')
          .setDescription(`**User:** ${member.user.tag} (<@${member.id}>)\n**Channel:** <#${newState.channelId}>`)
          .setTimestamp();
        await logVoice(guild, embed);
      } else if (oldState.channelId && !newState.channelId) {
        const embed = new EmbedBuilder()
          .setColor('#ED4245')
          .setTitle('🔇 Member Left Voice')
          .setDescription(`**User:** ${member.user.tag} (<@${member.id}>)\n**Channel:** <#${oldState.channelId}>`)
          .setTimestamp();
        await logVoice(guild, embed);
      } else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
        const embed = new EmbedBuilder()
          .setColor('#FEE75C')
          .setTitle('🔁 Voice Channel Switch')
          .setDescription(`**User:** ${member.user.tag} (<@${member.id}>)\n**From:** <#${oldState.channelId}>\n**To:** <#${newState.channelId}>`)
          .setTimestamp();
        await logVoice(guild, embed);
      }
    } catch (_) {}
  });

  // ── Invite Event Tracking ──
  client.on('inviteCreate', async (inv) => {
    await cacheInvites(inv.guild);
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('✉️ Invite Created')
      .setDescription(`**Code:** \`${inv.code}\`\n**Creator:** ${inv.inviter ? `<@${inv.inviter.id}>` : 'Unknown'}`)
      .setTimestamp();
    await logInvite(inv.guild, embed);
  });

  client.on('inviteDelete', async (inv) => {
    await cacheInvites(inv.guild);
    const embed = new EmbedBuilder()
      .setColor('#ED4245')
      .setTitle('🗑️ Invite Deleted')
      .setDescription(`**Code:** \`${inv.code}\``)
      .setTimestamp();
    await logInvite(inv.guild, embed);
  });

  // ── Comprehensive Interaction Dispatcher ──
  client.on('interactionCreate', async (interaction) => {
    try {
      // 1. Music Button Handlers
      if (interaction.isButton()) {
        const id = interaction.customId;
        if (id.startsWith('btn_m_')) {
          const vc = interaction.member?.voice?.channel;
          if (!vc) return safeReply(interaction, 'You must be in a Voice Channel to use music controls!');
          const q = getQ(interaction.guildId);

          if (id === 'btn_m_play_pause') {
            if (q.player) {
              if (q.isPaused) { q.player.unpause(); q.isPaused = false; await safeReply(interaction, '▶️ Playback resumed.'); }
              else { q.player.pause(); q.isPaused = true; await safeReply(interaction, '⏸️ Playback paused.'); }
            } else { await safeReply(interaction, 'No active music player found.'); }
            return;
          }
          if (id === 'btn_m_skip') {
            if (q.currentTrack) {
              await safeReply(interaction, `⏭️ Skipped: **${q.currentTrack.title}**`);
              handleTrackEnded(interaction.guildId);
            } else { await safeReply(interaction, 'Queue is empty!'); }
            return;
          }
          if (id === 'btn_m_stop') {
            stopMusicSession(interaction.guildId);
            await safeReply(interaction, '⏹️ Music stopped and session cleared.');
            return;
          }
        }
      }

      // 2. Chat Input Slash Commands
      if (!interaction.isChatInputCommand()) return;
      const { commandName, guild, member, user } = interaction;
      if (!guild) return safeReply(interaction, 'Commands can only be used inside a Discord server.');

      const config = getGuildConfig(guild.id, guild.name);

      // ── GENERAL MODERATION COMMANDS ──
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

      // ── SECURITY & ANTI-NUKE COMMANDS ──
      if (commandName === 'security') {
        const sub = interaction.options.getSubcommand(false) || 'status';
        if (sub === 'status') {
          const s = config.security || {};
          const embed = new EmbedBuilder()
            .setColor(s.lockdown ? '#ED4245' : '#57F287')
            .setTitle(`🛡️ Security Engine Status — ${guild.name}`)
            .setDescription(`**Anti-Nuke Protection:** ${s.antiNuke ? '🟢 **ACTIVE**' : '🔴 **DISABLED**'}\n**Enforcement Action:** \`${s.action || 'strip_and_ban'}\`\n**Emergency Lockdown:** ${s.lockdown ? '🚨 **ENGAGED**' : '🟢 **NORMAL**'}\n**Trusted Users:** ${s.trustedUsers?.length || 0}\n**Trusted Roles:** ${s.trustedRoles?.length || 0}\n**Recent Incidents Intercepted:** ${config.incidents?.length || 0}`)
            .setFooter({ text: 'Sub-second event detection engine active' })
            .setTimestamp();
          return safeReply(interaction, { embeds: [embed] });
        }
        if (sub === 'audit') {
          const me = guild.members.me;
          const auditEmbed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle(`🔍 Security Audit — ${guild.name}`)
            .setDescription(`**Bot Highest Role Position:** ${me?.roles?.highest?.position}\n**Server Owner:** <@${guild.ownerId}>\n**Has Administrator:** ${me?.permissions?.has(PermissionsBitField.Flags.Administrator) ? '✅ Yes' : '⚠️ No (Admin recommended for instant ban)'}\n**Has View Audit Log:** ${me?.permissions?.has(PermissionsBitField.Flags.ViewAuditLog) ? '✅ Yes' : '❌ Missing'}\n**Has Ban Members:** ${me?.permissions?.has(PermissionsBitField.Flags.BanMembers) ? '✅ Yes' : '❌ Missing'}\n**Has Manage Roles:** ${me?.permissions?.has(PermissionsBitField.Flags.ManageRoles) ? '✅ Yes' : '❌ Missing'}`)
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
          for (const [, ch] of guild.channels.cache) {
            if (ch.isTextBased()) await ch.permissionOverwrites.create(guild.roles.everyone, { SendMessages: false }).catch(() => {});
          }
          return safeReply(interaction, '🚨 **SERVER LOCKDOWN ENGAGED!** `@everyone` cannot send messages.');
        }
        if (sub === 'unlock') {
          config.security.lockdown = false; saveGuildConfig(guild.id, config);
          for (const [, ch] of guild.channels.cache) {
            if (ch.isTextBased()) await ch.permissionOverwrites.create(guild.roles.everyone, { SendMessages: null }).catch(() => {});
          }
          return safeReply(interaction, '🟢 **Lockdown lifted.** Server channels restored.');
        }
      }

      // ── AUTOMOD COMMANDS ──
      if (commandName === 'automod') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'enable') {
          config.automod.enabled = true; saveGuildConfig(guild.id, config);
          return safeReply(interaction, '🤖 **AutoMod Engine ENABLED.** Spam, links, bad words, and caps filters are active.');
        }
        if (sub === 'disable') {
          config.automod.enabled = false; saveGuildConfig(guild.id, config);
          return safeReply(interaction, '⚠️ **AutoMod Engine DISABLED.**');
        }
        if (sub === 'status') {
          const am = config.automod;
          const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle(`🤖 AutoMod Status — ${guild.name}`)
            .setDescription(`• **Engine:** ${am.enabled ? '🟢 Enabled' : '🔴 Disabled'}\n• **Anti-Spam:** ${am.antiSpam?.enabled ? '🟢' : '🔴'}\n• **Duplicate Messages:** ${am.antiDuplicate?.enabled ? '🟢' : '🔴'}\n• **Mention Spam:** ${am.antiMentionSpam?.enabled ? '🟢' : '🔴'}\n• **Anti-Invites:** ${am.antiInvites?.enabled ? '🟢' : '🔴'}\n• **Anti-Links:** ${am.antiLinks?.enabled ? '🟢' : '🔴'}\n• **Word Blacklist:** ${am.wordFilter?.enabled ? '🟢' : '🔴'} (${am.wordFilter?.words?.length || 0} words)\n• **Caps Filter:** ${am.antiCaps?.enabled ? '🟢' : '🔴'}\n• **Emoji Spam:** ${am.antiEmojiSpam?.enabled ? '🟢' : '🔴'}\n• **Alt Detection:** ${am.altDetection?.enabled ? '🟢' : '🔴'} (min ${am.altDetection?.minDays || 7} days)\n• **Anti-Raid:** ${am.antiRaid?.enabled ? '🟢' : '🔴'}`)
            .setTimestamp();
          return safeReply(interaction, { embeds: [embed] });
        }
        if (sub === 'blacklist') {
          const action = interaction.options.getString('action', true);
          const word = interaction.options.getString('word')?.toLowerCase();
          if (!config.automod.wordFilter) config.automod.wordFilter = { enabled: true, words: [] };
          if (action === 'add' && word) {
            if (!config.automod.wordFilter.words.includes(word)) config.automod.wordFilter.words.push(word);
            saveGuildConfig(guild.id, config);
            return safeReply(interaction, `✅ Added \`${word}\` to blacklist.`);
          }
          if (action === 'remove' && word) {
            config.automod.wordFilter.words = config.automod.wordFilter.words.filter(w => w !== word);
            saveGuildConfig(guild.id, config);
            return safeReply(interaction, `❌ Removed \`${word}\` from blacklist.`);
          }
          if (action === 'list') {
            return safeReply(interaction, `📝 **Blacklisted Words:**\n${config.automod.wordFilter.words.join(', ') || 'None'}`);
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
            return safeReply(interaction, '✅ AutoMod whitelist entry added.');
          }
          if (action === 'remove') {
            if (u) config.automod.whitelistUsers = config.automod.whitelistUsers.filter(id => id !== u.id);
            if (r) config.automod.whitelistRoles = config.automod.whitelistRoles.filter(id => id !== r.id);
            if (c) config.automod.ignoredChannels = config.automod.ignoredChannels.filter(id => id !== c.id);
            saveGuildConfig(guild.id, config);
            return safeReply(interaction, '❌ AutoMod whitelist entry removed.');
          }
          if (action === 'list') {
            return safeReply(interaction, `Users: ${config.automod.whitelistUsers.map(id => `<@${id}>`).join(', ') || 'None'}\nRoles: ${config.automod.whitelistRoles.map(id => `<@&${id}>`).join(', ') || 'None'}\nChannels: ${config.automod.ignoredChannels.map(id => `<#${id}>`).join(', ') || 'None'}`);
          }
        }
      }

      // ── LOGGING COMMANDS (14 Channels under SERVER LOGS) ──
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
      }

      // ── WELCOME & GOODBYE COMMANDS ──
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
        if (sub === 'test') {
          const payload = buildGoodbyeMessage(member, guild);
          return interaction.reply({ ...payload, ephemeral: false });
        }
      }

      // Legacy Welcome & Setup Shortcuts
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

      // ── UTILITY COMMANDS ──
      if (commandName === 'ping') {
        const wsPing = Math.round(client.ws.ping);
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
          .setDescription(`**Name:** ${client.user.tag}\n**Version:** 2.0.0 Production Enterprise\n**Total Guilds:** ${client.guilds.cache.size}\n**Total Cached Users:** ${client.users.cache.size}\n**Node.js Runtime:** \`${process.version}\`\n**Platform:** ${os.platform()} (${os.arch()})\n**RAM Usage:** **${memMB} MB**\n**Uptime:** ${formatDuration(Date.now() - startTime)}`)
          .setThumbnail(client.user.displayAvatarURL())
          .setTimestamp();
        return safeReply(interaction, { embeds: [embed] });
      }

      if (commandName === 'serverinfo') {
        const embed = new EmbedBuilder()
          .setColor('#5865F2')
          .setTitle(`🏰 Server Information — ${guild.name}`)
          .setDescription(`**Owner:** <@${guild.ownerId}>\n**Total Members:** **${guild.memberCount}**\n**Channels:** ${guild.channels.cache.size}\n**Roles:** ${guild.roles.cache.size}\n**Created At:** <t:${Math.floor(guild.createdTimestamp / 1000)}:D>`)
          .setThumbnail(guild.iconURL({ size: 256 }))
          .setTimestamp();
        return safeReply(interaction, { embeds: [embed] });
      }

      if (commandName === 'userinfo') {
        const target = interaction.options.getUser('user') || user;
        const targetMember = guild.members.cache.get(target.id);
        const embed = new EmbedBuilder()
          .setColor('#5865F2')
          .setTitle(`User Profile — ${target.tag}`)
          .setDescription(`**Mention:** <@${target.id}>\n**ID:** \`${target.id}\`\n**Created:** <t:${Math.floor(target.createdTimestamp / 1000)}:R>\n**Joined Server:** ${targetMember ? `<t:${Math.floor(targetMember.joinedTimestamp / 1000)}:R>` : 'Unknown'}\n**Roles:** ${targetMember?.roles?.cache?.filter(r => r.id !== guild.roles.everyone.id)?.map(r => `<@&${r.id}>`)?.join(', ') || 'None'}`)
          .setThumbnail(target.displayAvatarURL({ size: 256 }))
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
            { name: '🤖 AutoMod', value: '`/automod enable` `/automod status` `/automod blacklist` `/automod whitelist`' },
            { name: '📋 14 Log Channels', value: '`/logs setup` (Auto-creates 📁 SERVER LOGS & 14 channels)\n`/logs status` `/logs configure` `/logs test`' },
            { name: '🎉 Welcome & Goodbye', value: '`/welcome setup` `/welcome test` `/welcome config`\n`/goodbye setup` `/goodbye test`' },
            { name: '⚖️ Moderation', value: '`/warn` `/warnings` `/clearwarnings` `/timeout` `/untimeout` `/kick` `/ban` `/unban` `/softban` `/purge` `/lock` `/unlock` `/slowmode` `/nick` `/modlogs`' },
            { name: '🎵 Music & 24/7 Radio', value: '`/play` `/pause` `/resume` `/skip` `/stop` `/queue` `/radio`' },
            { name: 'ℹ️ Utility', value: '`/ping` `/uptime` `/botinfo` `/serverinfo` `/userinfo` `/permissions`' }
          )
          .setFooter({ text: 'All commands support role hierarchy validation and multi-server isolation' })
          .setTimestamp();
        return safeReply(interaction, { embeds: [helpEmbed] });
      }

      // ── MUSIC COMMANDS ──
      if (commandName === 'play') {
        const vc = member?.voice?.channel;
        if (!vc) return safeReply(interaction, 'Join a Voice Channel first!');
        await interaction.deferReply();
        const query = interaction.options.getString('song', true);
        const res = await addMusicToQueue(guild, vc, user, interaction.channel, query);
        if (!res.success) return interaction.editReply(`❌ ${res.message}`);
        return interaction.editReply(`▶️ Added **${res.firstTrack.title}** to queue (Position #${res.position}).`);
      }

      if (commandName === 'pause') {
        const q = getQ(guild.id);
        if (!q.player || !q.isPlaying) return safeReply(interaction, 'Nothing is currently playing.');
        q.player.pause(); q.isPaused = true;
        return safeReply(interaction, '⏸️ Music paused.');
      }

      if (commandName === 'resume') {
        const q = getQ(guild.id);
        if (!q.player || !q.isPaused) return safeReply(interaction, 'Music is not paused.');
        q.player.unpause(); q.isPaused = false;
        return safeReply(interaction, '▶️ Music resumed.');
      }

      if (commandName === 'skip') {
        const q = getQ(guild.id);
        if (!q.currentTrack) return safeReply(interaction, 'Queue is empty!');
        const s = q.currentTrack;
        handleTrackEnded(guild.id);
        return safeReply(interaction, `⏭️ Skipped: **${s.title}**`);
      }

      if (commandName === 'stop') {
        stopMusicSession(guild.id);
        return safeReply(interaction, '⏹️ Stopped music playback and left the voice channel.');
      }

      if (commandName === 'queue') {
        const q = getQ(guild.id);
        if (q.queue.length === 0) return safeReply(interaction, 'Music queue is currently empty. Use `/play` to add tracks.');
        const list = q.queue.slice(0, 10).map((t, i) => `${i + 1}. **${t.title}** (By: <@${t.requestedBy}>)`).join('\n');
        return safeReply(interaction, { embeds: [new EmbedBuilder().setColor('#5865F2').setTitle(`Music Queue — ${guild.name}`).setDescription(list).setFooter({ text: `Total: ${q.queue.length} tracks` }).setTimestamp()] });
      }

      if (commandName === 'nowplaying') {
        const q = getQ(guild.id);
        if (!q.currentTrack) return safeReply(interaction, 'Nothing is currently playing.');
        return safeReply(interaction, { embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('▶️ Now Playing').setDescription(`**${q.currentTrack.title}**\nArtist: ${q.currentTrack.artist || 'Unknown'}`).setThumbnail(q.currentTrack.thumbnail || null).setTimestamp()] });
      }

      if (commandName === 'radio') {
        const vc = member?.voice?.channel;
        if (!vc) return safeReply(interaction, 'Join a Voice Channel first!');
        const genre = interaction.options.getString('genre') || 'lofi';
        const sel = RADIO_STREAMS[genre] || RADIO_STREAMS.lofi;
        const q = getQ(guild.id);
        if (voiceLib) {
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

      // ── INVITES COMMANDS ──
      if (commandName === 'myinvites') {
        const inv = await guild.invites.fetch().catch(() => null);
        let total = 0;
        if (inv) inv.forEach(i => { if (i.inviter?.id === user.id) total += (i.uses || 0); });
        return safeReply(interaction, `📩 You have **${total}** total invites in **${guild.name}**.`);
      }

      if (commandName === 'invites') {
        const target = interaction.options.getUser('user') || user;
        const inv = await guild.invites.fetch().catch(() => null);
        let total = 0;
        if (inv) inv.forEach(i => { if (i.inviter?.id === target.id) total += (i.uses || 0); });
        return safeReply(interaction, `📩 **${target.tag}** has **${total}** total invites in **${guild.name}**.`);
      }

      if (commandName === 'invitetop') {
        const inv = await guild.invites.fetch().catch(() => null);
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

    } catch (err) {
      console.error(redactSecrets(`Interaction dispatch error: ${err.message}`));
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: `❌ An unexpected error occurred: ${err.message}`, ephemeral: true });
        } else {
          await interaction.followUp({ content: `❌ An error occurred: ${err.message}`, ephemeral: true });
        }
      } catch (_) {}
    }
  });

  // ── Graceful Shutdown Handler ──
  const shutdown = async (signal) => {
    console.log(`\nReceived ${signal}. Shutting down gracefully...`);
    for (const [gId] of musicQueues) {
      stopMusicSession(gId);
    }
    healthServer.close(() => console.log('Health check server closed.'));
    try {
      client.destroy();
      console.log('Discord client connection closed.');
    } catch (_) {}
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // ── Bot Login ──
  const TOKEN = process.env.DISCORD_TOKEN;
  if (!TOKEN || TOKEN === 'your_bot_token_here') {
    console.error('❌ DISCORD_TOKEN is missing in .env! Please provide a valid bot token.');
    return;
  }

  client.login(TOKEN).catch(err => {
    if (err.message.includes('disallowed intents') || err.message.includes('Privileged intent')) {
      console.error('\n🚨 PRIVILEGED INTENTS ERROR!');
      console.error('Please enable SERVER MEMBERS INTENT and MESSAGE CONTENT INTENT in the Discord Developer Portal:');
      console.error('https://discord.com/developers/applications -> Your Bot -> Bot -> Privileged Gateway Intents\n');
    } else {
      console.error('Login error:', redactSecrets(err.message));
    }
  });
}

startBot();
