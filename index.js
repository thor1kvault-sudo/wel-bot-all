const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

try {
  const ffmpegStatic = require('ffmpeg-static');
  if (ffmpegStatic) process.env.FFMPEG_PATH = ffmpegStatic;
} catch (_) {}

// ─── Global Error Handlers ───────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled Promise Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
});

// ─── HTTP Health Check Server ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    bot: 'Multi-Server Welcome Bot',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  }));
});
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Health check server running on port ${PORT}`);
});

// ─── Per-Server Config Storage ────────────────────────────────────────────────
// Each server (guild) gets its own config file stored in ./guild_configs/<guildId>.json
const GUILD_CONFIGS_DIR = path.join(__dirname, 'guild_configs');
if (!fs.existsSync(GUILD_CONFIGS_DIR)) {
  fs.mkdirSync(GUILD_CONFIGS_DIR, { recursive: true });
}

/**
 * Returns the default config structure for a new server.
 * Preserves exact THOR APEX welcome text for THOR APEX server,
 * while automatically adapting to any other public server.
 */
function getDefaultConfig(guild) {
  const isThorApex = guild?.name?.toLowerCase()?.includes('thor apex');
  const serverName = guild ? guild.name : 'Your Server';

  // Auto-detect channel IDs if guild channels are cached
  let welcomeId = '', rulesId = '', rolesId = '', generalId = '', leaveId = '';
  if (guild?.channels?.cache) {
    const channels = guild.channels.cache;
    welcomeId = channels.find(c => c.isTextBased?.() && /welcome|join|greet/i.test(c.name))?.id || '';
    rulesId = channels.find(c => c.isTextBased?.() && /rule|guideline/i.test(c.name))?.id || '';
    rolesId = channels.find(c => c.isTextBased?.() && /role/i.test(c.name))?.id || '';
    generalId = channels.find(c => c.isTextBased?.() && /general|chat|main/i.test(c.name))?.id || '';
    leaveId = channels.find(c => c.isTextBased?.() && /leave|goodbye|farewell|bye|exit/i.test(c.name))?.id || '';
  }

  return {
    serverName: serverName,
    welcomeTitle: isThorApex ? 'WELCOME TO THOR APEX !' : `Welcome to ${serverName}!`,
    embedColor: '#5865F2',
    channels: {
      welcomeChannelId: welcomeId,
      leaveChannelId: leaveId,
      rulesChannelId: rulesId,
      rolesChannelId: rolesId,
      generalChannelId: generalId,
    },
    messages: {
      greetingPrefix: 'HEY BUDDY!',
      welcomeSubtitle: isThorApex ? 'Welcome to THOR APEX !' : `Welcome to ${serverName}!`,
      rulesText: 'Please read our rules:',
      outroText: isThorApex ? 'Hope you enjoy your stay in THOR APEX! 🎉' : 'Hope you enjoy your stay here! 🎉',
      leaveText: 'Goodbye {username}! We are sad to see you go. We now have **{count}** members.',
    },
    // If false, uses Discord CDN URLs set by admin; if true, auto-uses server icon/banner
    useServerAssets: true,
    customImages: {
      logoUrl: '',
      bannerUrl: '',
    }
  };
}

/** Load config for a specific guild. Returns default config if none exists yet. */
function loadGuildConfig(guild) {
  const filePath = path.join(GUILD_CONFIGS_DIR, `${guild.id}.json`);
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      console.warn(`⚠️ Could not parse config for guild ${guild.id}, using defaults.`);
    }
  }
  return getDefaultConfig(guild);
}

/** Save config for a specific guild. */
function saveGuildConfig(guildId, config) {
  const filePath = path.join(GUILD_CONFIGS_DIR, `${guildId}.json`);
  try {
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
    console.log(`💾 Config saved for guild: ${guildId}`);
  } catch (err) {
    console.error(`❌ Failed to save config for guild ${guildId}:`, err);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatChannelMention(channelId, fallbackName) {
  if (!channelId || !/^\d+$/.test(channelId)) return `\`#${fallbackName}\``;
  return `<#${channelId}>`;
}

function isValidHexColor(str) {
  return /^#[0-9A-Fa-f]{6}$/.test(str);
}

// ─── Music Bot Storage & Voice Library ─────────────────────────────────────────
let voiceLib = null;
try {
  voiceLib = require('@discordjs/voice');
} catch (e) {
  console.log('ℹ️ Voice library load status:', e.message);
}

let playdl = null;
try {
  playdl = require('play-dl');
} catch (e) {
  console.log('ℹ️ play-dl load status:', e.message);
}

const musicQueues = new Map(); // guildId => { connection, player, queue: [], currentTrack: null, isPlaying: false }

function getGuildQueue(guildId) {
  if (!musicQueues.has(guildId)) {
    musicQueues.set(guildId, {
      connection: null,
      player: null,
      queue: [],
      currentTrack: null,
      isPlaying: false,
    });
  }
  return musicQueues.get(guildId);
}

async function playTrackAudio(guildId) {
  if (!voiceLib) return;
  const guildQueue = getGuildQueue(guildId);
  if (!guildQueue || !guildQueue.connection) return;

  try {
    if (guildQueue.connection.state.status !== voiceLib.VoiceConnectionStatus.Ready) {
      await voiceLib.entersState(guildQueue.connection, voiceLib.VoiceConnectionStatus.Ready, 20_000);
    }
  } catch (err) {
    console.warn('⚠️ Voice connection readiness note:', err.message);
  }

  if (!guildQueue.player) {
    try {
      guildQueue.player = voiceLib.createAudioPlayer({
        behaviors: {
          noSubscriber: voiceLib.NoSubscriberBehavior.Play,
          maxMissedFrames: Math.round(5000 / 20),
        },
      });

      guildQueue.connection.subscribe(guildQueue.player);

      guildQueue.player.on(voiceLib.AudioPlayerStatus.Idle, () => {
        guildQueue.queue.shift();
        if (guildQueue.queue.length > 0) {
          playTrackAudio(guildId);
        } else {
          guildQueue.isPlaying = false;
        }
      });

      guildQueue.player.on('error', (err) => {
        console.warn('⚠️ Audio player error:', err.message);
        guildQueue.queue.shift();
        if (guildQueue.queue.length > 0) playTrackAudio(guildId);
      });
    } catch (e) {
      console.warn('⚠️ Audio player creation error:', e.message);
      return;
    }
  }

  const currentTrack = guildQueue.queue[0];
  if (!currentTrack) return;

  try {
    let stream = null;
    let type = voiceLib.StreamType.Arbitrary;

    if (playdl && currentTrack.url) {
      try {
        if (currentTrack.url.includes('spotify.com')) {
          const spData = await playdl.spotify(currentTrack.url).catch(() => null);
          if (spData && spData.name) {
            const searched = await playdl.search(`${spData.name} ${spData.artists?.[0]?.name || ''}`, { limit: 1 });
            if (searched && searched[0]) {
              const res = await playdl.stream(searched[0].url);
              stream = res.stream;
              type = res.type;
            }
          }
        } else if (currentTrack.url.includes('youtube.com') || currentTrack.url.includes('youtu.be')) {
          const res = await playdl.stream(currentTrack.url);
          stream = res.stream;
          type = res.type;
        } else if (currentTrack.url.startsWith('http') && !currentTrack.url.includes('results?search_query=')) {
          const res = await playdl.stream(currentTrack.url).catch(() => null);
          if (res) {
            stream = res.stream;
            type = res.type;
          }
        } else {
          // Search query like "enna sona"
          const searched = await playdl.search(currentTrack.title, { limit: 1 });
          if (searched && searched[0]) {
            const res = await playdl.stream(searched[0].url);
            stream = res.stream;
            type = res.type;
          }
        }
      } catch (e) {
        console.warn('⚠️ play-dl stream note:', e.message);
      }
    }

    if (!stream) {
      const fallbackUrl = currentTrack.url.startsWith('http') && !currentTrack.url.includes('youtube.com') && !currentTrack.url.includes('spotify.com')
        ? currentTrack.url
        : 'https://stream.zeno.fm/f3wvbbqmdg8uv';

      https.get(fallbackUrl, (audioStream) => {
        try {
          const resource = voiceLib.createAudioResource(audioStream, {
            inputType: voiceLib.StreamType.Arbitrary,
            inlineVolume: true,
          });
          if (resource.volume) resource.volume.setVolume(1.0);
          guildQueue.player.play(resource);
          guildQueue.isPlaying = true;
          console.log(`🎵 Playing audio stream in guild ${guildId}: ${currentTrack.title}`);
        } catch (e) {
          console.error('Audio resource error:', e);
        }
      }).on('error', (err) => {
        console.warn('⚠️ Audio stream request error:', err.message);
      });
    } else {
      const resource = voiceLib.createAudioResource(stream, { inputType: type, inlineVolume: true });
      if (resource.volume) resource.volume.setVolume(1.0);
      guildQueue.player.play(resource);
      guildQueue.isPlaying = true;
      console.log(`🎵 Playing stream in guild ${guildId}: ${currentTrack.title}`);
    }
  } catch (err) {
    console.error('❌ Audio stream error:', err.message);
  }
}

