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
  logDrag,
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
const { dispatchCommand } = require('./src/commands/commandDispatcher');
const { redactSecrets, safeReply, isHex, formatDuration } = require('./src/utils/helpers');
const {
  processRaidJoin, releaseAllQuarantine, releaseMember, getQuarantinedCount,
} = require('./src/security/antiRaid');
const { handleMentionNotification } = require('./src/notifications/mentionNotifier');

// Setup FFMPEG static if present & verify Linux permissions
try {
  const ff = require('ffmpeg-static');
  if (ff) {
    process.env.FFMPEG_PATH = ff;
    if (process.platform !== 'win32') {
      try {
        const fs = require('fs');
        fs.chmodSync(ff, 0o755);
      } catch (_) {}
    }
  }
} catch (_) {}

// Diagnostic voice dependency report
try {
  const { generateDependencyReport } = require('@discordjs/voice');
  console.log('🎙️ [THOR-VOICE] Dependency Report:\n' + generateDependencyReport());
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

// ── New musicService (multi-guild isolated, Rythm-style) ──
let musicService = null;
try { musicService = require('./src/music/musicService'); } catch (e) { console.log('musicService:', e.message); }

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

  // ── Voice Gateway Packet Forwarder & Safe Diagnostics ──
  // Ensures VOICE_SERVER_UPDATE and VOICE_STATE_UPDATE packets are always dispatched
  // to client.voice adapters even if member caching lags, preventing Signalling stalls.
  client.on('raw', (packet) => {
    if (!packet || !packet.t) return;
    if (packet.t === 'VOICE_SERVER_UPDATE' && packet.d) {
      if (client.voice && typeof client.voice.onVoiceServer === 'function') {
        try { client.voice.onVoiceServer(packet.d); } catch (_) {}
      }
      if (musicService && typeof musicService.getSession === 'function') {
        const session = musicService.getSession(packet.d.guild_id);
        if (session) {
          session.receivedServerUpdate = true;
          session.voiceGatewayEndpoint = packet.d.endpoint || null;
        }
      }
    } else if (packet.t === 'VOICE_STATE_UPDATE' && packet.d && packet.d.user_id === client.user?.id) {
      if (client.voice && typeof client.voice.onVoiceStateUpdate === 'function') {
        try { client.voice.onVoiceStateUpdate(packet.d); } catch (_) {}
      }
      if (musicService && typeof musicService.getSession === 'function') {
        const session = musicService.getSession(packet.d.guild_id);
        if (session) {
          session.receivedStateUpdate = true;
          session.voiceGatewaySessionId = packet.d.session_id || null;
        }
      }
    }
  });

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

    // Register application slash commands globally (and clean up any stale guild duplicate commands)
    const token = process.env.DISCORD_TOKEN;
    if (token) {
      const rest = new REST({ version: '10' }).setToken(token);
      const cmds = buildApplicationCommands();
      try {
        console.log(`📡 Registering ${cmds.length} application commands globally (Discord limit: 100)...`);

        // Clean up stale guild-scoped commands across all connected guilds to prevent duplicates
        for (const g of client.guilds.cache.values()) {
          try {
            await rest.put(Routes.applicationGuildCommands(client.user.id, g.id), { body: [] });
          } catch (_) {}
        }

        const registered = await rest.put(Routes.applicationCommands(client.user.id), { body: cmds });
        console.log(`✅ Successfully registered ${registered?.length || cmds.length} global application commands across all ${client.guilds.cache.size} connected servers.`);
      } catch (err) {
        console.error(`❌ Command registration error (${cmds.length} commands attempted):`, err.message);
        if (err.rawError) {
          console.error('Detailed Discord API response:', JSON.stringify(err.rawError));
        }
      }
    }

    // ── Restore Persistent 24/7 Voice Connections Across Configured Servers ──
    if (musicService && typeof musicService.init247Connections === 'function') {
      await musicService.init247Connections(client).catch(err => {
        console.error('[24/7 Music] Startup connection restoration error:', err.message);
      });
    }

    // ── Automated Background Tickers ──
    const announcedBirthdays = new Set();
    setInterval(async () => {
      const now = new Date();
      const currentMonth = now.getUTCMonth() + 1;
      const currentDay = now.getUTCDate();
      const todayKey = `${now.getUTCFullYear()}-${currentMonth}-${currentDay}`;

      for (const guild of client.guilds.cache.values()) {
        const conf = getGuildConfig(guild.id, guild.name);
        if (!conf.birthdayChannel || !conf.birthdays) continue;
        const ch = guild.channels.cache.get(conf.birthdayChannel);
        if (!ch || typeof ch.send !== 'function') continue;

        for (const [userId, bday] of Object.entries(conf.birthdays)) {
          if (bday.month === currentMonth && bday.day === currentDay) {
            const announceId = `${guild.id}-${userId}-${todayKey}`;
            if (!announcedBirthdays.has(announceId)) {
              announcedBirthdays.add(announceId);
              await ch.send({
                content: `🎉🎂 **Happy Birthday <@${userId}>!** 🎈 Everyone in **${guild.name}** wishes you an amazing day filled with joy! 🥳✨`
              }).catch(() => {});
            }
          }
        }
      }
    }, 60 * 60 * 1000); // Check hourly
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

      // Smart Anti-Raid Mass Join Quarantiner (Velocity-based wave detection)
      const raidCheck = await processRaidJoin(member);
      if (raidCheck?.intercepted) return;

      // AutoMod Alt & Join-Raid Check (legacy alt detector)
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
            await handleAntiNukeEvent(guild, AuditLogEvent.MemberKick, 'memberKick', `Member Kicked (${user.tag || user.id})`, user.id, entry.executor);
            if (entry.executor && !entry.executor.bot) {
              try {
                const { handleModerationAction, MOD_ACTION_KEYS } = require('./src/security/antiMod');
                await handleModerationAction(guild, entry.executor, MOD_ACTION_KEYS.KICK, 'Kick', user.tag || user.id);
              } catch (_) {}
            }
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

  // ── Member Update Event (Role Escalation & Anti-Mod Abuse Detection) ──
  client.on('guildMemberUpdate', async (oldMember, newMember) => {
    try {
      if (!newMember.guild) return;
      const guild = newMember.guild;

      // 1. Detect timeout addition (Anti-Mod Mass Timeout check)
      const timedOut = (!oldMember.isCommunicationDisabled || !oldMember.isCommunicationDisabled()) && (newMember.isCommunicationDisabled && newMember.isCommunicationDisabled());
      if (timedOut) {
        const { handleModerationAction, MOD_ACTION_KEYS } = require('./src/security/antiMod');
        const { resolveAuditActorRobust } = require('./src/security/securityEngine');
        const modActor = await resolveAuditActorRobust(guild, AuditLogEvent.MemberUpdate, newMember.id);
        if (modActor) {
          await handleModerationAction(guild, modActor, MOD_ACTION_KEYS.TIMEOUT, 'Timeout', `<@${newMember.id}>`);
        }
      }

      // 2. Detect role additions
      const addedRoles = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id));
      if (addedRoles.size > 0) {
        const dangerousFlags = [
          PermissionsBitField.Flags.Administrator,
          PermissionsBitField.Flags.ManageGuild,
          PermissionsBitField.Flags.ManageRoles,
          PermissionsBitField.Flags.ManageChannels,
          PermissionsBitField.Flags.BanMembers,
        ];

        const hasDangerousRole = addedRoles.some(r => dangerousFlags.some(f => r.permissions?.has(f)));
        if (hasDangerousRole) {
          // Check audit log for role grant actor
          await handleAntiNukeEvent(guild, AuditLogEvent.MemberRoleUpdate, 'dangerousPermGrant', `Dangerous Administrative Role Assigned to (${newMember.user.tag})`, newMember.id);
          const { handleModerationAction, MOD_ACTION_KEYS } = require('./src/security/antiMod');
          const { resolveAuditActorRobust } = require('./src/security/securityEngine');
          const modActor = await resolveAuditActorRobust(guild, AuditLogEvent.MemberRoleUpdate, newMember.id);
          if (modActor) {
            await handleModerationAction(guild, modActor, MOD_ACTION_KEYS.ROLE_GRANT, 'Dangerous Role Grant', `<@${newMember.id}>`);
          }
        }
      }
    } catch (_) {}
  });

  // ── Message Create Event (AutoMod, Prefix Commands) ──
  client.on('messageCreate', async (message) => {
    if (!message || message.author?.bot || !message.guild) return;

    // Evaluate AutoMod filters
    await processMessage(message);

    // ── Member Mention Notification DM ──
    try {
      await handleMentionNotification(message, client);
    } catch (_) {}

    // ── AFK System Interceptor ──
    const guildConfig = getGuildConfig(message.guild.id, message.guild.name);
    if (guildConfig.afk && guildConfig.afk[message.author.id]) {
      delete guildConfig.afk[message.author.id];
      saveGuildConfig(message.guild.id, guildConfig);
      await message.reply(`👋 Welcome back <@${message.author.id}>! I've removed your AFK status.`).catch(() => {});
    }

    if (message.mentions?.users?.size > 0 && guildConfig.afk) {
      for (const [uId] of message.mentions.users) {
        if (guildConfig.afk[uId] && uId !== message.author.id) {
          const rec = guildConfig.afk[uId];
          const timeAgo = formatDuration(Math.floor((Date.now() - rec.timestamp) / 1000));
          await message.reply(`💤 <@${uId}> is currently AFK: **${rec.message}** (${timeAgo} ago)`).catch(() => {});
          break;
        }
      }
    }

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
      try {
        const { resolveAuditActorRobust } = require('./src/security/securityEngine');
        const { handleModerationAction, MOD_ACTION_KEYS } = require('./src/security/antiMod');
        const modActor = await resolveAuditActorRobust(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
        if (modActor && !modActor.bot) {
          await handleModerationAction(ban.guild, modActor, MOD_ACTION_KEYS.BAN, 'Ban', ban.user?.tag || ban.user?.id);
        }
      } catch (_) {}
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
      try {
        const { resolveAuditActorRobust } = require('./src/security/securityEngine');
        const { handleModerationAction, MOD_ACTION_KEYS } = require('./src/security/antiMod');
        const modActor = await resolveAuditActorRobust(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id);
        if (modActor && !modActor.bot) {
          await handleModerationAction(ban.guild, modActor, MOD_ACTION_KEYS.UNBAN, 'Unban', ban.user?.tag || ban.user?.id);
        }
      } catch (_) {}
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
        // Voice Channel Switch: Check if member was moved by a moderator (dragged)
        let responsibleMod = null;
        try {
          const me = guild.members.me || (typeof guild.members.fetchMe === 'function' ? await guild.members.fetchMe().catch(() => null) : null);
          if (me?.permissions?.has(PermissionsBitField.Flags.ViewAuditLog)) {
            const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberMove, limit: 1 }).catch(() => null);
            const entry = logs?.entries?.first();
            if (entry && (Date.now() - entry.createdTimestamp) < 3500) {
              // Ensure executor is not the member themselves (self-move doesn't trigger MemberMove audit log in Discord, but be safe)
              if (entry.executor && entry.executor.id !== member.id) {
                // If extra target or count is present, verify matching
                const targetMatch = !entry.target || entry.target.id === member.id;
                if (targetMatch) {
                  responsibleMod = entry.executor;
                }
              }
            }
          }
        } catch (_) {}

        // 1. General Voice Switch Log
        const switchEmbed = new EmbedBuilder()
          .setColor('#FEE75C')
          .setTitle('🔁 Voice Channel Switch')
          .setDescription(`**User:** ${member.user.tag} (<@${member.id}>)\n**From:** <#${oldState.channelId}>\n**To:** <#${newState.channelId}>${responsibleMod ? `\n**Moved By:** ${responsibleMod.tag} (<@${responsibleMod.id}>)` : ''}`)
          .setTimestamp();
        await logVoice(guild, switchEmbed);

        // 2. Dedicated #drag-logs channel dispatch
        const dragEmbed = new EmbedBuilder()
          .setColor(responsibleMod ? '#5865F2' : '#99AAB5')
          .setTitle(responsibleMod ? '🎯 Member Dragged / Moved' : '↔️ Voice Channel Move')
          .setDescription(
            `**Member:** ${member.user.tag} (\`${member.id}\`) [<@${member.id}>]\n` +
            `**Previous Channel:** <#${oldState.channelId}> (\`${oldState.channel?.name || oldState.channelId}\`)\n` +
            `**Destination Channel:** <#${newState.channelId}> (\`${newState.channel?.name || newState.channelId}\`)\n` +
            `**Responsible Moderator:** ${responsibleMod ? `${responsibleMod.tag} (\`${responsibleMod.id}\`) [<@${responsibleMod.id}>]` : '*Self-move or Unverified*'}`
          )
          .setFooter({ text: responsibleMod ? 'Verified via Discord Audit Logs' : 'Voice State Transition' })
          .setTimestamp();
        await logDrag(guild, dragEmbed);
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
          const session = musicService?.sessions?.get(interaction.guildId);
          if (session?.voiceChannel && session.voiceChannel.id !== vc.id) {
            return safeReply(interaction, '❌ You must be in the same Voice Channel as the bot to use music controls!');
          }
          const q = getQ(interaction.guildId);

        // ——— Music Button Handlers (× 7 Rythm-style controls) ———
          if (id === 'btn_m_play_pause') {
            if (musicService) {
              const session = musicService.sessions?.get(interaction.guildId);
              if (!session) return safeReply(interaction, 'No active music session.');
              if (session.isPaused) { musicService.resume(interaction.guildId); await safeReply(interaction, '▶️ Playback resumed.'); }
              else { musicService.pause(interaction.guildId); await safeReply(interaction, '⏸️ Playback paused.'); }
            } else if (q.player) {
              if (q.isPaused) { q.player.unpause(); q.isPaused = false; await safeReply(interaction, '▶️ Playback resumed.'); }
              else { q.player.pause(); q.isPaused = true; await safeReply(interaction, '⏸️ Playback paused.'); }
            } else { await safeReply(interaction, 'No active music player found.'); }
            return;
          }
          if (id === 'btn_m_skip') {
            if (musicService) {
              const session = musicService.sessions?.get(interaction.guildId);
              const title = session?.currentTrack?.title || 'current track';
              const ok = musicService.skip(interaction.guildId);
              return safeReply(interaction, ok ? `⏭️ Skipped: **${title}**` : 'Queue is empty!');
            }
            if (q.currentTrack) {
              await safeReply(interaction, `⏭️ Skipped: **${q.currentTrack.title}**`);
              handleTrackEnded(interaction.guildId);
            } else { await safeReply(interaction, 'Queue is empty!'); }
            return;
          }
          if (id === 'btn_m_stop') {
            if (musicService) musicService.destroySession(interaction.guildId);
            else stopMusicSession(interaction.guildId);
            await safeReply(interaction, '⏹️ Music stopped and session cleared.');
            return;
          }
          if (id === 'btn_m_prev') {
            if (musicService) {
              const prev = musicService.playPrevious(interaction.guildId);
              return safeReply(interaction, prev ? `⏮️ Replaying: **${prev.title}**` : 'No previous tracks in history.');
            }
            return safeReply(interaction, '⏮️ Previous track not available.');
          }
          if (id === 'btn_m_loop') {
            if (musicService) {
              const session = musicService.sessions?.get(interaction.guildId);
              const current = session?.loopMode || 'off';
              const next = current === 'off' ? 'track' : current === 'track' ? 'queue' : 'off';
              musicService.setLoop(interaction.guildId, next);
              const icons = { off: '⏹️ Off', track: '🔁 Track', queue: '🔀 Queue' };
              return safeReply(interaction, `🔁 Loop mode → **${icons[next]}**`);
            }
            return safeReply(interaction, 'Loop toggle is only supported with the new music engine.');
          }
          if (id === 'btn_m_shuffle') {
            if (musicService) {
              const session = musicService.sessions?.get(interaction.guildId);
              if (!session || session.queue.length < 2) return safeReply(interaction, 'Not enough tracks in queue to shuffle.');
              musicService.shuffle(interaction.guildId);
              return safeReply(interaction, `🔀 Shuffled **${session.queue.length}** tracks in queue!`);
            }
            return safeReply(interaction, 'Shuffle is only supported with the new music engine.');
          }
          if (id === 'btn_m_queue') {
            const session = musicService?.sessions?.get(interaction.guildId);
            const qData = session?.queue || q?.queue || [];
            if (qData.length === 0) return safeReply(interaction, '📋 The queue is currently empty.');
            const lines = qData.slice(0, 10).map((t, i) => `**${i + 1}.** ${t.title}${t.artist ? ` — *${t.artist}*` : ''}`);
            const { EmbedBuilder: EB } = require('discord.js');
            const embed = new EB()
              .setColor('#5865F2')
              .setTitle('📋 Current Music Queue')
              .setDescription(lines.join('\n'))
              .setFooter({ text: `${qData.length} total tracks` })
              .setTimestamp();
            return safeReply(interaction, { embeds: [embed] });
          }
          if (id === 'btn_m_disconnect') {
            const cfg = getGuildConfig(interaction.guildId, interaction.guild?.name);
            if (cfg?.music247?.enabled) {
              return safeReply(interaction, '⚠️ 24/7 Music Mode is active for this server! Use `/songs 24-7 disable` to turn off persistent mode first.', true);
            }
            if (musicService) musicService.destroySession(interaction.guildId, true);
            else stopMusicSession(interaction.guildId);
            return safeReply(interaction, '👋 Disconnected from voice channel and cleared audio session.');
          }
          if (id === 'btn_m_clear') {
            const count = musicService ? musicService.clearQueue(interaction.guildId) : 0;
            return safeReply(interaction, `🧹 Cleared **${count}** tracks from the queue.`);
          }
          if (id === 'btn_m_volume') {
            const session = musicService?.sessions?.get(interaction.guildId);
            const currentVol = session?.volume || 100;
            const nextVol = currentVol === 100 ? 75 : currentVol === 75 ? 50 : currentVol === 50 ? 25 : 100;
            musicService?.setVolume(interaction.guildId, nextVol);
            return safeReply(interaction, `🔊 Playback volume adjusted to **${nextVol}%**.`);
          }
          if (id === 'btn_m_fav') {
            const session = musicService?.sessions?.get(interaction.guildId);
            if (!session || !session.currentTrack) return safeReply(interaction, 'Nothing is currently playing to favorite.');
            const res = musicService.addFavorite(interaction.guildId, interaction.user.id, session.currentTrack);
            if (!res.success) return safeReply(interaction, `⚠️ ${res.message}`);
            return safeReply(interaction, `⭐ Added **${res.track.title}** to your favorites! (${res.count} total)`);
          }
          if (id === 'btn_m_voice') {
            const isAuthorized = interaction.user.id === interaction.guild?.ownerId ||
              interaction.member?.permissions?.has(PermissionsBitField.Flags.ManageGuild) ||
              interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator) ||
              interaction.member?.permissions?.has(PermissionsBitField.Flags.MuteMembers);
            if (!isAuthorized) {
              return safeReply(interaction, '❌ You lack `ManageGuild` or voice moderation permissions to toggle the Voice Assistant.', true);
            }

            const vState = musicService?.getVoiceState(interaction.guildId);
            if (vState?.enabled) {
              musicService.disableVoiceAssistant(interaction.guildId);
              return safeReply(interaction, '🔇 **"Hey Apex" Voice Assistant is now DISABLED.** Audio capture stopped.');
            } else {
              const res = musicService?.enableVoiceAssistant(interaction.guild, vc, interaction.user, interaction.channel);
              if (!res?.success) {
                return safeReply(interaction, `⚠️ ${res?.message || 'Voice Assistant requires a configured STT provider in .env.'}`, true);
              }
              return safeReply(interaction, `🎙️ **"Hey Apex" Voice Assistant is now ENABLED in <#${vc.id}>.** Say *"Hey Apex, pause"* or *"Hey Apex, next"*. (Opt-in active, transient processing only)`);
            }
          }
          if (id === 'btn_m_favorites') {
            const favs = musicService ? musicService.getFavorites(interaction.guildId, interaction.user.id) : [];
            if (favs.length === 0) return safeReply(interaction, '⭐ Your favorites list is currently empty. Use the ⭐ Favorite button to save tracks.');
            const lines = favs.slice(0, 10).map((f, i) => `${i + 1}. **${f.title}**${f.artist ? ` — *${f.artist}*` : ''}`);
            const embed = new EmbedBuilder()
              .setColor('#FEE75C')
              .setTitle(`⭐ ${interaction.user.username}'s Favorites`)
              .setDescription(lines.join('\n'))
              .setFooter({ text: `${favs.length} total saved tracks • Choose below to stream immediately` });
            const menu = new StringSelectMenuBuilder()
              .setCustomId('select_m_fav_play')
              .setPlaceholder('Select a favorite track to stream...')
              .addOptions(
                favs.slice(0, 10).map((f, i) => ({
                  label: `${i + 1}. ${f.title.slice(0, 95)}`,
                  description: f.artist?.slice(0, 45) || 'Unknown Artist',
                  value: `fav_${i}`,
                  emoji: '⭐',
                }))
              );
            const row = new ActionRowBuilder().addComponents(menu);
            return safeReply(interaction, { embeds: [embed], components: [row] }, true);
          }
          if (id === 'btn_m_history') {
            const session = musicService?.sessions?.get(interaction.guildId);
            const hist = session?.history || [];
            if (hist.length === 0) return safeReply(interaction, '🕒 No previously played tracks recorded for this session.');
            const lines = hist.slice(0, 10).map((t, i) => `${i + 1}. **${t.title}**${t.artist ? ` — *${t.artist}*` : ''}`);
            const embed = new EmbedBuilder()
              .setColor('#5865F2')
              .setTitle('🕒 Listening History (Last Tracks)')
              .setDescription(lines.join('\n'))
              .setFooter({ text: `Total: ${hist.length} tracks • Use ⏮️ Prev button to replay last track` });
            return safeReply(interaction, { embeds: [embed] }, true);
          }
          if (id === 'btn_m_search') {
            const { ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
            const modal = new ModalBuilder()
              .setCustomId('modal_m_search')
              .setTitle('Search & Play Music');
            const input = new TextInputBuilder()
              .setCustomId('input_m_search_query')
              .setLabel('Song title, artist, or URL')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('e.g. Bohemian Rhapsody, Lofi Chill...')
              .setRequired(true)
              .setMaxLength(200);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            return interaction.showModal(modal);
          }
        }
      }

      // ── Music Select Menu Handlers ──
      if (interaction.isStringSelectMenu()) {
        const id = interaction.customId;
        if (id === 'select_m_search_result') {
          const vc = interaction.member?.voice?.channel;
          if (!vc) return safeReply(interaction, 'Join a Voice Channel first to play music!', true);
          const selectedVal = interaction.values[0];
          const idx = parseInt(selectedVal.replace('search_idx_', ''), 10);
          const cached = musicService?.getSearchCache(interaction.guildId, interaction.user.id);
          if (!cached || !cached[idx]) {
            return safeReply(interaction, '⚠️ Search selection expired. Please perform a new search.', true);
          }
          const chosen = cached[idx];
          await interaction.deferReply();
          const res = await musicService.enqueueTrack(
            interaction.guild,
            vc,
            interaction.user,
            interaction.channel,
            chosen.title,
            { exactTrack: chosen }
          );
          if (!res.success) return interaction.editReply(`❌ ${res.message}`);
          return interaction.editReply(`▶️ Queued your exact selection: **${chosen.title}**${chosen.artist ? ` by **${chosen.artist}**` : ''} (Position **#${res.position}**).`);
        }

        if (id === 'select_m_fav_play') {
          const vc = interaction.member?.voice?.channel;
          if (!vc) return safeReply(interaction, 'Join a Voice Channel first to play music!', true);
          const selectedVal = interaction.values[0];
          const idx = parseInt(selectedVal.replace('fav_', ''), 10);
          const favs = musicService?.getFavorites(interaction.guildId, interaction.user.id);
          if (!favs || !favs[idx]) {
            return safeReply(interaction, '⚠️ Favorite track not found.', true);
          }
          const chosen = favs[idx];
          await interaction.deferReply();
          const res = await musicService.enqueueTrack(
            interaction.guild,
            vc,
            interaction.user,
            interaction.channel,
            chosen.title,
            { exactTrack: chosen }
          );
          if (!res.success) return interaction.editReply(`❌ ${res.message}`);
          return interaction.editReply(`⭐ Playing favorite: **${chosen.title}**!`);
        }
      }

      // ── Music Modal Handlers ──
      if (interaction.isModalSubmit()) {
        if (interaction.customId === 'modal_m_search') {
          const vc = interaction.member?.voice?.channel;
          if (!vc) return interaction.reply({ content: 'Join a Voice Channel first to play music!', ephemeral: true });
          const query = interaction.fields.getTextInputValue('input_m_search_query');
          await interaction.deferReply({ ephemeral: true });
          try {
            const provider = require('./src/music/audioProvider');
            const results = await provider.searchAudioTracks(query, 5, interaction.guildId);
            if (!results || results.length === 0) {
              return interaction.editReply(`❌ No tracks found for "${query}".`);
            }
            musicService?.setSearchCache(interaction.guildId, interaction.user.id, results);
            const lines = results.map((r, i) => `${i + 1}. **${r.title}**${r.artist ? ` — *${r.artist}*` : ''} (\`${Math.floor((r.durationSec || 0) / 60)}:${String((r.durationSec || 0) % 60).padStart(2, '0')}\`)`);
            const embed = new EmbedBuilder()
              .setColor('#5865F2')
              .setTitle(`🔍 Search Results: "${query}"`)
              .setDescription(lines.join('\n'))
              .setFooter({ text: 'Choose the exact version you want to play below:' });
            const menu = new StringSelectMenuBuilder()
              .setCustomId('select_m_search_result')
              .setPlaceholder('Select exact version to stream...')
              .addOptions(
                results.slice(0, 5).map((r, i) => ({
                  label: `${i + 1}. ${r.title.slice(0, 95)}`,
                  description: `${r.artist?.slice(0, 45) || 'Unknown'} • ${Math.floor((r.durationSec || 0) / 60)}:${String((r.durationSec || 0) % 60).padStart(2, '0')}`,
                  value: `search_idx_${i}`,
                  emoji: '🎵',
                }))
              );
            const row = new ActionRowBuilder().addComponents(menu);
            return interaction.editReply({ embeds: [embed], components: [row] });
          } catch (err) {
            return interaction.editReply(`❌ Search error: ${err.message}`);
          }
        }
      }

      // ── Panel & QuickMod Button Handlers ──
      if (interaction.isButton()) {
        const id = interaction.customId;
        const guild = interaction.guild;
        if (!guild) return;
        const config = getGuildConfig(guild.id, guild.name);

        // QuickMod Rapid Action Buttons
        if (id.startsWith('qm_')) {
          if (!interaction.member?.permissions?.has(PermissionsBitField.Flags.ModerateMembers)) {
            return interaction.reply({ content: '❌ You lack `ModerateMembers` permission to use QuickMod buttons.', ephemeral: true });
          }
          const [, action, targetId] = id.split('_');
          const targetUser = await client.users.fetch(targetId).catch(() => null);
          const targetMember = guild.members.cache.get(targetId) || await guild.members.fetch(targetId).catch(() => null);

          if (!targetUser) return interaction.reply({ content: '❌ Target user not found.', ephemeral: true });

          if (action === 'warn') {
            await warnMember(guild, interaction.user, targetUser, 'QuickMod Warning');
            return interaction.reply({ content: `⚠️ Warned **${targetUser.tag || targetUser.username}** via QuickMod.`, ephemeral: true });
          }
          if (action === 't10') {
            if (!targetMember) return interaction.reply({ content: '❌ Target member not in server.', ephemeral: true });
            await timeoutMember(targetMember, 10 * 60 * 1000, 'QuickMod 10m Timeout');
            return interaction.reply({ content: `⏱️ Timed out **${targetUser.tag}** for 10 minutes.`, ephemeral: true });
          }
          if (action === 't1h') {
            if (!targetMember) return interaction.reply({ content: '❌ Target member not in server.', ephemeral: true });
            await timeoutMember(targetMember, 60 * 60 * 1000, 'QuickMod 1h Timeout');
            return interaction.reply({ content: `⏱️ Timed out **${targetUser.tag}** for 1 hour.`, ephemeral: true });
          }
          if (action === 'kick') {
            if (!targetMember) return interaction.reply({ content: '❌ Target member not in server.', ephemeral: true });
            await kickMember(targetMember, 'QuickMod Kick');
            return interaction.reply({ content: `👢 Kicked **${targetUser.tag}** from server.`, ephemeral: true });
          }
          if (action === 'ban') {
            await banMember(guild, targetId, 'QuickMod Ban', 1);
            return interaction.reply({ content: `🔨 Banned **${targetUser.tag}** from server.`, ephemeral: true });
          }
        }

        // /panel toggle AutoMod
        if (id === 'panel_toggle_automod') {
          config.automod.enabled = !config.automod.enabled;
          saveGuildConfig(guild.id, config);
          return interaction.reply({ content: `🤖 AutoMod Engine is now **${config.automod.enabled ? '🟢 ENABLED' : '🔴 DISABLED'}**.`, ephemeral: true });
        }

        // /panel toggle Anti-Nuke
        if (id === 'panel_toggle_antinuke') {
          config.security.antiNuke = !config.security.antiNuke;
          saveGuildConfig(guild.id, config);
          return interaction.reply({ content: `🛡️ Anti-Nuke is now **${config.security.antiNuke ? '🟢 ENABLED' : '🔴 DISABLED'}**.`, ephemeral: true });
        }

        // /panel lockdown toggle
        if (id === 'panel_lockdown') {
          if (!interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator) && !interaction.member?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) {
            return interaction.reply({ content: '❌ You lack `Administrator` or `ManageGuild` permission to toggle lockdown.', ephemeral: true });
          }
          const { engageEmergencyLockdown, liftEmergencyLockdown } = require('./src/security/backupRecovery');
          await interaction.deferReply({ ephemeral: true });
          if (!config.security?.lockdown) {
            const res = await engageEmergencyLockdown(guild, `${interaction.user.tag} via Panel`);
            return interaction.editReply({ content: res.success ? `🚨 Server Lockdown **ENGAGED**! Secured **${res.lockedChannels}** channels.` : `❌ Lockdown failed: ${res.reason || 'Check bot permissions'}` });
          } else {
            const res = await liftEmergencyLockdown(guild, `${interaction.user.tag} via Panel`);
            return interaction.editReply({ content: res.success ? `🔓 Server Lockdown **LIFTED**! Restored **${res.unlockedChannels}** channels.` : `❌ Unlock failed: ${res.reason || 'No valid snapshot'}` });
          }
        }

        // Security Suite: Clean Rogue Webhooks
        if (id === 'sec_clean_webhooks') {
          if (!interaction.member?.permissions?.has(PermissionsBitField.Flags.ManageWebhooks)) {
            return interaction.reply({ content: '❌ You lack `ManageWebhooks` permission.', ephemeral: true });
          }
          await interaction.deferReply({ ephemeral: true });
          const { cleanWebhooks } = require('./src/security/highSecuritySuite');
          const res = await cleanWebhooks(guild, interaction.user);
          if (!res.success) return interaction.editReply(`❌ Webhook cleanup failed: ${res.error}`);
          return interaction.editReply(`🗑️ Successfully deleted **${res.deleted}** rogue/orphan webhook(s). Failed: **${res.failed}**.`);
        }

        // Security Suite: Quick-Harden
        if (id === 'sec_quick_harden') {
          if (!interaction.member?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) {
            return interaction.reply({ content: '❌ You lack `ManageGuild` permission.', ephemeral: true });
          }
          await interaction.deferReply({ ephemeral: true });
          const { quickHarden } = require('./src/security/highSecuritySuite');
          const res = await quickHarden(guild, interaction.user);
          if (!res.success) return interaction.editReply(`❌ Quick-Harden failed: ${res.error}`);
          return interaction.editReply(`🛡️ **Quick-Harden Applied Successfully:**\n${res.changes.map(c => `• ${c}`).join('\n')}`);
        }

        // Security Suite: Lift Panic Mode
        if (id === 'sec_panic_lift') {
          if (!interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.reply({ content: '❌ Only Administrators can deactivate Panic Mode.', ephemeral: true });
          }
          await interaction.deferReply({ ephemeral: true });
          const { handlePanicMode } = require('./src/security/highSecuritySuite');
          const res = await handlePanicMode(guild, interaction.user, 'lift');
          if (!res.success) return interaction.editReply(`❌ Could not lift Panic Mode: ${res.error}`);
          return interaction.editReply({ embeds: [res.embed] });
        }

        // /panel release quarantine
        if (id === 'panel_release_quarantine') {
          const result = await releaseAllQuarantine(guild, `Panel release by ${interaction.user.tag}`);
          config.security.emergencyQuarantine = false;
          saveGuildConfig(guild.id, config);
          return interaction.reply({ content: `✅ Released **${result.released}** quarantined member(s). Failed: **${result.failed}**.`, ephemeral: true });
        }

        // /panel automod diagnostic
        if (id === 'panel_automod_diag') {
          await interaction.deferReply({ ephemeral: true });
          const { runAutoModDiagnostic } = require('./src/automod/autoModEngine');
          const diag = await runAutoModDiagnostic(guild);
          const summary = [
            ...diag.checks.map(c => `✅ ${c}`),
            ...diag.issues.map(i => `❌ ${i}`),
          ].join('\n') || 'No data.';
          return interaction.editReply({ content: `**🔍 AutoMod Diagnostic (${diag.activeRulesCount} active rules)**\n${summary}`, ephemeral: true });
        }

        // /panel edit filter rules — opens Modal
        if (id === 'panel_edit_filters') {
          const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder: ARB } = require('discord.js');
          const am = config.automod || {};
          const modal = new ModalBuilder()
            .setCustomId('modal_edit_filters')
            .setTitle('⚙️ AutoMod Filter Rules Editor');

          modal.addComponents(
            new ARB().addComponents(
              new TextInputBuilder()
                .setCustomId('input_spam_limit')
                .setLabel('Spam Limit (messages per 5s)')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setValue(String(am.antiSpam?.maxMessages || 5))
                .setPlaceholder('e.g. 5')
            ),
            new ARB().addComponents(
              new TextInputBuilder()
                .setCustomId('input_max_mentions')
                .setLabel('Max Mentions Allowed Per Message')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setValue(String(am.antiMentionSpam?.maxMentions || 5))
                .setPlaceholder('e.g. 5')
            ),
            new ARB().addComponents(
              new TextInputBuilder()
                .setCustomId('input_caps_threshold')
                .setLabel('Caps Threshold (%)')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setValue(String(am.antiCaps?.maxPercentage || 70))
                .setPlaceholder('e.g. 70')
            ),
            new ARB().addComponents(
              new TextInputBuilder()
                .setCustomId('input_blacklist_preview')
                .setLabel('Blacklisted Words (comma-separated)')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(false)
                .setValue((am.wordFilter?.words || []).slice(0, 10).join(', '))
                .setPlaceholder('e.g. badword1, badword2, badword3')
            ),
          );
          return interaction.showModal(modal);
        }

        // /threat DEFCON buttons
        if (id.startsWith('threat_defcon_') || id.startsWith('panel_defcon_')) {
          const level = parseInt(id.replace('threat_defcon_', '').replace('panel_defcon_defcon_', '')) || 3;
          config.security.defcon = level;
          if (level === 1) {
            config.security.lockdown = true;
            config.automod.altDetection = config.automod.altDetection || {};
            config.automod.altDetection.enabled = true;
          } else if (level === 2) {
            config.security.lockdown = false;
            config.automod.altDetection = config.automod.altDetection || {};
            config.automod.altDetection.enabled = true;
            config.automod.altDetection.minDays = 3;
          } else {
            config.security.lockdown = false;
          }
          saveGuildConfig(guild.id, config);
          const labels = { 1: '🔴 DEFCON 1 — Raid Underway', 2: '🟡 DEFCON 2 — High Alert', 3: '🟢 DEFCON 3 — Normal' };
          return interaction.reply({ content: `🚨 Threat level set to **${labels[level]}**. All corresponding security rules have been updated.`, ephemeral: true });
        }
      }

      // ── Select Menu Handlers ──
      if (interaction.isStringSelectMenu()) {
        const id = interaction.customId;
        const guild = interaction.guild;
        if (!guild) return;
        const config = getGuildConfig(guild.id, guild.name);

        if (id === 'panel_defcon_select') {
          const value = interaction.values[0]; // 'defcon_1', 'defcon_2', 'defcon_3'
          const level = parseInt(value.replace('defcon_', ''));
          config.security.defcon = level;
          if (level === 1) { config.security.lockdown = true; }
          else if (level === 2) { config.security.lockdown = false; config.automod.altDetection = { ...(config.automod.altDetection || {}), enabled: true, minDays: 3 }; }
          else { config.security.lockdown = false; }
          saveGuildConfig(guild.id, config);
          const labels = { 1: '🔴 DEFCON 1 — Raid Underway', 2: '🟡 DEFCON 2 — High Alert', 3: '🟢 DEFCON 3 — Normal' };
          return interaction.reply({ content: `🚨 DEFCON level switched to **${labels[level]}**.`, ephemeral: true });
        }

        // ── Help Category Select Menu ──
        if (id === 'help_category_select') {
          const selected = interaction.values[0]?.replace('help_', '') || 'overview';
          const { STATIC_HELP_CATEGORIES } = require('./src/commands/helpData');
          const helpCats = STATIC_HELP_CATEGORIES;
          const cat = helpCats[selected] || helpCats.overview;
          const { EmbedBuilder: EB } = require('discord.js');

          const catEmbed = new EB()
            .setColor(cat.color)
            .setTitle(cat.title)
            .setDescription(cat.description)
            .setFooter({ text: `THOR APEX v2.0 • ${Object.keys(helpCats).length - 1} categories • 80+ commands • Use the dropdown to navigate` })
            .setTimestamp();

          // Rebuild select menu with updated default
          const { ActionRowBuilder: ARB, StringSelectMenuBuilder: SSMB } = require('discord.js');
          const selectOpts = Object.entries(helpCats).map(([key, c]) => ({
            label: c.label,
            value: `help_${key}`,
            description: c.title.replace(/^[^\s]+\s/, '').slice(0, 100),
            emoji: c.emoji,
            default: key === selected,
          }));

          const newSelectRow = new ARB().addComponents(
            new SSMB()
              .setCustomId('help_category_select')
              .setPlaceholder('📖 Select a command category...')
              .setMinValues(1)
              .setMaxValues(1)
              .addOptions(selectOpts)
          );

          return interaction.update({ embeds: [catEmbed], components: [newSelectRow] });
        }
      }

      // ── Modal Submit Handlers ──
      if (interaction.isModalSubmit()) {
        const id = interaction.customId;
        const guild = interaction.guild;
        if (!guild) return;
        const config = getGuildConfig(guild.id, guild.name);

        if (id === 'modal_edit_filters') {
          const spamLimit = parseInt(interaction.fields.getTextInputValue('input_spam_limit')) || config.automod.antiSpam?.maxMessages || 5;
          const maxMentions = parseInt(interaction.fields.getTextInputValue('input_max_mentions')) || config.automod.antiMentionSpam?.maxMentions || 5;
          const capsThreshold = parseInt(interaction.fields.getTextInputValue('input_caps_threshold')) || config.automod.antiCaps?.maxPercentage || 70;
          const blacklistRaw = interaction.fields.getTextInputValue('input_blacklist_preview') || '';
          const newWords = blacklistRaw.split(',').map(w => w.trim().toLowerCase()).filter(Boolean);

          config.automod.antiSpam = { ...(config.automod.antiSpam || {}), maxMessages: spamLimit };
          config.automod.antiMentionSpam = { ...(config.automod.antiMentionSpam || {}), maxMentions };
          config.automod.antiCaps = { ...(config.automod.antiCaps || {}), maxPercentage: capsThreshold };
          if (newWords.length > 0) {
            config.automod.wordFilter = { ...(config.automod.wordFilter || {}), words: newWords };
          }
          saveGuildConfig(guild.id, config);
          return interaction.reply({
            content: `✅ **AutoMod rules updated!**\n` +
              `• Spam Limit: **${spamLimit} msgs/5s**\n` +
              `• Max Mentions: **${maxMentions}**\n` +
              `• Caps Threshold: **${capsThreshold}%**\n` +
              `• Blacklisted Words: **${newWords.length > 0 ? newWords.length + ' words' : 'unchanged'}**`,
            ephemeral: true,
          });
        }
      }

      // ── Chat Input Slash Commands ──
      if (!interaction.isChatInputCommand()) return;

      const context = {
        client,
        startTime,
        getQ,
        stopMusicSession,
        handleTrackEnded,
        addMusicToQueue,
        RADIO_STREAMS,
        voiceLib,
      };

      await dispatchCommand(interaction, context);

      // Final acknowledgement safety net: if neither replied nor deferred, acknowledge safely!
      if (!interaction.replied && !interaction.deferred) {
        await safeReply(interaction, '⚠️ Command was received but did not produce a response. Please check bot permissions.', true);
      }
    } catch (err) {
      console.error(redactSecrets(`[Interaction Error] ${interaction.commandName || 'component'}: ${err.message}\n${err.stack || ''}`));
      try {
        const errMsg = `❌ An unexpected error occurred while executing \`/${interaction.commandName || 'command'}\`: ${err.message}`;
        await safeReply(interaction, errMsg, true);
      } catch (_) {}
    }
  });

  // ── Graceful Shutdown Handler ──
  const shutdown = async (signal) => {
    console.log(`\nReceived ${signal}. Shutting down gracefully...`);
    if (musicService?.sessions) {
      for (const [gId] of musicService.sessions) {
        try { musicService.destroySession(gId); } catch (_) {}
      }
    }
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