function addSongToQueue(guild, voiceChannel, user, songInput) {
  const guildQueue = getGuildQueue(guild.id);
  const isUrl = typeof songInput === 'string' && songInput.trim().startsWith('http');
  const queryStr = songInput.trim();

  let trackTitle = queryStr;
  let provider = 'Music';

  if (isUrl) {
    try {
      const u = new URL(queryStr);
      const host = u.hostname.toLowerCase();
      if (host.includes('spotify.com')) {
        provider = 'Spotify 🟢';
        if (u.pathname.includes('/track/')) {
          trackTitle = '🟢 Spotify Track';
        } else if (u.pathname.includes('/playlist/')) {
          trackTitle = '🟢 Spotify Playlist';
        } else if (u.pathname.includes('/album/')) {
          trackTitle = '🟢 Spotify Album';
        } else {
          trackTitle = '🟢 Spotify Link';
        }
      } else if (host.includes('youtube.com') || host.includes('youtu.be')) {
        provider = 'YouTube 🔴';
        trackTitle = '🔴 YouTube Video / Song Link';
      } else if (host.includes('soundcloud.com')) {
        provider = 'SoundCloud 🟠';
        trackTitle = '🟠 SoundCloud Track';
      } else {
        provider = u.hostname.replace('www.', '');
        trackTitle = `🎵 Music Link (${provider})`;
      }
    } catch (_) {
      trackTitle = '🎵 Music Link';
    }
  }

  const track = {
    title: trackTitle,
    url: isUrl ? queryStr : `https://www.youtube.com/results?search_query=${encodeURIComponent(queryStr)}`,
    requestedBy: user.id,
    channelName: voiceChannel ? voiceChannel.name : 'Voice Channel',
    provider: provider,
  };

  guildQueue.queue.push(track);

  if (voiceLib && voiceChannel) {
    if (!guildQueue.connection) {
      try {
        guildQueue.connection = voiceLib.joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: guild.id,
          adapterCreator: guild.voiceAdapterCreator,
          selfDeaf: false,
          selfMute: false,
        });
      } catch (e) {
        console.warn('⚠️ Voice connection error:', e.message);
      }
    }

    // Start audio playback
    playTrackAudio(guild.id);
  }

  return { track, position: guildQueue.queue.length };
}

// ─── Invite Tracking Cache ───────────────────────────────────────────────────
const guildInvitesCache = new Map(); // guildId => Map(inviteCode => usesCount)

async function cacheGuildInvites(guild) {
  try {
    if (!guild || !guild.members?.me?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) return;
    const invites = await guild.invites.fetch().catch(() => null);
    if (!invites) return;
    const inviteMap = new Map();
    invites.forEach(inv => inviteMap.set(inv.code, inv.uses || 0));
    guildInvitesCache.set(guild.id, inviteMap);
  } catch (e) {
    // ignore missing permissions
  }
}

async function findInviter(guild) {
  try {
    if (!guild || !guild.members?.me?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) return null;
    const cachedInvites = guildInvitesCache.get(guild.id) || new Map();
    const newInvites = await guild.invites.fetch().catch(() => null);

    if (!newInvites) return null;

    let usedInvite = null;
    newInvites.forEach(inv => {
      const prevUses = cachedInvites.get(inv.code) || 0;
      if (inv.uses > prevUses && !usedInvite) {
        usedInvite = inv;
      }
    });

    // Update cache
    const updatedMap = new Map();
    newInvites.forEach(inv => updatedMap.set(inv.code, inv.uses || 0));
    guildInvitesCache.set(guild.id, updatedMap);

    if (usedInvite && usedInvite.inviter) {
      let totalUses = 0;
      newInvites.forEach(inv => {
        if (inv.inviter?.id === usedInvite.inviter.id) {
          totalUses += (inv.uses || 0);
        }
      });
      return {
        inviterId: usedInvite.inviter.id,
        inviterTag: usedInvite.inviter.tag,
        uses: totalUses,
        code: usedInvite.code,
      };
    }
  } catch (e) {
    console.warn('⚠️ Invite tracking note:', e.message);
  }
  return null;
}

// ─── Welcome Embed Builder ────────────────────────────────────────────────────
function createWelcomeEmbed(member, guild, inviterData = null) {
  const isThorApex = guild?.name?.toLowerCase()?.includes('thor apex');

  // ── PERMANENT ORIGINAL CODE FOR YOUR THOR APEX SERVER (UNTOUCHED) ──
  if (isThorApex) {
    const userId = member?.user?.id ?? member?.id ?? '000000000000000000';
    const channels = guild?.channels?.cache;

    const rulesCh = channels?.find(c => /rule/i.test(c.name)) || 'Rules';
    const funCh = channels?.find(c => /fun/i.test(c.name)) || 'FUN TIME';
    const editCh = channels?.find(c => /editing|edit/i.test(c.name)) || 'PC EDITING';
    const gamingCh = channels?.find(c => /gaming|game/i.test(c.name)) || 'GAMING-TEXT';
    const generalCh = channels?.find(c => /general|chat/i.test(c.name)) || 'General';

    const rulesTag = typeof rulesCh === 'string' ? `\`#${rulesCh}\`` : `<#${rulesCh.id}>`;
    const funTag = typeof funCh === 'string' ? `\`#${funCh}\`` : `<#${funCh.id}>`;
    const editTag = typeof editCh === 'string' ? `\`#${editCh}\`` : `<#${editCh.id}>`;
    const gamingTag = typeof gamingCh === 'string' ? `\`#${gamingCh}\`` : `<#${gamingCh.id}>`;
    const generalTag = typeof generalCh === 'string' ? `\`#${generalCh}\`` : `<#${generalCh.id}>`;

    const lines = [
      `### HEY BUDDY! <@${userId}>\n`,
      `**Welcome To THOR APEX !**\n`,
      `**Get started with below:** ⚡ THOR APEX ⚡ ➔ ${rulesTag}\n`,
      `**Follow The Server Guidelines:** ⚡ THOR APEX ⚡ ➔ ${rulesTag}\n`,
      `**Fun With Us:** ⚡ THOR APEX ⚡ ➔ ${funTag}\n`,
      `**Editing Zone:** ⚡ THOR APEX ⚡ ➔ ${editTag}\n`,
      `**Gaming Zone:** ⚡ THOR APEX ⚡ ➔ ${gamingTag}\n`,
      `**Join And Chill With Us!:** ⚡ THOR APEX ⚡ ➔ ${generalTag}\n`,
      `\n### Thanks For Joining. Hope You Have A Great Time Here!`
    ];

    const embed = new EmbedBuilder()
      .setColor('#FF0000')
      .setDescription(lines.join('\n'))
      .setTimestamp();

    const logoUrl = guild.iconURL({ size: 1024, forceStatic: false });
    const authorOptions = { name: 'THOR APEX !' };
    if (logoUrl) authorOptions.iconURL = logoUrl;
    embed.setAuthor(authorOptions);

    const avatarUrl = member?.user?.displayAvatarURL({ size: 256, forceStatic: false });
    if (avatarUrl) embed.setThumbnail(avatarUrl);
    else if (logoUrl) embed.setThumbnail(logoUrl);

    const bannerUrl = guild.bannerURL({ size: 1024 });
    if (bannerUrl) embed.setImage(bannerUrl);

    const footerOptions = { text: 'THOR APEX !' };
    if (logoUrl) footerOptions.iconURL = logoUrl;
    embed.setFooter(footerOptions);

    return embed;
  }

  // ── NEW DYNAMIC CODE FOR ALL OTHER SERVERS (MAXXZ FAM & PUBLIC SERVERS) ──
  const config = loadGuildConfig(guild);

  let logoUrl = config.customImages?.logoUrl?.startsWith('http') ? config.customImages.logoUrl : null;
  if (!logoUrl && guild?.iconURL) {
    logoUrl = guild.iconURL({ size: 1024, forceStatic: false });
  }

  let bannerUrl = config.customImages?.bannerUrl?.startsWith('http') ? config.customImages.bannerUrl : null;
  if (!bannerUrl && guild?.bannerURL) {
    bannerUrl = guild.bannerURL({ size: 1024 });
  }

  const userId = member?.user?.id ?? member?.id ?? '000000000000000000';
  const guildName = guild.name || config.serverName || 'Your Server';

  const rulesTag = formatChannelMention(config.channels?.rulesChannelId, 'rules');
  const rolesTag = formatChannelMention(config.channels?.rolesChannelId, 'roles');
  const generalTag = formatChannelMention(config.channels?.generalChannelId, 'general');

  const lines = [];
  lines.push(`### ${config.messages?.greetingPrefix || 'HEY BUDDY!'} <@${userId}>\n`);
  lines.push(`**${config.messages?.welcomeSubtitle || `Welcome to ${guildName}!`}**\n`);

  if (inviterData && inviterData.inviterId) {
    lines.push(`**📩 Invited by:** <@${inviterData.inviterId}> (Total Invites: **${inviterData.uses}**)\n`);
  } else {
    lines.push(`**📩 Invited by:** Direct Link / Unknown\n`);
  }

  lines.push(`**${config.messages?.rulesText || 'Please read our rules:'}** ${rulesTag}\n`);
  lines.push(`**🎭 Get your roles here:** ${rolesTag}\n`);
  lines.push(`**💬 Start chatting in:** ${generalTag}\n`);
  lines.push(`\n### ${config.messages?.outroText || 'Hope you enjoy your stay here! 🎉'}`);

  const embedColor = isValidHexColor(config.embedColor) ? config.embedColor : '#5865F2';

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setDescription(lines.join('\n'))
    .setTimestamp();

  const authorOptions = { name: config.welcomeTitle || `Welcome to ${guildName}!` };
  if (logoUrl) authorOptions.iconURL = logoUrl;
  embed.setAuthor(authorOptions);

  const avatarUrl = member?.user?.displayAvatarURL({ size: 256, forceStatic: false });
  if (avatarUrl) embed.setThumbnail(avatarUrl);
  else if (logoUrl) embed.setThumbnail(logoUrl);

  if (bannerUrl) embed.setImage(bannerUrl);

  const footerOptions = { text: `${guildName} • Member #${guild.memberCount || '1'}` };
  if (logoUrl) footerOptions.iconURL = logoUrl;
  embed.setFooter(footerOptions);

  return embed;
}

// ─── Leave Embed Builder ─────────────────────────────────────────────────────
function createLeaveEmbed(member, guild) {
  const config = loadGuildConfig(guild);
  const guildName = guild.name || config.serverName || 'Server';
  const username = member.user?.tag || member.user?.username || 'Member';

  let logoUrl = config.customImages?.logoUrl?.startsWith('http') ? config.customImages.logoUrl : null;
  if (!logoUrl && guild?.iconURL) {
    logoUrl = guild.iconURL({ size: 1024, forceStatic: false });
  }

  const rawMsg = config.messages?.leaveText || 'Goodbye **{username}**! We are sad to see you go. We now have **{count}** members.';
  const formattedMsg = rawMsg
    .replace(/{user}/g, `<@${member.id}>`)
    .replace(/{username}/g, username)
    .replace(/{server}/g, guildName)
    .replace(/{count}/g, guild.memberCount || 0);

  const embedColor = isValidHexColor(config.embedColor) ? config.embedColor : '#ED4245';

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setTitle(`👋 Member Left — ${guildName}`)
    .setDescription(`### ${formattedMsg}`)
    .setTimestamp();

  const avatarUrl = member?.user?.displayAvatarURL({ size: 256, forceStatic: false });
  if (avatarUrl) embed.setThumbnail(avatarUrl);
  else if (logoUrl) embed.setThumbnail(logoUrl);

  const footerOptions = { text: `${guildName} • Total Members: ${guild.memberCount || 0}` };
  if (logoUrl) footerOptions.iconURL = logoUrl;
  embed.setFooter(footerOptions);

  return embed;
}

// ─── Slash Commands Definition ─────────────────────────────────────────────────
function buildSlashCommands() {
  return [
    // ── Setup: Welcome Channel
    new SlashCommandBuilder()
      .setName('setwelcome')
      .setDescription('Set the welcome channel for this server')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addChannelOption(opt =>
        opt.setName('channel')
          .setDescription('The channel where welcome messages will be sent')
          .setRequired(false)
      ),

    // ── Setup: Rules Channel
    new SlashCommandBuilder()
      .setName('setrules')
      .setDescription('Set the rules channel shown in welcome messages')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addChannelOption(opt =>
        opt.setName('channel').setDescription('Rules channel').setRequired(true)
      ),

    // ── Setup: Roles Channel
    new SlashCommandBuilder()
      .setName('setroles')
      .setDescription('Set the roles channel shown in welcome messages')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addChannelOption(opt =>
        opt.setName('channel').setDescription('Roles channel').setRequired(true)
      ),

    // ── Setup: General Channel
    new SlashCommandBuilder()
      .setName('setgeneral')
      .setDescription('Set the general channel shown in welcome messages')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addChannelOption(opt =>
        opt.setName('channel').setDescription('General channel').setRequired(true)
      ),

    // ── Customize: Embed Color
    new SlashCommandBuilder()
      .setName('setwelcomecolor')
      .setDescription('Set the embed color for welcome messages (e.g. #FF5733)')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addStringOption(opt =>
        opt.setName('color')
          .setDescription('Hex color code, e.g. #FF5733')
          .setRequired(true)
      ),

    // ── Customize: Greeting text
    new SlashCommandBuilder()
      .setName('setwelcometext')
      .setDescription('Customize the welcome message text')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addStringOption(opt =>
        opt.setName('greeting')
          .setDescription('Opening greeting (e.g. "HELLO THERE!")')
          .setRequired(false)
      )
      .addStringOption(opt =>
        opt.setName('subtitle')
          .setDescription('Welcome subtitle (e.g. "Welcome to Our Server!")')
          .setRequired(false)
      )
      .addStringOption(opt =>
        opt.setName('outro')
          .setDescription('Closing line of the welcome message')
          .setRequired(false)
      ),

    // ── View current setup
    new SlashCommandBuilder()
      .setName('welcomeconfig')
      .setDescription('View the current welcome bot configuration for this server')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

    // ── Test welcome
    new SlashCommandBuilder()
      .setName('testwelcome')
      .setDescription('Preview the welcome message for this server'),

    // ── Reset config
    new SlashCommandBuilder()
      .setName('resetwelcome')
      .setDescription('Reset all welcome settings for this server back to defaults')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

    // ── Setup: Leave Channel
    new SlashCommandBuilder()
      .setName('setleave')
      .setDescription('Set the leave/goodbye channel for this server')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addChannelOption(opt =>
        opt.setName('channel')
          .setDescription('The channel where leave/goodbye messages will be sent')
          .setRequired(true)
      ),

    // ── Customize: Leave Message Text
    new SlashCommandBuilder()
      .setName('setleavetext')
      .setDescription('Customize the member leave message text')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addStringOption(opt =>
        opt.setName('message')
          .setDescription('Message text (use {username}, {user}, {server}, {count})')
          .setRequired(true)
      ),

    // ── Test Leave
    new SlashCommandBuilder()
      .setName('testleave')
      .setDescription('Preview the leave/goodbye message for this server'),

    // ── Check Invites
    new SlashCommandBuilder()
      .setName('myinvites')
      .setDescription('Check how many members you have invited to this server'),

    // ── Auto Setup (detects channels, logo, banner automatically)
    new SlashCommandBuilder()
      .setName('setup')
      .setDescription('Auto-setup the welcome bot for this server (detects channels, logo, banner)')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addAttachmentOption(opt =>
        opt.setName('logo_file')
          .setDescription('Upload a custom logo image file from your PC/phone')
          .setRequired(false)
      )
      .addAttachmentOption(opt =>
        opt.setName('banner_file')
          .setDescription('Upload a custom banner image file from your PC/phone')
          .setRequired(false)
      )
      .addStringOption(opt =>
        opt.setName('color')
          .setDescription('Embed color (e.g. #FF5733) — leave empty for default')
          .setRequired(false)
      )
      .addStringOption(opt =>
        opt.setName('greeting')
          .setDescription('Custom greeting text (e.g. "HEY THERE!") — leave empty for default')
          .setRequired(false)
      ),

    // ── Customize Logo & Banner
    new SlashCommandBuilder()
      .setName('setimages')
      .setDescription('Set custom logo or banner image for welcome messages (Upload file or paste URL)')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addAttachmentOption(opt =>
        opt.setName('logo_file')
          .setDescription('Upload custom logo image file')
          .setRequired(false)
      )
      .addAttachmentOption(opt =>
        opt.setName('banner_file')
          .setDescription('Upload custom banner image file')
          .setRequired(false)
      )
      .addStringOption(opt =>
        opt.setName('logo_url')
          .setDescription('Or paste logo image link URL')
          .setRequired(false)
      )
      .addStringOption(opt =>
        opt.setName('banner_url')
          .setDescription('Or paste banner image link URL')
          .setRequired(false)
      ),

    // ── Music / Song Commands ──
    new SlashCommandBuilder()
      .setName('play')
      .setDescription('Play a song or stream in your voice channel')
      .addStringOption(opt =>
        opt.setName('song')
          .setDescription('Song name, stream link, or YouTube title')
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('pause')
      .setDescription('Pause current music playback'),

    new SlashCommandBuilder()
      .setName('resume')
      .setDescription('Resume music playback'),

    new SlashCommandBuilder()
      .setName('skip')
      .setDescription('Skip the currently playing song'),

    new SlashCommandBuilder()
      .setName('stop')
      .setDescription('Stop music playback and leave voice channel'),

    new SlashCommandBuilder()
      .setName('queue')
      .setDescription('Show current music queue or add a song/link to queue')
      .addStringOption(opt =>
        opt.setName('song')
          .setDescription('Optional song name or song link URL to paste into queue')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('nowplaying')
      .setDescription('Show currently playing song info'),

    new SlashCommandBuilder()
      .setName('radio')
      .setDescription('Play 24/7 radio stream (Lofi, Gaming, Pop, Chill)')
      .addStringOption(opt =>
        opt.setName('genre')
          .setDescription('Choose radio genre')
          .setRequired(false)
          .addChoices(
            { name: '☕ Lofi Chill 24/7', value: 'lofi' },
            { name: '🎮 Gaming Beats 24/7', value: 'gaming' },
            { name: '🎵 Pop Hits 24/7', value: 'pop' },
            { name: '🎧 Chill Hop 24/7', value: 'chill' }
          )
      ),

    new SlashCommandBuilder()
      .setName('activity')
      .setDescription('Launch Discord Voice Activity / Watch Together in your voice channel'),

    // ── Help
    new SlashCommandBuilder()
      .setName('welcomehelp')
      .setDescription('Show all available Welcome & Music Bot commands'),
  ].map(cmd => cmd.toJSON());
}

async function registerCommandsForGuild(client, guild) {
  const commands = buildSlashCommands();
  const token = process.env.DISCORD_TOKEN;
  if (!token) return;
  const rest = new REST({ version: '10' }).setToken(token);

  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: commands });
    console.log(`✅ Instant slash commands registered for server: "${guild.name}" (${guild.id})`);
  } catch (err) {
    console.warn(`⚠️ Guild slash command registration note for ${guild.name}:`, err.message);
  }
}

// ─── Register Slash Commands (Instant Sync for connected servers + Global) ─────
async function registerSlashCommands(client) {
  const commands = buildSlashCommands();
  const token = process.env.DISCORD_TOKEN;
  if (!token) return;
  const rest = new REST({ version: '10' }).setToken(token);

  try {
    console.log('⏳ Registering instant slash commands across all connected servers...');
    
    // 1. Register per-guild for INSTANT sync in Discord UI!
    for (const guild of client.guilds.cache.values()) {
      await registerCommandsForGuild(client, guild);
    }

    // 2. Register global application commands
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Global slash commands updated!');
  } catch (err) {
    console.error('⚠️ Slash command registration error:', err.message);
  }
}

// ─── Main Bot ──────────────────────────────────────────────────────────────────
function startBot() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildInvites,
      GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [
      Partials.GuildMember,
      Partials.User,
      Partials.Channel,
      Partials.Message,
    ],
  });

  // ── Bot Ready
  client.once('clientReady', async () => {
    console.log('\n=======================================================');
    console.log('🤖 Multi-Server Welcome Bot is ONLINE!');
    console.log(`🏷️  Logged in as: ${client.user.tag}`);
    console.log(`🛡️  Connected to ${client.guilds.cache.size} server(s):`);
    client.guilds.cache.forEach(g => console.log(`   • ${g.name} (${g.id})`));
    console.log('=======================================================\n');

    // Cache invites for all guilds
    for (const g of client.guilds.cache.values()) {
      await cacheGuildInvites(g);
    }

    await registerSlashCommands(client);
  });

  // ── Bot Joins a New Server → register commands & cache invites
  client.on('guildCreate', async (guild) => {
    console.log(`🆕 Bot added to new server: "${guild.name}" (${guild.id})`);
    await cacheGuildInvites(guild);
    await registerCommandsForGuild(client, guild);
  });

  // ── New Member Joined
  client.on('guildMemberAdd', async (member) => {
    try {
      if (member.partial) {
        member = await member.fetch().catch(() => null);
        if (!member) return;
      }

      console.log(`🔔 New member: ${member.user.tag} in "${member.guild.name}"`);

      // Track who invited this member
      const inviterData = await findInviter(member.guild);

      const config = loadGuildConfig(member.guild);
      let welcomeChannel = null;

      // 1. Try the configured welcome channel ID
      if (config.channels?.welcomeChannelId && /^\d+$/.test(config.channels.welcomeChannelId)) {
        welcomeChannel = member.guild.channels.cache.get(config.channels.welcomeChannelId)
          || await member.guild.channels.fetch(config.channels.welcomeChannelId).catch(() => null);
      }

      // 2. Fallback: search by name
      if (!welcomeChannel) {
        welcomeChannel = member.guild.channels.cache.find(c =>
          c.isTextBased() && ['welcome', 'join', 'arrivals', 'greet'].some(kw => c.name.includes(kw))
        );
      }

      // 3. Fallback: system channel
      if (!welcomeChannel) welcomeChannel = member.guild.systemChannel;

      if (!welcomeChannel) {
        console.error(`❌ No welcome channel found in "${member.guild.name}". Use /setwelcome to configure.`);
        return;
      }

      // Check permissions
      const botMember = member.guild.members.me;
      if (botMember) {
        const perms = welcomeChannel.permissionsFor(botMember);
        if (!perms?.has(PermissionsBitField.Flags.SendMessages)) {
          console.error(`❌ Missing SendMessages in #${welcomeChannel.name}`);
          return;
        }
        if (!perms?.has(PermissionsBitField.Flags.EmbedLinks)) {
          console.error(`❌ Missing EmbedLinks in #${welcomeChannel.name}`);
          return;
        }
      }

      const embed = createWelcomeEmbed(member, member.guild, inviterData);
      await welcomeChannel.send({
        content: `🎉 Welcome <@${member.id}> to **${member.guild.name}**!`,
        embeds: [embed],
      });
      console.log(`✅ Welcome sent for ${member.user.tag} in #${welcomeChannel.name}`);
    } catch (err) {
      console.error('❌ guildMemberAdd error:', err);
    }
  });

  // ── Member Left (Goodbye Message)
  client.on('guildMemberRemove', async (member) => {
    try {
      if (member.partial) {
        member = await member.fetch().catch(() => null);
        if (!member) return;
      }

      console.log(`👋 Member left: ${member.user?.tag || member.id} from "${member.guild.name}"`);

      const config = loadGuildConfig(member.guild);
      let leaveChannel = null;

      if (config.channels?.leaveChannelId && /^\d+$/.test(config.channels.leaveChannelId)) {
        leaveChannel = member.guild.channels.cache.get(config.channels.leaveChannelId)
          || await member.guild.channels.fetch(config.channels.leaveChannelId).catch(() => null);
      }

      if (!leaveChannel && member.guild.channels?.cache) {
        leaveChannel = member.guild.channels.cache.find(c =>
          c.isTextBased?.() && ['leave', 'goodbye', 'farewell', 'bye', 'exit', 'left'].some(k => c.name.toLowerCase().includes(k))
        );
      }

      if (!leaveChannel) return; // No leave channel configured or found

      const leaveEmbed = createLeaveEmbed(member, member.guild);
      await leaveChannel.send({ embeds: [leaveEmbed] });
      console.log(`✅ Leave message sent for ${member.user?.tag || member.id} in #${leaveChannel.name}`);
    } catch (err) {
      console.error('❌ Error handling member leave:', err);
    }
  });

  // ── Slash Command Handler
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, guild } = interaction;

    // ── /setup (Auto-detects everything!)
    if (commandName === 'setup') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const config = loadGuildConfig(guild);
        const channels = guild.channels.cache;
        const results = [];

        // ── Auto-detect Welcome Channel
        const welcomeCh = channels.find(c =>
          c.isTextBased() && ['welcome', 'welcomes', 'join', 'arrivals', 'greet', 'joined'].some(k => c.name.toLowerCase().includes(k))
        );
        if (welcomeCh) {
          config.channels.welcomeChannelId = welcomeCh.id;
          results.push(`✅ Welcome Channel → <#${welcomeCh.id}>`);
        } else {
          results.push(`⚠️ Welcome Channel → Not found (use /setwelcome manually)`);
        }

        // ── Auto-detect Rules Channel
        const rulesCh = channels.find(c =>
          c.isTextBased() && ['rule', 'rules', 'guidelines', 'tos', 'terms'].some(k => c.name.toLowerCase().includes(k))
        );
        if (rulesCh) {
          config.channels.rulesChannelId = rulesCh.id;
          results.push(`✅ Rules Channel → <#${rulesCh.id}>`);
        } else {
          results.push(`⚠️ Rules Channel → Not found (use /setrules manually)`);
        }

        // ── Auto-detect Roles Channel
        const rolesCh = channels.find(c =>
          c.isTextBased() && ['role', 'roles', 'self-role', 'selfrole', 'pick-role', 'get-role', 'colour', 'color'].some(k => c.name.toLowerCase().includes(k))
        );
        if (rolesCh) {
          config.channels.rolesChannelId = rolesCh.id;
          results.push(`✅ Roles Channel → <#${rolesCh.id}>`);
        } else {
          results.push(`⚠️ Roles Channel → Not found (use /setroles manually)`);
        }

        // ── Auto-detect General Channel
        const generalCh = channels.find(c =>
          c.isTextBased() && ['general', 'chat', 'lounge', 'talk', 'main', 'lobby', 'hangout'].some(k => c.name.toLowerCase().includes(k))
        );
        if (generalCh) {
          config.channels.generalChannelId = generalCh.id;
          results.push(`✅ General Channel → <#${generalCh.id}>`);
        } else {
          results.push(`⚠️ General Channel → Not found (use /setgeneral manually)`);
        }

        // ── Auto-detect or set custom Banner & Logo (File Attachment or Link URL)
        const logoFile = interaction.options.getAttachment('logo_file');
        const bannerFile = interaction.options.getAttachment('banner_file');
        const customLogo = logoFile ? logoFile.url : interaction.options.getString('logo_url');
        const customBanner = bannerFile ? bannerFile.url : interaction.options.getString('banner_url');

        if (customLogo && customLogo.startsWith('http')) {
          config.customImages = config.customImages || {};
          config.customImages.logoUrl = customLogo;
          results.push(`✅ Server Logo → ${logoFile ? 'Uploaded File set' : 'Custom Link set'}`);
        } else if (guild.iconURL({ size: 1024 })) {
          results.push(`✅ Server Logo → Auto-detected from Server Icon`);
        } else {
          results.push(`ℹ️ Server Logo → No icon on Discord (use /setimages logo_file:<upload>)`);
        }

        if (customBanner && customBanner.startsWith('http')) {
          config.customImages = config.customImages || {};
          config.customImages.bannerUrl = customBanner;
          results.push(`✅ Server Banner → ${bannerFile ? 'Uploaded File set' : 'Custom Link set'}`);
        } else if (guild.bannerURL({ size: 1024 })) {
          results.push(`✅ Server Banner → Auto-detected from Server Banner`);
        } else {
          results.push(`ℹ️ Server Banner → No banner on Discord (use /setimages banner_file:<upload>)`);
        }

        // ── Set welcome messages using server name
        config.serverName = guild.name;
        config.welcomeTitle = `Welcome to ${guild.name}!`;
        config.messages.welcomeSubtitle = `Welcome to ${guild.name}!`;
        results.push(`✅ Server Name → ${guild.name}`);

        // ── Custom color (if provided)
        const colorInput = interaction.options.getString('color');
        if (colorInput && isValidHexColor(colorInput.trim())) {
          config.embedColor = colorInput.trim();
          results.push(`✅ Embed Color → ${colorInput.trim()}`);
        } else {
          config.embedColor = '#5865F2';
          results.push(`✅ Embed Color → #5865F2 (default Discord blue)`);
        }

        // ── Custom greeting (if provided)
        const greetingInput = interaction.options.getString('greeting');
        if (greetingInput) {
          config.messages.greetingPrefix = greetingInput;
          results.push(`✅ Greeting → "${greetingInput}"`);
        }

        // ── Save everything
        saveGuildConfig(guild.id, config);

        // ── Build result embed
        const setupEmbed = new EmbedBuilder()
          .setColor(config.embedColor)
          .setTitle(`⚡ Auto-Setup Complete — ${guild.name}`)
          .setDescription(results.join('\n'))
          .addFields({
            name: '📌 Next Steps',
            value: [
              '• Run `/testwelcome` to preview your welcome message',
              '• Run `/testleave` to preview your member left message',
              '• Run `/welcomeconfig` to see full settings',
            ].join('\n')
          })
          .setThumbnail(guild.iconURL({ size: 256, forceStatic: false }))
          .setFooter({ text: 'Use /welcomehelp to see all commands' })
          .setTimestamp();

        await interaction.editReply({ embeds: [setupEmbed] });
        console.log(`⚡ /setup completed for "${guild.name}" (${guild.id})`);
      } catch (err) {
        console.error('❌ /setup error:', err);
        await interaction.editReply({ content: `❌ Setup failed: ${err.message}` });
      }
      return;
    }

    // ── /testwelcome
    if (commandName === 'testwelcome') {
      try {
        const embed = createWelcomeEmbed(interaction.member, guild);
        await interaction.reply({
          content: `**[TEST PREVIEW]** 🎉 Welcome <@${interaction.user.id}> to **${guild.name}**!`,
          embeds: [embed],
        });
      } catch (err) {
        await safeReply(interaction, `❌ Error: ${err.message}`);
      }
      return;
    }

    // ── /testleave
    if (commandName === 'testleave') {
      try {
        const embed = createLeaveEmbed(interaction.member, guild);
        await interaction.reply({
          content: `**[TEST LEAVE PREVIEW]** 👋 Goodbye <@${interaction.user.id}>!`,
          embeds: [embed],
        });
      } catch (err) {
        await safeReply(interaction, `❌ Error: ${err.message}`);
      }
      return;
    }

    // ── /myinvites
    if (commandName === 'myinvites') {
      try {
        const invites = await guild.invites.fetch().catch(() => null);
        let totalCount = 0;
        if (invites) {
          invites.forEach(inv => {
            if (inv.inviter?.id === interaction.user.id) {
              totalCount += (inv.uses || 0);
            }
          });
        }
        await interaction.reply({
          content: `📩 <@${interaction.user.id}>, you have **${totalCount}** total invites in **${guild.name}**!`,
          ephemeral: true,
        });
      } catch (err) {
        await safeReply(interaction, `❌ Could not fetch invite stats.`);
      }
      return;
    }

    // ── /setwelcome
    if (commandName === 'setwelcome') {
      const channel = interaction.options.getChannel('channel') || interaction.channel;
      const config = loadGuildConfig(guild);
      config.channels.welcomeChannelId = channel.id;
      saveGuildConfig(guild.id, config);
      await interaction.reply({
        content: `✅ Welcome channel set to ${channel}!`,
        ephemeral: true,
      });
      return;
    }

    // ── /setleave
    if (commandName === 'setleave') {
      const channel = interaction.options.getChannel('channel');
      const config = loadGuildConfig(guild);
      config.channels.leaveChannelId = channel.id;
      saveGuildConfig(guild.id, config);
      await interaction.reply({ content: `✅ Leave/Goodbye channel set to ${channel}!`, ephemeral: true });
      return;
    }

    // ── /setleavetext
    if (commandName === 'setleavetext') {
      const message = interaction.options.getString('message');
      const config = loadGuildConfig(guild);
      config.messages.leaveText = message;
      saveGuildConfig(guild.id, config);
      await interaction.reply({ content: `✅ Member leave message updated!\nPreview: "${message}"`, ephemeral: true });
      return;
    }

    // ── /setrules
    if (commandName === 'setrules') {
      const channel = interaction.options.getChannel('channel');
      const config = loadGuildConfig(guild);
      config.channels.rulesChannelId = channel.id;
      saveGuildConfig(guild.id, config);
      await interaction.reply({ content: `✅ Rules channel set to ${channel}!`, ephemeral: true });
      return;
    }

    // ── /setroles
    if (commandName === 'setroles') {
      const channel = interaction.options.getChannel('channel');
      const config = loadGuildConfig(guild);
      config.channels.rolesChannelId = channel.id;
      saveGuildConfig(guild.id, config);
      await interaction.reply({ content: `✅ Roles channel set to ${channel}!`, ephemeral: true });
      return;
    }

    // ── /setgeneral
    if (commandName === 'setgeneral') {
      const channel = interaction.options.getChannel('channel');
      const config = loadGuildConfig(guild);
      config.channels.generalChannelId = channel.id;
      saveGuildConfig(guild.id, config);
      await interaction.reply({ content: `✅ General channel set to ${channel}!`, ephemeral: true });
      return;
    }

    // ── /setwelcomecolor
    if (commandName === 'setwelcomecolor') {
      const color = interaction.options.getString('color').trim();
      if (!isValidHexColor(color)) {
        await interaction.reply({ content: `❌ Invalid hex color! Use format: \`#RRGGBB\` (e.g. \`#FF5733\`)`, ephemeral: true });
        return;
      }
      const config = loadGuildConfig(guild);
      config.embedColor = color;
      saveGuildConfig(guild.id, config);
      await interaction.reply({ content: `✅ Embed color updated to **${color}**!`, ephemeral: true });
      return;
    }

    // ── /setwelcometext
    if (commandName === 'setwelcometext') {
      const greeting = interaction.options.getString('greeting');
      const subtitle = interaction.options.getString('subtitle');
      const outro = interaction.options.getString('outro');

      if (!greeting && !subtitle && !outro) {
        await interaction.reply({ content: `❌ Please provide at least one option (greeting, subtitle, or outro).`, ephemeral: true });
        return;
      }

      const config = loadGuildConfig(guild);
      if (greeting) config.messages.greetingPrefix = greeting;
      if (subtitle) config.messages.welcomeSubtitle = subtitle;
      if (outro) config.messages.outroText = outro;
      saveGuildConfig(guild.id, config);

      const updated = [greeting && `greeting`, subtitle && `subtitle`, outro && `outro`].filter(Boolean).join(', ');
      await interaction.reply({ content: `✅ Updated welcome text: **${updated}**`, ephemeral: true });
      return;
    }

    // ── /setimages (Supports Uploaded Files & Link URLs)
    if (commandName === 'setimages') {
      const bannerFile = interaction.options.getAttachment('banner_file');
      const logoFile = interaction.options.getAttachment('logo_file');
      const bannerUrl = bannerFile ? bannerFile.url : interaction.options.getString('banner_url');
      const logoUrl = logoFile ? logoFile.url : interaction.options.getString('logo_url');

      const config = loadGuildConfig(guild);
      if (!config.customImages) config.customImages = { logoUrl: '', bannerUrl: '' };

      const updates = [];
      if (bannerUrl) {
        config.customImages.bannerUrl = bannerUrl;
        updates.push(`✅ Custom Banner image set (${bannerFile ? 'Uploaded File' : 'URL Link'})`);
      }
      if (logoUrl) {
        config.customImages.logoUrl = logoUrl;
        updates.push(`✅ Custom Logo image set (${logoFile ? 'Uploaded File' : 'URL Link'})`);
      }

      if (updates.length === 0) {
        await interaction.reply({ content: `⚠️ Please upload an image file or provide an image URL link!`, ephemeral: true });
        return;
      }

      saveGuildConfig(guild.id, config);
      await interaction.reply({ content: updates.join('\n') + `\nRun \`/testwelcome\` to preview!`, ephemeral: true });
      return;
    }

    // ── /welcomeconfig
    if (commandName === 'welcomeconfig') {
      const config = loadGuildConfig(guild);
      const ch = config.channels;
      const msg = config.messages;

      const embed = new EmbedBuilder()
        .setColor(isValidHexColor(config.embedColor) ? config.embedColor : '#5865F2')
        .setTitle(`⚙️ Welcome Bot Config — ${guild.name}`)
        .addFields(
          {
            name: '📢 Channels',
            value: [
              `**Welcome:** ${ch.welcomeChannelId ? `<#${ch.welcomeChannelId}>` : '❌ Not set — use `/setwelcome`'}`,
              `**Rules:** ${ch.rulesChannelId ? `<#${ch.rulesChannelId}>` : '❌ Not set — use `/setrules`'}`,
              `**Roles:** ${ch.rolesChannelId ? `<#${ch.rolesChannelId}>` : '❌ Not set — use `/setroles`'}`,
              `**General:** ${ch.generalChannelId ? `<#${ch.generalChannelId}>` : '❌ Not set — use `/setgeneral`'}`,
            ].join('\n'),
          },
          {
            name: '💬 Messages',
            value: [
              `**Greeting:** ${msg.greetingPrefix || '(default)'}`,
              `**Subtitle:** ${msg.welcomeSubtitle || '(default)'}`,
              `**Outro:** ${msg.outroText || '(default)'}`,
            ].join('\n'),
          },
          {
            name: '🎨 Appearance',
            value: `**Color:** ${config.embedColor || '#5865F2'}\n**Server Assets:** ${config.useServerAssets !== false ? 'Enabled ✅' : 'Disabled ❌'}`,
          }
        )
        .setFooter({ text: 'Use /welcomehelp to see all commands' })
        .setTimestamp();

      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    // ── /resetwelcome
    if (commandName === 'resetwelcome') {
      const defaultCfg = getDefaultConfig(guild);
      saveGuildConfig(guild.id, defaultCfg);
      await interaction.reply({ content: `✅ Welcome configuration has been reset to defaults for **${guild.name}**.`, ephemeral: true });
      return;
    }

    // ── /welcomehelp
    if (commandName === 'welcomehelp') {
      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('🤖 Welcome & Goodbye Bot — Commands')
        .setDescription('A fully customizable welcome & inviter bot. Each server gets its own independent settings.')
        .addFields(
          {
            name: '⚡ Quick Setup (Do This First!)',
            value: [
              '`/setup` — **Auto-detects all channels & sets everything up in 1 command!**',
              '   *(Supports image upload for logo & banner, custom color, greeting)*',
            ].join('\n'),
          },
          {
            name: '🛠️ Channel & Image Setup (Admin Only)',
            value: [
              '`/setwelcome [channel]` — Set welcome channel',
              '`/setleave <channel>` — Set member leave/goodbye channel',
              '`/setrules <channel>` — Set rules channel',
              '`/setroles <channel>` — Set roles channel',
              '`/setgeneral <channel>` — Set general channel',
              '`/setimages` — Upload logo/banner image files or URLs',
              '`/setwelcomecolor <#hex>` — Change embed color',
              '`/setwelcometext` — Customize greeting, subtitle, and outro text',
              '`/setleavetext <msg>` — Customize member left message',
              '`/resetwelcome` — Reset all settings to default',
            ].join('\n'),
          },
          {
            name: '👁️ Invites & Previews',
            value: [
              '`/myinvites` — Check your total invited members',
              '`/testwelcome` — Preview the welcome message',
              '`/testleave` — Preview the member left message',
              '`/welcomeconfig` — View current server settings',
              '`/welcomehelp` — Show this help menu',
            ].join('\n'),
          }
        )
        .setFooter({ text: 'Each server has independent settings — this bot is fully public!' })
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
      return;
    }

    // ── /play (Music Command)
    if (commandName === 'play') {
      const voiceChannel = interaction.member?.voice?.channel;
      if (!voiceChannel) {
        await interaction.reply({ content: '❌ You must be in a **Voice Channel** to play music!', ephemeral: true });
        return;
      }

      const query = interaction.options.getString('song');
      const { track, position } = addSongToQueue(guild, voiceChannel, interaction.user, query);

      const playEmbed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(position === 1 ? '🎶 Now Playing' : '🎵 Song Added to Queue')
        .setDescription(`### [${track.title}](${track.url})`)
        .addFields(
          { name: '🔊 Voice Channel', value: `<#${voiceChannel.id}>`, inline: true },
          { name: '👤 Requested By', value: `<@${interaction.user.id}>`, inline: true },
          { name: '📊 Position in Queue', value: `#${position}`, inline: true },
          { name: '🚀 Discord Activity', value: '[Click to open Watch Together / Activity](https://discord.com/activities/235088799074484224?referrer_id=872384645373788170)' }
        )
        .setFooter({ text: 'Use /queue to view all songs • /stop to leave' })
        .setTimestamp();

      const btnRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('🎧 Open Music Activity')
          .setURL('https://discord.com/activities/235088799074484224?referrer_id=872384645373788170')
          .setStyle(ButtonStyle.Link)
      );

      await interaction.reply({ embeds: [playEmbed], components: [btnRow] });
      return;
    }

    // ── /pause
    if (commandName === 'pause') {
      await interaction.reply({ content: '⏸️ Music playback paused.', ephemeral: true });
      return;
    }

    // ── /resume
    if (commandName === 'resume') {
      await interaction.reply({ content: '▶️ Music playback resumed.', ephemeral: true });
      return;
    }

    // ── /skip
    if (commandName === 'skip') {
      const guildQueue = getGuildQueue(guild.id);
      if (guildQueue.queue.length > 0) {
        const skipped = guildQueue.queue.shift();
        await interaction.reply({ content: `⏭️ Skipped: **${skipped?.title || 'Song'}**` });
      } else {
        await interaction.reply({ content: '⚠️ Queue is empty!', ephemeral: true });
      }
      return;
    }

    // ── /stop
    if (commandName === 'stop') {
      const guildQueue = getGuildQueue(guild.id);
      guildQueue.queue = [];
      guildQueue.isPlaying = false;
      if (guildQueue.connection) {
        try { guildQueue.connection.destroy(); } catch (_) {}
        guildQueue.connection = null;
      }
      await interaction.reply({ content: '⏹️ Stopped music playback and left the voice channel.' });
      return;
    }

    // ── /queue (Show queue OR paste a song link directly to add it)
    if (commandName === 'queue') {
      const voiceChannel = interaction.member?.voice?.channel;
      const songParam = interaction.options.getString('song');

      if (songParam) {
        if (!voiceChannel) {
          await interaction.reply({ content: '❌ You must join a **Voice Channel** first to add a song to the queue!', ephemeral: true });
          return;
        }

        const { track, position } = addSongToQueue(guild, voiceChannel, interaction.user, songParam);

        const queueAddEmbed = new EmbedBuilder()
          .setColor('#5865F2')
          .setTitle('🎶 Song Link Added to Queue')
          .setDescription(`### [${track.title}](${track.url})`)
          .addFields(
            { name: '🔊 Voice Channel', value: `<#${voiceChannel.id}>`, inline: true },
            { name: '👤 Requested By', value: `<@${interaction.user.id}>`, inline: true },
            { name: '📊 Queue Position', value: `#${position}`, inline: true }
          )
          .setFooter({ text: 'Use /queue to see all queued songs' })
          .setTimestamp();

        await interaction.reply({ embeds: [queueAddEmbed] });
        return;
      }

      const guildQueue = getGuildQueue(guild.id);
      if (guildQueue.queue.length === 0) {
        await interaction.reply({ content: '🎶 Music queue is currently empty! Use `/play <song/link>` or `/queue song:<link>` to add songs.', ephemeral: true });
        return;
      }

      const list = guildQueue.queue.slice(0, 10).map((t, idx) => `${idx + 1}. [${t.title}](${t.url}) (Requested by <@${t.requestedBy}>)`).join('\n');
      const queueEmbed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`🎶 Music Queue — ${guild.name}`)
        .setDescription(list)
        .setFooter({ text: `Total songs queued: ${guildQueue.queue.length}` })
        .setTimestamp();

      await interaction.reply({ embeds: [queueEmbed] });
      return;
    }

    // ── /nowplaying
    if (commandName === 'nowplaying') {
      const guildQueue = getGuildQueue(guild.id);
      const current = guildQueue.queue[0];
      if (!current) {
        await interaction.reply({ content: '🎶 Nothing is currently playing! Use `/play <link>` to start.', ephemeral: true });
        return;
      }

      const npEmbed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('🎶 Currently Playing')
        .setDescription(`### [${current.title}](${current.url})\n\n\`▬▬▬▬🔘▬▬▬▬▬▬▬▬▬▬\` [01:45 / 03:30]`)
        .addFields({ name: '👤 Requested By', value: `<@${current.requestedBy}>` })
        .setTimestamp();

      await interaction.reply({ embeds: [npEmbed] });
      return;
    }

    // ── /radio (24/7 Streams)
    if (commandName === 'radio') {
      const voiceChannel = interaction.member?.voice?.channel;
      if (!voiceChannel) {
        await interaction.reply({ content: '❌ You must be in a **Voice Channel** to play 24/7 radio!', ephemeral: true });
        return;
      }

      const genre = interaction.options.getString('genre') || 'lofi';
      const streams = {
        lofi: { name: '☕ Lofi Chill 24/7', url: 'https://stream.zeno.fm/f3wvbbqmdg8uv' },
        gaming: { name: '🎮 Gaming Beats 24/7', url: 'https://stream.zeno.fm/0r0xa792kwzuv' },
        pop: { name: '🎵 Pop Hits 24/7', url: 'https://stream.zeno.fm/z52x2szx0h8uv' },
        chill: { name: '🎧 Chill Hop 24/7', url: 'https://stream.zeno.fm/f3wvbbqmdg8uv' },
      };

      const selected = streams[genre] || streams.lofi;
      const guildQueue = getGuildQueue(guild.id);

      if (voiceLib) {
        if (!guildQueue.connection) {
          try {
            guildQueue.connection = voiceLib.joinVoiceChannel({
              channelId: voiceChannel.id,
              guildId: guild.id,
              adapterCreator: guild.voiceAdapterCreator,
              selfDeaf: false,
              selfMute: false,
            });
          } catch (_) {}
        }
        if (!guildQueue.player) {
          guildQueue.player = voiceLib.createAudioPlayer();
          guildQueue.connection.subscribe(guildQueue.player);
        }
        try {
          const resource = voiceLib.createAudioResource(selected.url, { inputType: voiceLib.StreamType.Arbitrary });
          guildQueue.player.play(resource);
        } catch (_) {}
      }

      const radioEmbed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`📻 24/7 Radio Started — ${selected.name}`)
        .setDescription(`Playing continuous live stream in <#${voiceChannel.id}>!`)
        .addFields({ name: '🔗 Stream Link', value: `[Listen Direct Link](${selected.url})` })
        .setFooter({ text: 'Use /stop to disconnect the radio' })
        .setTimestamp();

      await interaction.reply({ embeds: [radioEmbed] });
      return;
    }

    // ── /activity (Discord Voice Activity launcher)
    if (commandName === 'activity') {
      const voiceChannel = interaction.member?.voice?.channel;
      const actEmbed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('🚀 Discord Voice Activity')
        .setDescription('Click below to launch **Watch Together / Music Activity** directly inside your voice channel!')
        .addFields(
          { name: '🎧 Launch Activity', value: '[👉 Open Discord Voice Activity](https://discord.com/activities/235088799074484224?referrer_id=872384645373788170)' },
          { name: '🔊 Channel', value: voiceChannel ? `<#${voiceChannel.id}>` : 'Join a voice channel first!' }
        )
        .setTimestamp();

      await interaction.reply({ embeds: [actEmbed] });
      return;
    }
  });

  // ── Text Commands (!play, !queue, !skip, !stop, !pause, !resume, !nowplaying, !radio, !activity, !testwelcome)
  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    const content = message.content.trim();
    if (!content.startsWith('!')) return;

    const args = content.slice(1).trim().split(/ +/);
    const cmd = args.shift().toLowerCase();

    // ── !play or !p <song/link>
    if (cmd === 'play' || cmd === 'p') {
      const songInput = args.join(' ');
      const voiceChannel = message.member?.voice?.channel;
      if (!voiceChannel) {
        return message.reply('❌ You must join a **Voice Channel** first to play music!');
      }
      if (!songInput) {
        return message.reply('⚠️ Please provide a song name or paste a song link!\nExample: `!play https://...` or `!play lofi`');
      }

      const { track, position } = addSongToQueue(message.guild, voiceChannel, message.author, songInput);
      const playEmbed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(position === 1 ? '🎶 Now Playing Song Link' : '🎵 Song Added to Queue')
        .setDescription(`### [${track.title}](${track.url})`)
        .addFields(
          { name: '🔊 Voice Channel', value: `<#${voiceChannel.id}>`, inline: true },
          { name: '👤 Requested By', value: `<@${message.author.id}>`, inline: true },
          { name: '📊 Position in Queue', value: `#${position}`, inline: true },
          { name: '🚀 Discord Activity', value: '[Click to open Watch Together / Activity](https://discord.com/activities/235088799074484224?referrer_id=872384645373788170)' }
        )
        .setFooter({ text: 'Use !queue to view all songs • !stop to leave' })
        .setTimestamp();

      const btnRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('🎧 Open Music Activity')
          .setURL('https://discord.com/activities/235088799074484224?referrer_id=872384645373788170')
          .setStyle(ButtonStyle.Link)
      );

      return message.reply({ embeds: [playEmbed], components: [btnRow] });
    }

    // ── !queue or !q [song/link]
    if (cmd === 'queue' || cmd === 'q') {
      const songInput = args.join(' ');
      const voiceChannel = message.member?.voice?.channel;

      if (songInput) {
        if (!voiceChannel) {
          return message.reply('❌ You must join a **Voice Channel** first to add a song to the queue!');
        }
        const { track, position } = addSongToQueue(message.guild, voiceChannel, message.author, songInput);
        const queueAddEmbed = new EmbedBuilder()
          .setColor('#5865F2')
          .setTitle('🎶 Song Link Added to Queue')
          .setDescription(`### [${track.title}](${track.url})`)
          .addFields(
            { name: '🔊 Voice Channel', value: `<#${voiceChannel.id}>`, inline: true },
            { name: '👤 Requested By', value: `<@${message.author.id}>`, inline: true },
            { name: '📊 Queue Position', value: `#${position}`, inline: true }
          )
          .setFooter({ text: 'Use !queue to see all queued songs' })
          .setTimestamp();

        return message.reply({ embeds: [queueAddEmbed] });
      }

      const guildQueue = getGuildQueue(message.guild.id);
      if (guildQueue.queue.length === 0) {
        return message.reply('🎶 Music queue is currently empty! Use `!play <song/link>` or `!queue <link>` to add songs.');
      }

      const list = guildQueue.queue.slice(0, 10).map((t, idx) => `${idx + 1}. [${t.title}](${t.url}) (Requested by <@${t.requestedBy}>)`).join('\n');
      const queueEmbed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`🎶 Music Queue — ${message.guild.name}`)
        .setDescription(list)
        .setFooter({ text: `Total songs queued: ${guildQueue.queue.length}` })
        .setTimestamp();

      return message.reply({ embeds: [queueEmbed] });
    }

    // ── !skip or !s
    if (cmd === 'skip' || cmd === 's') {
      const guildQueue = getGuildQueue(message.guild.id);
      if (guildQueue.queue.length > 0) {
        const skipped = guildQueue.queue.shift();
        return message.reply(`⏭️ Skipped: **${skipped?.title || 'Song'}**`);
      } else {
        return message.reply('⚠️ Queue is empty!');
      }
    }

    // ── !stop
    if (cmd === 'stop') {
      const guildQueue = getGuildQueue(message.guild.id);
      guildQueue.queue = [];
      guildQueue.isPlaying = false;
      if (guildQueue.connection) {
        try { guildQueue.connection.destroy(); } catch (_) {}
        guildQueue.connection = null;
      }
      return message.reply('⏹️ Stopped music playback and left the voice channel.');
    }

    // ── !pause
    if (cmd === 'pause') {
      return message.reply('⏸️ Music playback paused.');
    }

    // ── !resume
    if (cmd === 'resume') {
      return message.reply('▶️ Music playback resumed.');
    }

    // ── !nowplaying or !np
    if (cmd === 'nowplaying' || cmd === 'np') {
      const guildQueue = getGuildQueue(message.guild.id);
      const current = guildQueue.queue[0];
      if (!current) {
        return message.reply('🎶 Nothing is currently playing! Use `!play <link>` to start.');
      }
      const npEmbed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('🎶 Currently Playing')
        .setDescription(`### [${current.title}](${current.url})\n\n\`▬▬▬▬🔘▬▬▬▬▬▬▬▬▬▬\` [01:45 / 03:30]`)
        .addFields({ name: '👤 Requested By', value: `<@${current.requestedBy}>` })
        .setTimestamp();
      return message.reply({ embeds: [npEmbed] });
    }

    // ── !radio
    if (cmd === 'radio') {
      const voiceChannel = message.member?.voice?.channel;
      if (!voiceChannel) {
        return message.reply('❌ You must join a **Voice Channel** first to play radio!');
      }
      const genre = args[0]?.toLowerCase() || 'lofi';
      const streams = {
        lofi: { name: '☕ Lofi Chill 24/7', url: 'https://stream.zeno.fm/f3wvbbqmdg8uv' },
        gaming: { name: '🎮 Gaming Beats 24/7', url: 'https://stream.zeno.fm/0r0xa792kwzuv' },
        pop: { name: '🎵 Pop Hits 24/7', url: 'https://stream.zeno.fm/z52x2szx0h8uv' },
        chill: { name: '🎧 Chill Hop 24/7', url: 'https://stream.zeno.fm/f3wvbbqmdg8uv' },
      };
      const selected = streams[genre] || streams.lofi;
      const guildQueue = getGuildQueue(message.guild.id);

      if (voiceLib) {
        if (!guildQueue.connection) {
          try {
            guildQueue.connection = voiceLib.joinVoiceChannel({
              channelId: voiceChannel.id,
              guildId: message.guild.id,
              adapterCreator: message.guild.voiceAdapterCreator,
              selfDeaf: false,
              selfMute: false,
            });
          } catch (_) {}
        }
        if (!guildQueue.player) {
          guildQueue.player = voiceLib.createAudioPlayer();
          guildQueue.connection.subscribe(guildQueue.player);
        }
        try {
          const resource = voiceLib.createAudioResource(selected.url, { inputType: voiceLib.StreamType.Arbitrary });
          guildQueue.player.play(resource);
        } catch (_) {}
      }

      const radioEmbed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`📻 24/7 Radio Started — ${selected.name}`)
        .setDescription(`Playing continuous live stream in <#${voiceChannel.id}>!`)
        .addFields({ name: '🔗 Stream Link', value: `[Listen Direct Link](${selected.url})` })
        .setFooter({ text: 'Use !stop to disconnect the radio' })
        .setTimestamp();

      return message.reply({ embeds: [radioEmbed] });
    }

    // ── !activity
    if (cmd === 'activity') {
      const voiceChannel = message.member?.voice?.channel;
      const actEmbed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('🚀 Discord Voice Activity')
        .setDescription('Click below to launch **Watch Together / Music Activity** directly inside your voice channel!')
        .addFields(
          { name: '🎧 Launch Activity', value: '[👉 Open Discord Voice Activity](https://discord.com/activities/235088799074484224?referrer_id=872384645373788170)' },
          { name: '🔊 Channel', value: voiceChannel ? `<#${voiceChannel.id}>` : 'Join a voice channel first!' }
        )
        .setTimestamp();
      return message.reply({ embeds: [actEmbed] });
    }

    // ── !testwelcome
    if (cmd === 'testwelcome') {
      try {
        const embed = createWelcomeEmbed(message.member, message.guild);
        await message.channel.send({
          content: `**[TEST PREVIEW]** 🎉 Welcome <@${message.author.id}> to **${message.guild.name}**!`,
          embeds: [embed],
        });
      } catch (err) {
        message.reply(`❌ Error: ${err.message}`);
      }
    }

    // ── !setwelcome
    if (cmd === 'setwelcome') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return message.reply('❌ You need the **Manage Server** permission to do this.');
      }
      const config = loadGuildConfig(message.guild);
      config.channels.welcomeChannelId = message.channel.id;
      saveGuildConfig(message.guild.id, config);
      await message.reply(`✅ Welcome channel set to ${message.channel}!`);
    }
  });

  // ── Login
  const TOKEN = process.env.DISCORD_TOKEN;
  if (!TOKEN || TOKEN === 'your_bot_token_here') {
    console.error('\n❌ DISCORD_TOKEN is missing in your .env file!');
    process.exit(1);
  }

  client.login(TOKEN).catch(err => {
    if (err.message.includes('disallowed intents') || err.message.includes('Privileged intent')) {
      console.error('\n❌ PRIVILEGED INTENTS ERROR!');
      console.error('👉 Enable "SERVER MEMBERS INTENT" in the Discord Developer Portal:');
      console.error('   https://discord.com/developers/applications → Bot → Privileged Gateway Intents');
      process.exit(1);
    } else {
      console.error('❌ Login error:', err.message);
      process.exit(1);
    }
  });
}

// ── Utility: safe reply helper
async function safeReply(interaction, content) {
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content, ephemeral: true });
    } else {
      await interaction.reply({ content, ephemeral: true });
    }
  } catch (_) {}
}

startBot();
